import type { DependabotPr, OpenAlert, PrCommit } from "./dependabot";
import type { DependabotGitHub } from "./dependabot-sweep";
import {
  createInstallationToken,
  field,
  githubRequest,
  type PublisherConfig,
} from "./github-publisher";
import { isValidRepo } from "./repo";

const PER_PAGE = 100;
const MAX_PR_PAGES = 5;

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : NaN);

/**
 * The GitHub calls of the daily Dependabot pass that the pull request client does not
 * have. Each token is limited to one repository. Reading alerts needs the App's
 * "Dependabot alerts: read" permission; without it `listOpenAlerts` answers null.
 */
export function createDependabotGitHub(
  config: PublisherConfig,
): DependabotGitHub {
  const doFetch = config.fetch ?? fetch;
  const tokens = new Map<string, { token: string; alerts: boolean }>();

  async function access(repo: string) {
    if (!isValidRepo(repo)) throw new Error("invalid repository");
    const cached = tokens.get(repo);
    if (cached !== undefined) return cached;
    const base = { pull_requests: "write", issues: "write" };
    // An installation that was not granted the alerts permission answers 422.
    let created = await createInstallationToken(
      config,
      repo,
      { ...base, vulnerability_alerts: "read" },
      [422],
    );
    const alerts = created.token !== undefined;
    if (!alerts) created = await createInstallationToken(config, repo, base);
    if (created.token === undefined)
      throw new Error("unexpected GitHub response");
    // One pass takes seconds; a token lives an hour.
    const entry = { token: created.token, alerts };
    tokens.set(repo, entry);
    return entry;
  }

  const call = async (
    repo: string,
    method: string,
    route: string,
    options: { body?: unknown; accept?: number[] } = {},
  ) =>
    githubRequest(doFetch, (await access(repo)).token, method, route, options);

  return {
    async listOpenPrs(repo): Promise<DependabotPr[]> {
      const prs: DependabotPr[] = [];
      for (let page = 1; page <= MAX_PR_PAGES; page++) {
        const r = await call(
          repo,
          "GET",
          `/repos/${repo}/pulls?state=open&per_page=${PER_PAGE}&page=${page}`,
        );
        const items = asArray(r.data);
        for (const item of items) {
          const number = num(field(item, "number"));
          const headSha = text(field(item, "head", "sha"));
          if (!Number.isSafeInteger(number) || headSha === "")
            throw new Error("unexpected GitHub response");
          prs.push({
            number,
            title: text(field(item, "title")),
            author: {
              id: num(field(item, "user", "id")),
              login: text(field(item, "user", "login")),
              type: text(field(item, "user", "type")),
            },
            // Anything but an explicit false counts as a draft.
            draft: field(item, "draft") !== false,
            headSha,
            sameRepo:
              text(field(item, "head", "repo", "full_name")).toLowerCase() ===
              repo.toLowerCase(),
            baseRef: text(field(item, "base", "ref")),
            defaultBranch: text(field(item, "base", "repo", "default_branch")),
            labels: asArray(field(item, "labels")).map((l) =>
              text(field(l, "name")),
            ),
          });
        }
        if (items.length < PER_PAGE) break;
      }
      return prs;
    },

    async listCommits(repo, prNumber): Promise<PrCommit[]> {
      const r = await call(
        repo,
        "GET",
        `/repos/${repo}/pulls/${prNumber}/commits?per_page=${PER_PAGE}`,
      );
      const items = asArray(r.data);
      const commits = items.map((item): PrCommit => {
        const id = field(item, "author", "id");
        return {
          authorId: typeof id === "number" ? id : null,
          committedAt: Date.parse(
            text(field(item, "commit", "committer", "date")),
          ),
        };
      });
      // A full page may hide more commits. An unknown author makes the rule ask a person.
      if (items.length >= PER_PAGE)
        commits.push({ authorId: null, committedAt: NaN });
      return commits;
    },

    async listOpenAlerts(repo): Promise<OpenAlert[] | null> {
      if (!(await access(repo)).alerts) return null;
      const r = await call(
        repo,
        "GET",
        `/repos/${repo}/dependabot/alerts?state=open&per_page=${PER_PAGE}`,
        // 403: alerts are off for the repository. 404: no access.
        { accept: [403, 404] },
      );
      if (r.status !== 200) return null;
      // One page. A missing alert can only keep a pull request from merging.
      return asArray(r.data).map((item) => {
        const patched = field(
          item,
          "security_vulnerability",
          "first_patched_version",
          "identifier",
        );
        return {
          package: text(field(item, "dependency", "package", "name")),
          patched: typeof patched === "string" ? patched : null,
        };
      });
    },

    async addLabel(repo, prNumber, label) {
      await call(repo, "POST", `/repos/${repo}/issues/${prNumber}/labels`, {
        body: { labels: [label] },
      });
    },

    async comment(repo, prNumber, body) {
      await call(repo, "POST", `/repos/${repo}/issues/${prNumber}/comments`, {
        body: { body },
      });
    },
  };
}
