import { describe, expect, it } from "vitest";
import { createDependabotGitHub } from "./github-dependabot";
import { testPem } from "./testing/pulls-world";

const R = "/repos/acme/demo";

function world(
  routes: Record<string, (body: unknown) => Response> = {},
  options: { alertsGranted?: boolean } = {},
) {
  const calls: { method: string; path: string; body: unknown; auth: string }[] =
    [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method,
      path,
      body,
      auth: new Headers(init.headers).get("authorization") ?? "",
    });
    const custom = routes[`${method} ${path}`];
    if (custom !== undefined) return custom(body);
    if (path === `${R}/installation`) return Response.json({ id: 7 });
    if (path === "/app/installations/7/access_tokens") {
      const wantsAlerts =
        (body as { permissions: Record<string, string> }).permissions
          .vulnerability_alerts !== undefined;
      if (wantsAlerts && options.alertsGranted === false)
        return Response.json({}, { status: 422 });
      return Response.json(
        {
          token: wantsAlerts ? "alerts-token" : "plain-token",
          expires_at: "2030-01-01T00:00:00Z",
        },
        { status: 201 },
      );
    }
    return Response.json({}, { status: method === "GET" ? 404 : 201 });
  }) as typeof fetch;
  const github = createDependabotGitHub({
    appId: "1",
    privateKeyPem: testPem(),
    fetch: fetchStub,
  });
  return { calls, github };
}

const listed = {
  number: 143,
  title: "chore(deps): bump hono from 4.13.13 to 4.13.16",
  draft: false,
  user: { id: 49699333, login: "dependabot[bot]", type: "Bot" },
  head: { sha: "a".repeat(40), repo: { full_name: "Acme/Demo" } },
  base: { ref: "main", repo: { default_branch: "main" } },
  labels: [{ name: "dependencies" }],
};

