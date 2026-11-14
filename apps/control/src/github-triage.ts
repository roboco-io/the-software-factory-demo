import {
  createInstallationToken,
  field,
  githubRequest,
  str,
  type PublisherConfig,
} from "./github-publisher";
import { isValidRepo } from "./repo";
import type { PolicyFile, TriageGitHub } from "./triage-service";

const GUEST_POLICY_PATH = ".factory/guest-policy.yml";
const encodePath = (ref: string) =>
  ref.split("/").map(encodeURIComponent).join("/");

/**
 * The GitHub calls of guest triage, with the GitHub App. Each token is limited to one
 * repository, with read access to its contents and write access to its issues.
 */
export function createTriageGitHub(config: PublisherConfig): TriageGitHub {
  const doFetch = config.fetch ?? fetch;
  const tokens = new Map<string, string>();

  async function token(repo: string): Promise<string> {
    if (!isValidRepo(repo)) throw new Error("invalid repository");
    const cached = tokens.get(repo);
    if (cached !== undefined) return cached;
    const { token: created } = await createInstallationToken(config, repo, {
      contents: "read",
      issues: "write",
    });
    if (created === undefined) throw new Error("unexpected GitHub response");
    // One triage takes seconds; a token lives an hour.
    tokens.set(repo, created);
    return created;
  }

  const call = async (
    repo: string,
    method: string,
    route: string,
    options: { body?: unknown; accept?: number[]; mediaType?: string } = {},
  ) => githubRequest(doFetch, await token(repo), method, route, options);

  return {
    async readGuestPolicy(repo): Promise<PolicyFile> {
      const info = await call(repo, "GET", `/repos/${repo}`);
      const branch = str(info.data, "default_branch");
      // Pin the default branch tip, so the file is read at one commit of that branch.
      const ref = await call(
        repo,
        "GET",
        `/repos/${repo}/git/ref/heads/${encodePath(branch)}`,
      );
      const tip = str(ref.data, "object", "sha");
      const r = await call(
        repo,
        "GET",
        `/repos/${repo}/contents/${GUEST_POLICY_PATH}?ref=${tip}`,
        { mediaType: "application/vnd.github.raw+json", accept: [404] },
      );
      return r.status === 404
        ? { kind: "missing" }
        : { kind: "ok", text: r.text };
    },

    async userCreatedAt(userId): Promise<number | null> {
      // The account's public profile, by numeric id. No repository is involved; any
      // installation token may read it, so the first cached one is used.
      const any = tokens.values().next().value;
      if (any === undefined || !Number.isSafeInteger(userId) || userId < 1)
        return null;
      const r = await githubRequest(doFetch, any, "GET", `/user/${userId}`, {
        accept: [404],
      });
      const createdAt = field(r.data, "created_at");
      if (r.status !== 200 || field(r.data, "id") !== userId) return null;
      const ms = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
      return Number.isFinite(ms) ? ms : null;
    },

    async addLabel(repo, issueNumber, label) {
      await call(repo, "POST", `/repos/${repo}/issues/${issueNumber}/labels`, {
        body: { labels: [label] },
      });
    },

    async comment(repo, issueNumber, body) {
      await call(
        repo,
        "POST",
        `/repos/${repo}/issues/${issueNumber}/comments`,
        { body: { body } },
      );
    },

    async closeNotPlanned(repo, issueNumber) {
      await call(repo, "PATCH", `/repos/${repo}/issues/${issueNumber}`, {
        body: { state: "closed", state_reason: "not_planned" },
      });
    },
  };
}
