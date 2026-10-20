import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGit } from "../src/git/port";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    },
  ).trim();
}

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "git-port-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  git(work, "symbolic-ref", "HEAD", "refs/heads/main");
  const port = createGit(work, { name: "bot", email: "bot@example.com" });
  writeFileSync(path.join(work, "README.md"), "r\n");
  mkdirSync(path.join(work, "packages/factory/src"), { recursive: true });
  writeFileSync(path.join(work, "packages/factory/src/x.ts"), "x\n");
  await port.commitAll("init");
  await port.push("main", "unused-for-file-remotes");
  await port.fetch("main");
  return { root, origin, work, port };
}

describe("createGit", () => {
  it("reports modified, untracked and both sides of a rename", async () => {
    const { work, port } = await setup();
    await port.checkoutNewBranch("factory/issue-1", "origin/main");
    writeFileSync(path.join(work, "README.md"), "changed\n");
    mkdirSync(path.join(work, "apps/api/src"), { recursive: true });
    writeFileSync(path.join(work, "apps/a.ts"), "a\n");
    git(work, "mv", "packages/factory/src/x.ts", "apps/api/src/x.ts");
    expect((await port.changedFiles()).sort()).toEqual([
      "README.md",
      "apps/a.ts",
      "apps/api/src/x.ts",
      "packages/factory/src/x.ts",
    ]);
  });

  it("commits with hooks disabled and lists committed files against the base", async () => {
    const { work, port } = await setup();
    await port.checkoutNewBranch("factory/issue-2", "origin/main");
    const hook = path.join(work, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(path.join(work, "apps.ts"), "a\n");
    const sha = await port.commitAll("feat: x\n\nFactory-Issue: #2");
    expect(sha).toBe(await port.headSha());
    expect(git(work, "log", "-1", "--format=%B")).toContain("Factory-Issue: #2");
    expect(await port.filesAgainst("origin/main")).toEqual(["apps.ts"]);
    expect(await port.diffAgainst("origin/main")).toContain("+++ b/apps.ts");
  });

  it("pushes HEAD to the named branch", async () => {
    const { work, port, origin } = await setup();
    await port.checkoutNewBranch("factory/issue-3", "origin/main");
    writeFileSync(path.join(work, "f.ts"), "f\n");
    const sha = await port.commitAll("f");
    await port.push("factory/issue-3", "token");
    expect(git(origin, "rev-parse", "refs/heads/factory/issue-3")).toBe(sha);
  });

  it("refuses a lease push when the remote branch moved", async () => {
    const { work, port, origin, root } = await setup();
    await port.checkoutNewBranch("factory/issue-7", "origin/main");
    writeFileSync(path.join(work, "a.ts"), "a\n");
    const first = await port.commitAll("a");
    await port.push("factory/issue-7", "token");
    const other = path.join(root, "other");
    execFileSync("git", ["clone", origin, other], { stdio: "pipe" });
    git(other, "checkout", "factory/issue-7");
    writeFileSync(path.join(other, "h.ts"), "h\n");
    git(other, "add", "-A");
    git(other, "commit", "-m", "human");
    git(other, "push", "origin", "factory/issue-7");
    writeFileSync(path.join(work, "b.ts"), "b\n");
    await port.commitAll("b");
    await expect(port.push("factory/issue-7", "token", first)).rejects.toThrow();
    expect(git(origin, "log", "-1", "--format=%s", "refs/heads/factory/issue-7")).toBe("human");
    await port.push("factory/issue-7", "token");
  });

  it("moves commits between checkouts with a bundle", async () => {
    const { root, origin, work, port } = await setup();
    await port.checkoutNewBranch("factory/issue-5", "origin/main");
    writeFileSync(path.join(work, "b.ts"), "b\n");
    const sha = await port.commitAll("b");
    const bundle = path.join(root, "work.bundle");
    await port.createBundle(bundle);
    const fresh = path.join(root, "fresh");
    execFileSync("git", ["clone", origin, fresh], { stdio: "pipe" });
    const other = createGit(fresh, { name: "bot", email: "bot@example.com" });
    await other.importBundle(bundle, "factory/issue-5");
    expect(await other.headSha()).toBe(sha);
    expect(git(fresh, "rev-parse", "--abbrev-ref", "HEAD")).toBe("factory/issue-5");
    expect(await other.filesAgainst("origin/main")).toEqual(["b.ts"]);
  });

  it("resolves refs and checks ancestry of HEAD over a base SHA", async () => {
    const { work, port } = await setup();
    const base = await port.revParse("origin/main");
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    await port.checkoutNewBranch("factory/issue-6", base);
    writeFileSync(path.join(work, "c.ts"), "c\n");
    await port.commitAll("c");
    expect(await port.isAncestor(base)).toBe(true);
    // 기반 커밋과 무관한 고아 히스토리는 후손이 아니다.
    git(work, "checkout", "--orphan", "unrelated");
    writeFileSync(path.join(work, "o.ts"), "o\n");
    git(work, "add", "-A");
    git(work, "commit", "-m", "orphan");
    expect(await port.isAncestor(base)).toBe(false);
    // 저장소에 없는 SHA는 오류가 아니라 false다(fail closed).
    expect(await port.isAncestor("0".repeat(40))).toBe(false);
    await expect(port.isAncestor("HEAD~1")).rejects.toThrow(/invalid sha/);
    await expect(port.revParse("--all")).rejects.toThrow(/invalid ref/);
  });

  it("resetSoft keeps changes staged so a recommit replaces the author and message", async () => {
    const { work, port } = await setup();
    const base = await port.revParse("origin/main");
    await port.checkoutNewBranch("factory/issue-7", base);
    writeFileSync(path.join(work, "d.ts"), "d\n");
    git(work, "add", "-A");
    git(
      work,
      "commit",
      "--author=Mallory <m@example.com>",
      "-m",
      "evil\n\nCo-authored-by: X <x@y.z>",
    );
    await port.resetSoft(base);
    await port.commitAll("trusted");
    expect(git(work, "log", "-1", "--format=%an|%s")).toBe("bot|trusted");
    expect(git(work, "rev-list", "--count", `${base}..HEAD`)).toBe("1");
    expect(await port.filesAgainst(base)).toEqual(["d.ts"]);
    await expect(port.resetSoft("HEAD~1")).rejects.toThrow(/invalid sha/);
  });

  it("returns false on a rebase conflict and leaves no rebase in progress", async () => {
    const { root, origin, work, port } = await setup();
    await port.checkoutNewBranch("factory/issue-4", "origin/main");
    writeFileSync(path.join(work, "README.md"), "branch\n");
    await port.commitAll("branch change");
    const other = path.join(root, "other");
    execFileSync("git", ["clone", origin, other], { stdio: "pipe" });
    writeFileSync(path.join(other, "README.md"), "main\n");
    git(other, "commit", "-am", "main change");
    git(other, "push", "origin", "main");
    await port.fetch("main");
    expect(await port.rebaseOnto("origin/main")).toBe(false);
    expect(existsSync(path.join(work, ".git/rebase-merge"))).toBe(false);
    expect(existsSync(path.join(work, ".git/rebase-apply"))).toBe(false);
  });

  describe("createGit ref validation", () => {
    it("rejects branch names and start points outside the factory pattern", async () => {
      const { port } = await setup();
      await expect(port.checkoutNewBranch("--orphan", "origin/main")).rejects.toThrow(
        /invalid branch/,
      );
      await expect(port.checkoutNewBranch("factory/issue-1", "-x")).rejects.toThrow(/start point/);
      await expect(port.importBundle("/tmp/x", "evil;rm")).rejects.toThrow(/invalid branch/);
    });
  });
});

describe("createGit revert and restorePaths", () => {
  it("reverts a commit onto a new sha and restores the file", async () => {
    const { work, port } = await setup();
    await port.checkoutNewBranch("factory/revert-issue-66", "origin/main");
    writeFileSync(path.join(work, "README.md"), "changed\n");
    const a = await port.commitAll("feat: a");
    const sha = await port.revert(a, "revert: a\n\nFactory-Revert: #66");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sha).not.toBe(a);
    expect(await port.headSha()).toBe(sha);
    expect(readFileSync(path.join(work, "README.md"), "utf8")).toBe("r\n");
    expect(git(work, "log", "-1", "--format=%B")).toContain("Factory-Revert: #66");
  });

  it("returns null and leaves a clean tree when the revert conflicts", async () => {
    const { work, port } = await setup();
    await port.checkoutNewBranch("factory/revert-issue-67", "origin/main");
    writeFileSync(path.join(work, "README.md"), "one\n");
    const a = await port.commitAll("feat: one");
    writeFileSync(path.join(work, "README.md"), "two\n");
    const b = await port.commitAll("feat: two");
    expect(await port.revert(a, "revert")).toBeNull();
    expect(await port.headSha()).toBe(b);
    expect(await port.changedFiles()).toEqual([]);
    expect(existsSync(path.join(work, ".git/REVERT_HEAD"))).toBe(false);
  });

  it("restores only the given paths from a sha", async () => {
    const { work, port } = await setup();
    const base = await port.headSha();
    await port.checkoutNewBranch("factory/revert-issue-68", "origin/main");
    writeFileSync(path.join(work, "README.md"), "changed\n");
    writeFileSync(path.join(work, "packages/factory/src/x.ts"), "y\n");
    await port.commitAll("feat: both");
    await port.restorePaths(["README.md"], base);
    expect(readFileSync(path.join(work, "README.md"), "utf8")).toBe("r\n");
    expect(readFileSync(path.join(work, "packages/factory/src/x.ts"), "utf8")).toBe("y\n");
    await expect(port.restorePaths(["README.md"], "HEAD~1")).rejects.toThrow(/invalid sha/);
  });

  it("allows factory/revert-issue-N branches and rejects other revert names", async () => {
    const { port } = await setup();
    await port.checkoutNewBranch("factory/revert-issue-66", "origin/main");
    await expect(port.checkoutNewBranch("factory/revert-x", "origin/main")).rejects.toThrow(
      /invalid branch/,
    );
    await expect(
      port.checkoutNewBranch("factory/revert-issue-0", "origin/main"),
    ).rejects.toThrow(/invalid branch/);
    await expect(port.revert("--abort", "m")).rejects.toThrow(/invalid sha/);
  });
});
