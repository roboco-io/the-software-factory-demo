import {
  createInstallationToken,
  field,
  githubRequest,
  type PublisherConfig,
} from "./github-publisher";

/** A description read from GitHub is reused this long. */
export const OK_TTL_MS = 6 * 3_600_000;
/** After a failed read, the next try waits this long, so GitHub is not asked on every page view. */
export const FAIL_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 3_000;
const MAX_LENGTH = 300;

export type DescriptionLoader = (repo: string) => Promise<string | null>;

/**
 * Keeps each repository's description in memory for the life of the Worker isolate. A failure or
 * a slow answer becomes null, so the project list never waits on or fails because of GitHub.
 */
export function createDescriptionCache(options: {
  load: DescriptionLoader;
  now: () => number;
  timeoutMs?: number;
}) {
  const entries = new Map<
    string,
    { value: string | null; expiresAt: number }
  >();
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  async function one(repo: string): Promise<string | null> {
    const hit = entries.get(repo);
    if (hit !== undefined && options.now() < hit.expiresAt) return hit.value;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    try {
      const value = await Promise.race([options.load(repo), timeout]);
      entries.set(repo, { value, expiresAt: options.now() + OK_TTL_MS });
      return value;
    } catch {
      entries.set(repo, {
        value: null,
        expiresAt: options.now() + FAIL_TTL_MS,
      });
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  return {
    async get(repos: readonly string[]): Promise<Map<string, string | null>> {
      const values = await Promise.all(repos.map(one));
      return new Map(repos.map((repo, i) => [repo, values[i]!]));
    },
  };
}

/** Reads a repository's GitHub description with an installation token that can only read metadata. */
export function githubDescriptionLoader(
  config: PublisherConfig,
): DescriptionLoader {
  const doFetch = config.fetch ?? fetch;
  return async (repo) => {
    const created = await createInstallationToken(config, repo, {
      metadata: "read",
    });
    if (created.token === undefined) throw new Error("no installation token");
    const info = await githubRequest(
      doFetch,
      created.token,
      "GET",
      `/repos/${repo}`,
    );
    const description = field(info.data, "description");
    if (typeof description !== "string") return null;
    const text = description.trim().slice(0, MAX_LENGTH);
    return text === "" ? null : text;
  };
}
