import type { CheckRun, ReviewEntry } from "../decision";
import {
  ChecksPermissionMissing,
  type PolicyFile,
  type PullRequestPort,
} from "../pull-port";
import { createPullClient } from "../github-pulls";
import { nodeModule } from "./node";

/** A mutable description of one pull request and its repository, shared by the fake port and the fake REST server. */
export interface PullsWorld {
  repo: string;
  prNumber: number;
  pr: {
    state: "open" | "closed";
    merged: boolean;
    headSha: string;
    baseRef: string;
    defaultBranch: string;
    authorId: number;
    /** Overrides the count GitHub reports. */
    changedFiles?: number;
  };
  files: { filename: string; previous_filename?: string; status: string }[];
  /** Pretend GitHub cut the file list at this many files while still reporting the full count. */
  fileListCap?: number;
  /** null means the policy file does not exist. */
  policyText: string | null;
  /** The policy file at the pull request head. It must never be read. */
  headPolicyText: string | null;
  diff: string;
  checks: (Omit<CheckRun, "appId"> & { appId?: number | null })[];
  /** "permission" answers the check-runs call with a 403 without rate-limit headers. */
  checksFailure?: "permission" | "ratelimit" | "server" | undefined;
  reviews: {
    user: { id: number; type: string };
    state: string;
    commit_id: string | null;
  }[];
  posted: { commitId: string; body: string }[];
  merges: { sha: string; method: string; title: string }[];
  mergeStatus: 200 | 405 | 409;
  /** Called once per API route, for tests that check what was read. */
  routes: string[];
  /** When true the installation lacks Checks read, so a token request that includes it gets a 422. */
  noChecksGrant?: boolean;
  /** Incremented per token created. */
  tokensCreated: number;
  postFails?: number;
}

export const DEFAULT_POLICY = `requiredChecks: [test]
autoMergeTiers: [T0, T1]
rules:
  - tier: T0
    patterns: ["docs/**"]
`;

export function createWorld(over: Partial<PullsWorld> = {}): PullsWorld {
  return {
    repo: "acme/demo",
    prNumber: 40,
    pr: {
      state: "open",
      merged: false,
      headSha: "a".repeat(40),
      baseRef: "main",
      defaultBranch: "main",
      authorId: 99,
    },
    files: [{ filename: "docs/a.md", status: "added" }],
    policyText: DEFAULT_POLICY,
    headPolicyText:
      "requiredChecks: [anything]\nautoMergeTiers: [T3]\nrules: []\n",
    diff: "diff --git a/docs/a.md b/docs/a.md\n+hello\n",
    checks: [{ name: "test", status: "completed", conclusion: "success" }],
    reviews: [],
    posted: [],
    merges: [],
    mergeStatus: 200,
    routes: [],
    tokensCreated: 0,
    ...over,
  };
}

/** In-memory PullRequestPort over the world. */
export function fakePullsPort(world: PullsWorld): PullRequestPort {
  const count = () => world.pr.changedFiles ?? world.files.length;
  return {
    async getPullRequest() {
      return {
        state: world.pr.state,
        merged: world.pr.merged,
        headSha: world.pr.headSha,
        baseRef: world.pr.baseRef,
        defaultBranch: world.pr.defaultBranch,
        authorId: String(world.pr.authorId),
        changedFiles: count(),
      };
    },
    async listFiles(_repo, _n, expected) {
      const listed = world.files.slice(0, world.fileListCap ?? Infinity);
      return {
        files: listed.map((f) => ({
          filename: f.filename,
          ...(f.previous_filename === undefined
            ? {}
            : { previousFilename: f.previous_filename }),
        })),
        truncated: listed.length !== expected,
      };
    },
    async readPolicy(): Promise<PolicyFile> {
      world.routes.push("policy");
      return world.policyText === null
        ? { kind: "missing" }
        : { kind: "ok", text: world.policyText };
    },
    async getDiff() {
      return world.diff;
    },
    async listChecks(): Promise<CheckRun[]> {
      if (world.checksFailure === "permission")
        throw new ChecksPermissionMissing();
      if (world.checksFailure !== undefined)
        throw new Error("github unavailable");
      return world.checks.map((c) => ({
        ...c,
        appId: c.appId === undefined ? 15368 : c.appId,
      }));
    },
    async listReviews(): Promise<ReviewEntry[]> {
      return world.reviews.map((r) => ({
        userId: String(r.user.id),
        userType: r.user.type,
        state: r.state,
        commitId: r.commit_id,
      }));
    },
    async postReview(_repo, _n, headSha, body) {
      if ((world.postFails ?? 0) > 0) {
        world.postFails = (world.postFails ?? 0) - 1;
        throw new Error("github unavailable");
      }
      world.posted.push({ commitId: headSha, body });
    },
    async merge(_repo, _n, headSha, message) {
      world.merges.push({
        sha: headSha,
        method: "squash",
        title: message.title,
      });
      if (world.mergeStatus === 200 && headSha !== world.pr.headSha)
        return "conflict";
      if (world.mergeStatus === 200) {
        world.pr.merged = true;
        world.pr.state = "closed";
        return "merged";
      }
      return world.mergeStatus === 405 ? "refused" : "conflict";
    },
  };
}

