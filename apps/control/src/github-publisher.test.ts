import { describe, expect, it } from "vitest";
import {
  createPublisher,
  neutralizeMentions,
  branchName,
  type PublishRequest,
} from "./github-publisher";
import { createFakeGitHub } from "./testing/fake-github";
import { nodeModule } from "./testing/node";

const nodeCrypto = nodeModule<{
  generateKeyPairSync(
    t: "rsa",
    o: { modulusLength: number },
  ): {
    privateKey: { export(o: { type: "pkcs1"; format: "pem" }): string };
  };
}>("node:crypto");
const pem = nodeCrypto
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({
    type: "pkcs1",
    format: "pem",
  });

const TOKEN = "ghs_INSTALLATION_TOKEN_123456";
const BASE = "a".repeat(40);
const req: PublishRequest = {
  repo: "acme/demo",
  issueNumber: 7,
  runId: "run1",
  model: "claude-sonnet-5-5",
  title: "Add footer @everyone, closes #99 and fixes acme/other#3",
  baseSha: BASE,
  changes: [
    {
      path: "src/footer.ts",
      status: "added",
      size: 2,
      contentBase64: btoa("hi"),
    },
    {
      path: "scripts/run.sh",
      status: "modified",
      size: 1,
      contentBase64: btoa("x"),
    },
    { path: "old.txt", status: "deleted", size: 0 },
  ],
};

const BASE_TREE = [
  { path: "scripts", mode: "040000", type: "tree" },
  { path: "scripts/run.sh", mode: "100755", type: "blob" },
  { path: "src", mode: "040000", type: "tree" },
];

function setup(
  failOnce: string[] = [],
  extra: {
    baseTree?: { path: string; mode: string; type: string }[];
    baseTreeTruncated?: boolean;
  } = {},
) {
  const gh = createFakeGitHub({
    token: TOKEN,
    baseSha: BASE,
    failOnce,
    baseTree: BASE_TREE,
    ...extra,
  });
  const publisher = createPublisher({
    appId: "12345",
    privateKeyPem: pem,
    fetch: gh.fetch,
    nowSeconds: () => 1_700_000_000,
  });
  return { gh, publisher };
}