describe("Dependabot GitHub port", () => {
  it("lists open pull requests with a token limited to the repository", async () => {
    const { calls, github } = world({
      [`GET ${R}/pulls?state=open&per_page=100&page=1`]: () =>
        Response.json([listed]),
    });
    expect(await github.listOpenPrs("acme/demo")).toEqual([
      {
        number: 143,
        title: listed.title,
        author: { id: 49699333, login: "dependabot[bot]", type: "Bot" },
        draft: false,
        headSha: "a".repeat(40),
        sameRepo: true,
        baseRef: "main",
        defaultBranch: "main",
        labels: ["dependencies"],
      },
    ]);
    expect(calls.find((c) => c.path.endsWith("/access_tokens"))!.body).toEqual({
      repositories: ["demo"],
      permissions: {
        pull_requests: "write",
        issues: "write",
        vulnerability_alerts: "read",
      },
    });
    expect(calls.at(-1)!.auth).toBe("Bearer alerts-token");
  });

  it("marks a fork head and a missing draft flag", async () => {
    const { github } = world({
      [`GET ${R}/pulls?state=open&per_page=100&page=1`]: () =>
        Response.json([
          {
            ...listed,
            draft: undefined,
            head: { sha: "b".repeat(40), repo: { full_name: "evil/demo" } },
          },
        ]),
    });
    const [pr] = await github.listOpenPrs("acme/demo");
    expect(pr).toMatchObject({ sameRepo: false, draft: true });
  });

  it("rejects an invalid repository name before any request", async () => {
    const { calls, github } = world();
    await expect(github.listOpenPrs("acme/demo/../x")).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("reads commit authors and committer times", async () => {
    const { github } = world({
      [`GET ${R}/pulls/143/commits?per_page=100`]: () =>
        Response.json([
          {
            author: { id: 49699333 },
            committer: { id: 19864447 },
            commit: {
              message: "bump hono from 4.13.13 to 4.13.16",
              committer: { date: "2026-11-13T00:00:00Z" },
              verification: { verified: true, reason: "valid" },
            },
          },
          {
            author: { id: 49699333 },
            committer: { id: 19864447 },
            commit: {
              committer: {},
              verification: { verified: true, reason: "unknown_key" },
            },
          },
          { author: null, commit: { committer: {} } },
        ]),
    });
    const commits = await github.listCommits("acme/demo", 143);
    expect(commits[0]).toEqual({
      authorId: 49699333,
      committerId: 19864447,
      verified: true,
      message: "bump hono from 4.13.13 to 4.13.16",
      committedAt: Date.parse("2026-11-13T00:00:00Z"),
    });
    expect(commits[1]!.verified).toBe(false);
    expect(commits[2]).toMatchObject({
      authorId: null,
      committerId: null,
      verified: false,
    });
    expect(commits[2]!.committedAt).toBeNaN();
  });

  it("adds an unknown author when the commit page is full", async () => {
    const one = {
      author: { id: 49699333 },
      commit: { committer: { date: "2026-11-13T00:00:00Z" } },
    };
    const { github } = world({
      [`GET ${R}/pulls/143/commits?per_page=100`]: () =>
        Response.json(Array.from({ length: 100 }, () => one)),
    });
    const commits = await github.listCommits("acme/demo", 143);
    expect(commits).toHaveLength(101);
    expect(commits.at(-1)!.authorId).toBeNull();
  });

  it("reads open alerts", async () => {
    const { github } = world({
      [`GET ${R}/dependabot/alerts?state=open&ecosystem=npm&per_page=100`]:
        () =>
          Response.json([
            {
              dependency: { package: { name: "hono", ecosystem: "npm" } },
              security_vulnerability: {
                first_patched_version: { identifier: "4.13.16" },
              },
            },
            {
              dependency: { package: { name: "left", ecosystem: "npm" } },
              security_vulnerability: { first_patched_version: null },
            },
          ]),
    });
    expect(await github.listOpenAlerts("acme/demo")).toEqual([
      { package: "hono", ecosystem: "npm", patched: "4.13.16" },
      { package: "left", ecosystem: "npm", patched: null },
    ]);
  });

  it("answers null for alerts when the permission is not granted, and still works otherwise", async () => {
    const { calls, github } = world(
      {
        [`GET ${R}/pulls?state=open&per_page=100&page=1`]: () =>
          Response.json([]),
      },
      { alertsGranted: false },
    );
    expect(await github.listOpenAlerts("acme/demo")).toBeNull();
    expect(await github.listOpenPrs("acme/demo")).toEqual([]);
    expect(calls.some((c) => c.path.includes("/dependabot/alerts"))).toBe(
      false,
    );
    expect(calls.at(-1)!.auth).toBe("Bearer plain-token");
  });

  it.each([403, 404])("answers null when alerts respond %i", async (status) => {
    const { github } = world({
      [`GET ${R}/dependabot/alerts?state=open&ecosystem=npm&per_page=100`]:
        () => Response.json({}, { status }),
    });
    expect(await github.listOpenAlerts("acme/demo")).toBeNull();
  });

  it("reads the pull request as it is now", async () => {
    const { github } = world({
      [`GET ${R}/pulls/143`]: () =>
        Response.json({ ...listed, state: "open", merged: false }),
    });
    expect(await github.getPr("acme/demo", 143)).toMatchObject({
      number: 143,
      title: listed.title,
      baseRef: "main",
      labels: ["dependencies"],
      open: true,
    });
  });

  it.each([
    { state: "closed", merged: false },
    { state: "open", merged: true },
  ])("reports %j as not open", async (state) => {
    const { github } = world({
      [`GET ${R}/pulls/143`]: () => Response.json({ ...listed, ...state }),
    });
    expect((await github.getPr("acme/demo", 143)).open).toBe(false);
  });

  it("reads changed files with status and diff", async () => {
    const { github } = world({
      [`GET ${R}/pulls/143/files?per_page=100`]: () =>
        Response.json([
          { filename: "pnpm-lock.yaml", status: "modified", patch: "@@" },
          { filename: "big.json", status: "added" },
        ]),
    });
    expect(await github.listFiles("acme/demo", 143)).toEqual({
      files: [
        { path: "pnpm-lock.yaml", status: "modified", patch: "@@" },
        { path: "big.json", status: "added", patch: null },
      ],
      truncated: false,
    });
  });

  it("marks a full page of files as cut off", async () => {
    const { github } = world({
      [`GET ${R}/pulls/143/files?per_page=100`]: () =>
        Response.json(
          Array.from({ length: 100 }, () => ({
            filename: "pnpm-lock.yaml",
            status: "modified",
            patch: "@@",
          })),
        ),
    });
    expect((await github.listFiles("acme/demo", 143)).truncated).toBe(true);
  });

  it("adds a label and a comment", async () => {
    const { calls, github } = world();
    await github.addLabel("acme/demo", 143, "factory:needs-human");
    await github.comment("acme/demo", 143, "hello");
    expect(calls.slice(-2).map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", `${R}/issues/143/labels`, { labels: ["factory:needs-human"] }],
      ["POST", `${R}/issues/143/comments`, { body: "hello" }],
    ]);
  });
});
