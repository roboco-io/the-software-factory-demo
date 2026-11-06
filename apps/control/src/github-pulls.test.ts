import { describe, expect, it } from "vitest";
import { GitHubError } from "./github-publisher";
import { createPullClient } from "./github-pulls";
import { ChecksPermissionMissing } from "./pull-port";
import {
  createWorld,
  fakePullsFetch,
  realPullsPort,
  testPem,
  type PullsWorld,
} from "./testing/pulls-world";

const REPO = "acme/demo";
const rt = (over: Partial<PullsWorld> = {}) => {
  const world = createWorld(over);
  return { world, port: realPullsPort(world) };
};
const many = <T>(n: number, make: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(i));

describe("pull client", () => {
  it("reads the pull request fields it needs", async () => {
    const { port } = rt();
    expect(await port.getPullRequest(REPO, 40)).toEqual({
      state: "open",
      merged: false,
      headSha: "a".repeat(40),
      baseRef: "main",
      defaultBranch: "main",
      authorId: "99",
      changedFiles: 1,
    });
  });

  describe("files", () => {
    it("pages through all files", async () => {
      const files = many(250, (i) => ({
        filename: `docs/f${i}.md`,
        status: "added",
      }));
      const { port, world } = rt({ files });
      const r = await port.listFiles(REPO, 40, 250);
      expect(r.truncated).toBe(false);
      expect(r.files).toHaveLength(250);
      expect(world.routes.filter((x) => x.endsWith("/files"))).toHaveLength(3);
    });

    it("keeps the old path of a renamed file", async () => {
      const { port } = rt({
        files: [
          { filename: "b.md", previous_filename: "a.md", status: "renamed" },
        ],
      });
      expect((await port.listFiles(REPO, 40, 1)).files).toEqual([
        { filename: "b.md", previousFilename: "a.md" },
      ]);
    });

    it("truncated files list: reports truncation when the list is shorter than the reported count", async () => {
      const files = many(150, (i) => ({ filename: `f${i}`, status: "added" }));
      const { port } = rt({ files, fileListCap: 100 });
      expect((await port.listFiles(REPO, 40, 150)).truncated).toBe(true);
    });

    it("reports truncation for more than 3000 files without paging them all", async () => {
      const { port, world } = rt();
      const r = await port.listFiles(REPO, 40, 3001);
      expect(r.truncated).toBe(true);
      expect(world.routes.filter((x) => x.endsWith("/files"))).toHaveLength(0);
    });

    it("reports truncation when GitHub gave no count", async () => {
      const { port } = rt();
      expect((await port.listFiles(REPO, 40, -1)).truncated).toBe(true);
    });
  });

  describe("policy", () => {
    it("reads the file at the default branch tip, not at the pull request head", async () => {
      const { port, world } = rt();
      const r = await port.readPolicy(REPO, "main");
      expect(r).toEqual({ kind: "ok", text: world.policyText });
      expect(world.routes).toContain(`GET /repos/${REPO}/git/ref/heads/main`);
      const text = r.kind === "ok" ? r.text : "";
      expect(text).not.toContain("T3");
    });

    it("answers missing for a 404", async () => {
      const { port } = rt({ policyText: null });
      expect(await port.readPolicy(REPO, "main")).toEqual({ kind: "missing" });
    });
  });

  describe("check runs", () => {
    it("pages through all runs", async () => {
      const checks = many(230, (i) => ({
        name: `c${i}`,
        status: "completed",
        conclusion: "success",
      }));
      const { port } = rt({ checks });
      expect(await port.listChecks(REPO, "a".repeat(40))).toHaveLength(230);
    });

    it("maps a permission 403 to ChecksPermissionMissing", async () => {
      const { port } = rt({ checksFailure: "permission" });
      await expect(
        port.listChecks(REPO, "a".repeat(40)),
      ).rejects.toBeInstanceOf(ChecksPermissionMissing);
    });

    it("does not read a rate limit 403 or a server error as a missing permission", async () => {
      for (const checksFailure of ["ratelimit", "server"] as const) {
        const { port } = rt({ checksFailure });
        const error = await port
          .listChecks(REPO, "a".repeat(40))
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GitHubError);
        expect(error).not.toBeInstanceOf(ChecksPermissionMissing);
      }
    });
  });

  describe("reviews", () => {
    it("pages through all reviews and reads user id, type, state and commit", async () => {
      const reviews = many(130, (i) => ({
        user: { id: 1000 + i, type: "User" },
        state: i === 129 ? "APPROVED" : "COMMENTED",
        commit_id: "a".repeat(40),
      }));
      const { port } = rt({ reviews });
      const r = await port.listReviews(REPO, 40);
      expect(r).toHaveLength(130);
      expect(r[129]).toEqual({
        userId: "1129",
        userType: "User",
        state: "APPROVED",
        commitId: "a".repeat(40),
      });
    });
  });

  describe("comment and merge", () => {
    it("posts a comment-only review pinned to the commit", async () => {
      const { port, world } = rt();
      await port.postReview(REPO, 40, "a".repeat(40), "hello");
      expect(world.posted).toEqual([
        { commitId: "a".repeat(40), body: "hello" },
      ]);
    });

    it("merges with squash and pins the head SHA", async () => {
      const { port, world } = rt();
      expect(
        await port.merge(REPO, 40, "a".repeat(40), { title: "t", body: "b" }),
      ).toBe("merged");
      expect(world.merges).toEqual([
        { sha: "a".repeat(40), method: "squash", title: "t" },
      ]);
    });

    it("maps 405 to refused and 409 to conflict, and throws on other failures", async () => {
      const refused = rt({ mergeStatus: 405 });
      expect(
        await refused.port.merge(REPO, 40, "a".repeat(40), {
          title: "t",
          body: "b",
        }),
      ).toBe("refused");
      const conflict = rt({ mergeStatus: 409 });
      expect(
        await conflict.port.merge(REPO, 40, "a".repeat(40), {
          title: "t",
          body: "b",
        }),
      ).toBe("conflict");
      const swapped = rt();
      swapped.world.pr.headSha = "b".repeat(40);
      expect(
        await swapped.port.merge(REPO, 40, "a".repeat(40), {
          title: "t",
          body: "b",
        }),
      ).toBe("conflict");
    });
  });

  describe("tokens", () => {
    it("falls back to a token without Checks read when the installation lacks it", async () => {
      const { port, world } = rt({ noChecksGrant: true });
      await port.getPullRequest(REPO, 40);
      expect(world.tokensCreated).toBe(1);
      await expect(port.listChecks(REPO, "a".repeat(40))).resolves.toHaveLength(
        1,
      );
    });

    it("caches the token across calls", async () => {
      const { port, world } = rt();
      await port.getPullRequest(REPO, 40);
      await port.getPullRequest(REPO, 40);
      await port.listReviews(REPO, 40);
      expect(world.tokensCreated).toBe(1);
    });

    it("does not leak the token in thrown errors", async () => {
      const world = createWorld({ checksFailure: "server" });
      const port = createPullClient({
        appId: "1",
        privateKeyPem: testPem(),
        fetch: fakePullsFetch(world, "ghs_SECRET_TOKEN_VALUE"),
      });
      const error = await port
        .listChecks(REPO, "a".repeat(40))
        .catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect(
        String((error as Error).message) + String((error as Error).stack),
      ).not.toContain("ghs_SECRET");
    });
  });
});