/** A fetch that answers the GitHub REST routes the real client uses, from the world. */
export function fakePullsFetch(
  world: PullsWorld,
  token = "ghs_FAKE_TOKEN",
): typeof fetch {
  const json = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const page = <T>(items: T[], url: URL) => {
    const per = Number(url.searchParams.get("per_page") ?? "30");
    const n = Number(url.searchParams.get("page") ?? "1");
    return items.slice((n - 1) * per, n * per);
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as string, init);
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    const body = request.method === "GET" ? "" : await request.text();
    world.routes.push(key);
    if (key === `GET /repos/${world.repo}/installation`)
      return json(200, { id: 99 });
    if (key === "POST /app/installations/99/access_tokens") {
      const permissions = (
        JSON.parse(body) as { permissions: Record<string, string> }
      ).permissions;
      if (world.noChecksGrant === true && "checks" in permissions)
        return json(422, { message: "permissions not granted" });
      world.tokensCreated += 1;
      return json(201, {
        token,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    }
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return json(401, { message: "Bad credentials" });
    const repoPrefix = `/repos/${world.repo}`;
    if (key === `GET ${repoPrefix}/pulls/${world.prNumber}`) {
      return json(200, {
        state: world.pr.state,
        merged: world.pr.merged,
        head: { sha: world.pr.headSha },
        base: {
          ref: world.pr.baseRef,
          repo: { default_branch: world.pr.defaultBranch },
        },
        user: { id: world.pr.authorId },
        changed_files: world.pr.changedFiles ?? world.files.length,
      });
    }
    if (key === `GET ${repoPrefix}/pulls/${world.prNumber}/files`) {
      const listed = world.files.slice(0, world.fileListCap ?? Infinity);
      return json(200, page(listed, url));
    }
    if (key === `GET ${repoPrefix}/git/ref/heads/${world.pr.defaultBranch}`)
      return json(200, { object: { sha: "tip".padEnd(40, "0") } });
    if (key === `GET ${repoPrefix}/contents/.factory/policy.yml`) {
      const ref = url.searchParams.get("ref");
      const text =
        ref === world.pr.headSha ? world.headPolicyText : world.policyText;
      return text === null
        ? json(404, { message: "Not Found" })
        : new Response(text, { status: 200 });
    }
    if (key.startsWith(`GET ${repoPrefix}/compare/`))
      return new Response(world.diff);
    if (
      /\/commits\/[0-9a-f]+\/check-runs$/.test(url.pathname) &&
      request.method === "GET"
    ) {
      if (world.checksFailure === "permission")
        return json(403, { message: "Resource not accessible by integration" });
      if (world.checksFailure === "ratelimit")
        return json(
          403,
          { message: "rate limit" },
          { "x-ratelimit-remaining": "0" },
        );
      if (world.checksFailure === "server")
        return json(502, { message: "bad gateway" });
      return json(200, {
        total_count: world.checks.length,
        check_runs: page(world.checks, url).map((c) => ({
          ...c,
          app: { id: c.appId === undefined ? 15368 : c.appId },
        })),
      });
    }
    if (key === `GET ${repoPrefix}/pulls/${world.prNumber}/reviews`)
      return json(200, page(world.reviews, url));
    if (key === `POST ${repoPrefix}/pulls/${world.prNumber}/reviews`) {
      if ((world.postFails ?? 0) > 0) {
        world.postFails = (world.postFails ?? 0) - 1;
        return json(502, { message: "bad gateway" });
      }
      const b = JSON.parse(body) as { commit_id: string; body: string };
      world.posted.push({ commitId: b.commit_id, body: b.body });
      return json(200, { id: 1 });
    }
    if (key === `PUT ${repoPrefix}/pulls/${world.prNumber}/merge`) {
      const b = JSON.parse(body) as {
        sha: string;
        merge_method: string;
        commit_title: string;
      };
      world.merges.push({
        sha: b.sha,
        method: b.merge_method,
        title: b.commit_title,
      });
      if (world.mergeStatus !== 200)
        return json(world.mergeStatus, { message: "not mergeable" });
      if (b.sha !== world.pr.headSha)
        return json(409, { message: "Head branch was modified" });
      world.pr.merged = true;
      world.pr.state = "closed";
      return json(200, { merged: true, sha: "m".repeat(40) });
    }
    return json(404, { message: `no fake for ${key}` });
  }) as typeof fetch;
}

export function testPem(): string {
  const nodeCrypto = nodeModule<{
    generateKeyPairSync(
      t: "rsa",
      o: { modulusLength: number },
    ): { privateKey: { export(o: { type: "pkcs1"; format: "pem" }): string } };
  }>("node:crypto");
  return nodeCrypto
    .generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" });
}

/** The real client over the fake REST server. */
export function realPullsPort(world: PullsWorld): PullRequestPort {
  return createPullClient({
    appId: "1",
    privateKeyPem: testPem(),
    fetch: fakePullsFetch(world),
  });
}

/**
 * The seam: the in-memory fake by default, the real client over the fake REST server
 * when SUPERLITE_REAL=1. The same tests run against both.
 */
export function pullsFor(world: PullsWorld): PullRequestPort {
  const env = (
    globalThis as unknown as {
      process: { env: Record<string, string | undefined> };
    }
  ).process.env;
  return env.SUPERLITE_REAL === "1"
    ? realPullsPort(world)
    : fakePullsPort(world);
}
