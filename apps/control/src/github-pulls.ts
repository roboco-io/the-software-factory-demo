import type { CheckRun, ReviewEntry } from "./decision";
import {
  GitHubError,
  createInstallationToken,
  field,
  githubRequest,
  str,
  type PublisherConfig,
} from "./github-publisher";
import {
  ChecksPermissionMissing,
  type ChangedFileInfo,
  type MergeResult,
  type PolicyFile,
  type PullRequestInfo,
  type PullRequestPort,
} from "./pull-port";

const PER_PAGE = 100;
/** GitHub lists at most 3000 files of a pull request. */
export const MAX_FILES_PAGES = 30;
const MAX_CHECK_PAGES = 20;
const MAX_REVIEW_PAGES = 30;
const POLICY_PATH = ".factory/policy.yml";
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const idOf = (v: unknown): string =>
  typeof v === "number" || typeof v === "string" ? String(v) : "";
const encodePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

/**
 * The GitHub side of review and merge. It uses the same App credentials and request
 * helper as the publisher. Tokens are cached per repository until shortly before they expire.
 */
export function createPullClient(config: PublisherConfig): PullRequestPort {
  const doFetch = config.fetch ?? fetch;
  const nowMs = () =>
    (config.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))() * 1000;
  const tokens = new Map<string, { token: string; expiresAt: number }>();

  async function token(repo: string): Promise<string> {
    const cached = tokens.get(repo);
    if (cached !== undefined && cached.expiresAt - TOKEN_MARGIN_MS > nowMs())
      return cached.token;
    // Ask for the Checks read permission too. An installation that has not been
    // granted it answers 422; then ask without it and let the check-runs call report 403.
    let result = await createInstallationToken(
      config,
      repo,
      { contents: "write", pull_requests: "write", checks: "read" },
      [422],
    );
    if (result.token === undefined) {
      result = await createInstallationToken(config, repo, {
        contents: "write",
        pull_requests: "write",
      });
    }
    if (result.token === undefined)
      throw new Error("unexpected GitHub response");
    tokens.set(repo, {
      token: result.token,
      expiresAt: result.expiresAt ?? nowMs() + 30 * 60 * 1000,
    });
    return result.token;
  }

  async function get(
    repo: string,
    route: string,
    options: { mediaType?: string; accept?: number[] } = {},
  ) {
    return githubRequest(doFetch, await token(repo), "GET", route, options);
  }

  return {
    async getPullRequest(repo, prNumber): Promise<PullRequestInfo> {
      const r = await get(repo, `/repos/${repo}/pulls/${prNumber}`);
      const state = field(r.data, "state");
      const headSha = str(r.data, "head", "sha");
      const baseRef = str(r.data, "base", "ref");
      const defaultBranch = str(r.data, "base", "repo", "default_branch");
      const changed = field(r.data, "changed_files");
      const authorId = field(r.data, "user", "id");
      return {
        state: state === "open" ? "open" : "closed",
        merged: field(r.data, "merged") === true,
        headSha,
        baseRef,
        defaultBranch,
        authorId: typeof authorId === "number" ? String(authorId) : null,
        changedFiles: typeof changed === "number" ? changed : -1,
      };
    },

    async listFiles(repo, prNumber, expectedCount) {
      const files: ChangedFileInfo[] = [];
      let truncated =
        expectedCount < 0 || expectedCount > MAX_FILES_PAGES * PER_PAGE;
      for (let page = 1; page <= MAX_FILES_PAGES && !truncated; page++) {
        const r = await get(
          repo,
          `/repos/${repo}/pulls/${prNumber}/files?per_page=${PER_PAGE}&page=${page}`,
        );
        const items = asArray(r.data);
        for (const item of items) {
          const filename = text(field(item, "filename"));
          if (filename === "") return { files, truncated: true };
          const previous = text(field(item, "previous_filename"));
          files.push({
            filename,
            ...(previous === "" ? {} : { previousFilename: previous }),
          });
        }
        if (items.length < PER_PAGE) break;
        if (page === MAX_FILES_PAGES) truncated = true;
      }
      // The list must match the count GitHub reports, or something was cut off.
      return { files, truncated: truncated || files.length !== expectedCount };
    },

    async readPolicy(repo, defaultBranch): Promise<PolicyFile> {
      // Pin the default branch tip first, so the file is read at one commit that is not the pull request head.
      const ref = await get(
        repo,
        `/repos/${repo}/git/ref/heads/${encodePath(defaultBranch)}`,
      );
      const tip = str(ref.data, "object", "sha");
      const r = await get(
        repo,
        `/repos/${repo}/contents/${POLICY_PATH}?ref=${tip}`,
        { mediaType: "application/vnd.github.raw+json", accept: [404] },
      );
      return r.status === 404
        ? { kind: "missing" }
        : { kind: "ok", text: r.text };
    },

    async getDiff(repo, baseSha, headSha) {
      const r = await get(
        repo,
        `/repos/${repo}/compare/${baseSha}...${headSha}`,
        {
          mediaType: "application/vnd.github.diff",
        },
      );
      return r.text;
    },

    async listChecks(repo, sha): Promise<CheckRun[]> {
      const runs: CheckRun[] = [];
      let total = Infinity;
      for (
        let page = 1;
        page <= MAX_CHECK_PAGES && runs.length < total;
        page++
      ) {
        const route = `/repos/${repo}/commits/${sha}/check-runs?per_page=${PER_PAGE}&page=${page}`;
        const r = await get(repo, route, { accept: [403] });
        if (r.status === 403) {
          // A rate limit is also a 403: that one is temporary and must not read as a missing permission.
          if (
            r.headers.get("x-ratelimit-remaining") === "0" ||
            r.headers.has("retry-after")
          )
            throw new GitHubError("GET", route.split("?")[0] as string, 403);
          throw new ChecksPermissionMissing();
        }
        const count = field(r.data, "total_count");
        total = typeof count === "number" ? count : 0;
        const items = asArray(field(r.data, "check_runs"));
        for (const item of items) {
          const status = field(item, "status");
          const conclusion = field(item, "conclusion");
          runs.push({
            name: text(field(item, "name")),
            status: typeof status === "string" ? status : "",
            conclusion: typeof conclusion === "string" ? conclusion : null,
            appId: ((id) => (typeof id === "number" ? id : null))(
              field(item, "app", "id"),
            ),
          });
        }
        if (items.length === 0) break;
      }
      if (runs.length < total) throw new Error("check runs are incomplete");
      return runs;
    },

    async listReviews(repo, prNumber): Promise<ReviewEntry[]> {
      const reviews: ReviewEntry[] = [];
      for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
        const r = await get(
          repo,
          `/repos/${repo}/pulls/${prNumber}/reviews?per_page=${PER_PAGE}&page=${page}`,
        );
        const items = asArray(r.data);
        for (const item of items) {
          const commit = field(item, "commit_id");
          reviews.push({
            userId: idOf(field(item, "user", "id")),
            userType: text(field(item, "user", "type")),
            state: text(field(item, "state")).toUpperCase(),
            commitId: typeof commit === "string" ? commit : null,
          });
        }
        if (items.length < PER_PAGE) return reviews;
      }
      throw new Error("reviews are incomplete");
    },

    async postReview(repo, prNumber, headSha, body) {
      await githubRequest(
        doFetch,
        await token(repo),
        "POST",
        `/repos/${repo}/pulls/${prNumber}/reviews`,
        { body: { commit_id: headSha, event: "COMMENT", body } },
      );
    },

    async merge(repo, prNumber, headSha, message): Promise<MergeResult> {
      const r = await githubRequest(
        doFetch,
        await token(repo),
        "PUT",
        `/repos/${repo}/pulls/${prNumber}/merge`,
        {
          body: {
            merge_method: "squash",
            sha: headSha,
            commit_title: message.title,
            commit_message: message.body,
          },
          accept: [405, 409],
        },
      );
      if (r.status === 405) return "refused";
      if (r.status === 409) return "conflict";
      return field(r.data, "merged") === true ? "merged" : "refused";
    },
  };
}