describe("publisher", () => {
  it("creates a branch, one commit and a PR that refs (never closes) the issue, then comments", async () => {
    const { gh, publisher } = setup();
    const result = await publisher.publish(req);
    expect(result).toEqual({
      prNumber: 40,
      prUrl: "https://github.com/acme/demo/pull/40",
      branch: "factory/issue-7-run1",
    });
    expect(gh.refs.get("refs/heads/factory/issue-7-run1")).toMatch(/^commit-/);
    expect(gh.prs).toHaveLength(1);
    const pr = gh.prs[0]!;
    expect(pr.head).toBe("factory/issue-7-run1");
    expect(pr.body).toMatch(/^Refs #7$/m);
    expect(pr.body).not.toMatch(/\b(closes|fixes|resolves)\b/i);
    expect(pr.body).toContain("claude-sonnet-5-5");
    expect(pr.body).toMatch(/agent-generated/i);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain(
      "https://github.com/acme/demo/pull/40",
    );
  });

  it("scopes the installation token to the single repository with minimal permissions", async () => {
    const { gh, publisher } = setup();
    await publisher.publish(req);
    const tokenCall = gh.calls.find(
      (c) => c.path === "/app/installations/99/access_tokens",
    )!;
    expect(tokenCall.body).toEqual({
      repositories: ["demo"],
      permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "write",
      },
    });
    expect(tokenCall.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const later = gh.calls.filter((c) => !c.path.includes("installation"));
    for (const c of later) expect(c.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("builds the tree from the base commit with modes and deletions", async () => {
    const { gh, publisher } = setup();
    await publisher.publish(req);
    const tree = gh.calls.find((c) => c.path.endsWith("/git/trees"))!.body as {
      base_tree: string;
      tree: { path: string; mode: string; sha: string | null }[];
    };
    expect(tree.base_tree).toBe("tree-base");
    expect(tree.tree).toEqual([
      {
        path: "src/footer.ts",
        mode: "100644",
        type: "blob",
        sha: expect.stringMatching(/^blob-/),
      },
      {
        path: "scripts/run.sh",
        mode: "100755",
        type: "blob",
        sha: expect.stringMatching(/^blob-/),
      },
      { path: "old.txt", mode: "100644", type: "blob", sha: null },
    ]);
    const commit = gh.calls.find((c) => c.path.endsWith("/git/commits"))!
      .body as { parents: string[]; message: string };
    expect(commit.parents).toEqual([BASE]);
    expect(commit.message).toContain("#7");
  });

  it("neutralizes mentions and issue references in the PR title and never echoes agent text", async () => {
    const { gh, publisher } = setup();
    await publisher.publish(req);
    const pr = gh.prs[0]!;
    expect(pr.title).not.toMatch(/@everyone|@\w/);
    expect(pr.title).not.toMatch(/#99/);
    expect(
      neutralizeMentions("hi @alice and @org/team #12 acme/x#3"),
    ).not.toMatch(/@\w|#\d/);
  });

  it("is idempotent: a retry reuses the branch and PR and adds no second comment", async () => {
    const { gh, publisher } = setup();
    const first = await publisher.publish(req);
    const second = await publisher.publish(req);
    expect(second).toEqual(first);
    expect(gh.prs).toHaveLength(1);
    expect(gh.comments).toHaveLength(1);
    expect(gh.refs.size).toBe(1);
  });

  it("recovers from a transient failure after the branch was created", async () => {
    const { gh, publisher } = setup(["POST /repos/acme/demo/pulls"]);
    await expect(publisher.publish(req)).rejects.toThrow();
    expect(gh.refs.size).toBe(1);
    const result = await publisher.publish(req);
    expect(result.prNumber).toBe(40);
    expect(gh.prs).toHaveLength(1);
  });

  it("never merges or touches anything outside the repo and app endpoints", async () => {
    const { gh, publisher } = setup();
    await publisher.publish(req);
    for (const c of gh.calls) {
      expect(c.path).not.toMatch(/merge/);
      expect(c.method).not.toBe("DELETE");
      expect(c.method).not.toBe("PUT");
      expect(c.method).not.toBe("PATCH");
      expect(c.path).toMatch(/^\/(repos\/acme\/demo|app\/installations\/99)/);
    }
  });

  it("does not leak the token or key in thrown errors", async () => {
    const { gh, publisher } = setup(["POST /repos/acme/demo/git/trees"]);
    const error = await publisher
      .publish(req)
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    const text =
      String((error as Error).message) + String((error as Error).stack);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("PRIVATE KEY");
    expect(gh.calls.length).toBeGreaterThan(0);
  });

  it("names the branch from the issue and run", () => {
    expect(branchName(7, "run1")).toBe("factory/issue-7-run1");
  });

  it("publishes 100755 only when the base tree already has the file executable", async () => {
    const { gh, publisher } = setup();
    await publisher.publish({
      ...req,
      changes: [
        { path: "new.sh", status: "added", size: 1, contentBase64: btoa("x") },
        {
          path: "scripts/run.sh",
          status: "modified",
          size: 1,
          contentBase64: btoa("y"),
        },
      ],
    });
    const tree = gh.calls.find((c) => c.path.endsWith("/git/trees"))!.body as {
      tree: { path: string; mode: string }[];
    };
    expect(tree.tree.map((t) => [t.path, t.mode])).toEqual([
      ["new.sh", "100644"],
      ["scripts/run.sh", "100755"],
    ]);
  });

  it("rejects a change that lands on a symlink or inside a submodule or symlinked directory", async () => {
    const baseTree = [
      { path: "link", mode: "120000", type: "blob" },
      { path: "vendor", mode: "160000", type: "commit" },
    ];
    for (const [path, code] of [
      ["link", "symlink"],
      ["link/x.txt", "symlink"],
      ["vendor/lib.c", "submodule"],
    ] as const) {
      const { gh, publisher } = setup([], { baseTree });
      const err = await publisher
        .publish({
          ...req,
          changes: [
            { path, status: "added", size: 1, contentBase64: btoa("x") },
          ],
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ name: "PublishRejected", code });
      expect(gh.refs.size).toBe(0);
    }
  });

  it("fails (retryably) when the base tree is truncated and cannot be inspected", async () => {
    const { gh, publisher } = setup([], { baseTreeTruncated: true });
    await expect(publisher.publish(req)).rejects.toThrow(/too large/);
    expect(gh.refs.size).toBe(0);
  });
});
