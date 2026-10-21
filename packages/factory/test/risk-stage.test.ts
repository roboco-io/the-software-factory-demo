import { describe, expect, it, vi } from "vitest";
import { TooManyFilesError } from "../src/github/port";
import { runRisk } from "../src/stages/risk";
import { makeTestDeps, openBotPr } from "./helpers";

describe("runRisk", () => {
  it("forbids T3 paths in a revert PR like in an implement PR", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h, { role: "revert" }, ["factory/risk-policy.yml"]);
    const r = await runRisk(h.deps, { pr, check: false });
    expect(r.role).toBe("revert");
    expect(r.forbidden).toEqual(["factory/risk-policy.yml"]);
  });

  it("counts the old path of a rename, so moving a T3 file out is still T3 and forbidden", async () => {
    const h = makeTestDeps();
    const { pr, branch } = await openBotPr(h);
    h.gh.setBranch(branch, "sha-a", [
      {
        filename: "apps/api/src/x.ts",
        previousFilename: "packages/factory/src/x.ts",
        additions: [],
      },
    ]);
    const r = await runRisk(h.deps, { pr, check: false });
    expect(r.tier).toBe("T3");
    expect(r.forbidden).toEqual(["packages/factory/src/x.ts"]);
  });

  it("allows T3 changes in human PRs and improve-role bot PRs, which CODEOWNERS then gates", async () => {
    const h = makeTestDeps();
    h.gh.setBranch("human/x", "s", [".github/workflows/ci.yml"]);
    const human = await h.gh.createPull({
      title: "h",
      body: "",
      head: "human/x",
      base: "main",
      draft: false,
    });
    h.gh.pulls.get(human)!.author = "serithemage";
    expect(await runRisk(h.deps, { pr: human, check: false })).toMatchObject({
      tier: "T3",
      botAuthor: false,
      forbidden: [],
      previewAllowed: true,
    });
    const improve = await openBotPr(h, { role: "improve" }, ["AGENTS.md"]);
    expect((await runRisk(h.deps, { pr: improve.pr, check: false })).forbidden).toEqual([]);
  });

  it("disallows previews only for bot PRs at T2 or above", async () => {
    const h = makeTestDeps();
    const t2 = await openBotPr(h, {}, ["apps/api/migrations/0002_x.sql"]);
    const t1 = await openBotPr(h, {}, ["apps/api/src/routes/tags.ts"]);
    expect((await runRisk(h.deps, { pr: t2.pr, check: false })).previewAllowed).toBe(false);
    expect((await runRisk(h.deps, { pr: t1.pr, check: false })).previewAllowed).toBe(true);
  });

  it("disallows previews when the PR head moved past the event's head SHA (fail closed)", async () => {
    const h = makeTestDeps();
    const t1 = await openBotPr(h, {}, ["apps/api/src/routes/tags.ts"]);
    const head = (await h.gh.getPull(t1.pr)).headSha;
    const same = await runRisk(h.deps, { pr: t1.pr, check: false, sha: head });
    expect(same).toMatchObject({ previewAllowed: true, stale: false });
    const moved = await runRisk(h.deps, { pr: t1.pr, check: false, sha: "f".repeat(40) });
    expect(moved).toMatchObject({ previewAllowed: false, stale: true });
  });

  it("replaces stale risk labels when checking", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    await h.gh.addLabels(pr, ["risk:T0", "factory:round-1"]);
    await runRisk(h.deps, { pr, check: true });
    expect((await h.gh.getPull(pr)).labels).toEqual(["factory:round-1", "risk:T1"]);
  });

  it("does not fail --check when the label write is forbidden (fork PR, read-only token)", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    vi.spyOn(h.gh, "addLabels").mockRejectedValue(
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    );
    const r = await runRisk(h.deps, { pr, check: true });
    expect(r.tier).toBe("T1");
    expect(r.forbidden).toEqual([]);
  });

  it("still throws on non-403 label write errors", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    vi.spyOn(h.gh, "addLabels").mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    await expect(runRisk(h.deps, { pr, check: true })).rejects.toThrow("boom");
  });

  it("forbids lines added to skip.txt in a bot implement PR but allows deleting lines (F21)", async () => {
    const h = makeTestDeps();
    const add = await openBotPr(h, {}, [
      { filename: "tests/realworld/skip.txt", additions: ["tags.hurl"] },
    ]);
    const del = await openBotPr(h, {}, [{ filename: "tests/realworld/skip.txt", additions: [] }]);
    const moved = await openBotPr(h, {}, [
      { filename: "tests/realworld/skip.txt", previousFilename: "tests/other.txt", additions: [] },
    ]);
    expect((await runRisk(h.deps, { pr: add.pr, check: false })).forbidden).toEqual([
      "tests/realworld/skip.txt",
    ]);
    const d = await runRisk(h.deps, { pr: del.pr, check: false });
    expect(d).toMatchObject({ tier: "T1", forbidden: [] });
    expect((await runRisk(h.deps, { pr: moved.pr, check: false })).forbidden).toEqual([
      "tests/realworld/skip.txt",
    ]);
  });

  it("applies the same F21 rule to the forum contract skip list", async () => {
    const h = makeTestDeps();
    const add = await openBotPr(h, {}, [
      { filename: "tests/forum/skip.txt", additions: ["topics.hurl"] },
    ]);
    const del = await openBotPr(h, {}, [{ filename: "tests/forum/skip.txt", additions: [] }]);
    expect((await runRisk(h.deps, { pr: add.pr, check: false })).forbidden).toEqual([
      "tests/forum/skip.txt",
    ]);
    expect(await runRisk(h.deps, { pr: del.pr, check: false })).toMatchObject({
      tier: "T1",
      forbidden: [],
    });
  });

  it("forbids the forum contract files themselves (T3)", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h, {}, [
      { filename: "tests/forum/vendor/topics.hurl", additions: [] },
    ]);
    expect((await runRisk(h.deps, { pr, check: false })).forbidden).toEqual([
      "tests/forum/vendor/topics.hurl",
    ]);
  });

  it("treats a PR with too many files as T3 and forbidden for bot implement PRs", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    vi.spyOn(h.gh, "listPullFiles").mockRejectedValue(new TooManyFilesError("3000"));
    const r = await runRisk(h.deps, { pr, check: true });
    expect(r.tier).toBe("T3");
    expect(r.forbidden).toHaveLength(1);
    expect((await h.gh.getPull(pr)).labels).toContain("risk:T3");
  });

  it("forbids a skip.txt change whose patch GitHub omitted, but not a verified deletion (F21)", async () => {
    const h = makeTestDeps();
    const f = "tests/realworld/skip.txt";
    const big = await openBotPr(h, {}, [
      { filename: f, additions: [], additionCount: 3, patchMissing: true },
    ]);
    const truncated = await openBotPr(h, {}, [{ filename: f, additions: [], additionCount: 2 }]);
    const del = await openBotPr(h, {}, [
      { filename: f, additions: [], additionCount: 0, patchMissing: true },
    ]);
    expect((await runRisk(h.deps, { pr: big.pr, check: false })).forbidden).toEqual([f]);
    expect((await runRisk(h.deps, { pr: truncated.pr, check: false })).forbidden).toEqual([f]);
    expect((await runRisk(h.deps, { pr: del.pr, check: false })).forbidden).toEqual([]);
  });
});
