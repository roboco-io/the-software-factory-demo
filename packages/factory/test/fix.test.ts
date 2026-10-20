import { describe, expect, it } from "vitest";
import { createFakeAdapter, loadFakeScript } from "../src/agents/fake";
import { parsePrMeta } from "../src/report/pr";
import { fixStage } from "../src/stages/fix";
import { runPhase } from "../src/stages/phased";
import { reviewStage } from "../src/stages/review";
import { makeTestDeps, openBotPr, scriptedSpawn } from "./helpers";

const write = (n: number) => ({
  writeFiles: { "apps/api/src/routes/tags.ts": `export const tags = ${n};\n` },
});

describe("fix stage", () => {
  it("runs round 1 with the review findings, pushes, and returns the issue to in-review", async () => {
    const codex = createFakeAdapter(loadFakeScript("review-changes"), "codex");
    const claude = createFakeAdapter([write(1)], "claude");
    const h = makeTestDeps({ adapters: { codex, claude } });
    const { pr, issue, branch } = await openBotPr(h);
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "review" }, null);
    expect(claude.calls[0]?.role).toBe("fix");
    expect(claude.calls[0]?.prompt).toContain("빈 배열을 반환하는 테스트를 추가한다");
    expect(claude.calls[0]?.prompt).toContain("수정 라운드 1/3");
    expect(h.git.pushes.map((p) => p.branch)).toEqual([branch]);
    const pull = await h.gh.getPull(pr);
    expect(pull.labels).toContain("factory:round-1");
    expect(parsePrMeta(pull.body)?.round).toBe(1);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:in-review"]);
    expect(h.git.messages[0]).toContain(`Factory-Issue: #${issue}`);
    expect((await h.deps.runs.since(new Date(0))).find((r) => r.role === "fix")).toMatchObject({
      round: 1,
      pr,
    });
  });

  it("adds human actions a fix round declares to the ones already in the PR meta", async () => {
    const codex = createFakeAdapter(loadFakeScript("review-changes"), "codex");
    const claude = createFakeAdapter(
      [{ ...write(1), result: { summary: "고쳤다\n사람 조치 필요: 스모크 기대값 갱신" } }],
      "claude",
    );
    const h = makeTestDeps({ adapters: { codex, claude } });
    const { pr } = await openBotPr(h, { humanActions: ["시크릿 등록"] });
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "review" }, null);
    expect(parsePrMeta((await h.gh.getPull(pr)).body)?.humanActions).toEqual([
      "시크릿 등록",
      "스모크 기대값 갱신",
    ]);
  });

  it("ignores a stale sha so a duplicate dispatch does nothing", async () => {
    const claude = createFakeAdapter([], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const { pr } = await openBotPr(h);
    await runPhase(fixStage, "all", h.deps, { pr, sha: "old-sha", reason: "review" }, null);
    expect(claude.calls).toHaveLength(0);
    expect((await h.gh.getPull(pr)).labels).toEqual([]);
  });

  it("moves to needs-human instead of starting a fourth round", async () => {
    const claude = createFakeAdapter([], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const { pr, issue } = await openBotPr(h);
    await h.gh.addLabels(pr, ["factory:round-3"]);
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "review" }, null);
    expect(claude.calls).toHaveLength(0);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
    expect((await h.gh.listComments(issue)).at(-1)?.body).toContain("3회");
  });

  it("asks a human when rebasing onto main conflicts", async () => {
    const claude = createFakeAdapter([], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    h.git.rebaseOk = false;
    const { pr, issue } = await openBotPr(h);
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "ci" }, null);
    expect(claude.calls).toHaveLength(0);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
    expect((await h.gh.listComments(issue)).at(-1)?.body).toContain("rebase");
  });

  it("spends the round and re-dispatches when the agent fails with rounds left", async () => {
    const claude = createFakeAdapter(
      [{ result: { ok: false, failureReason: "timeout" } }],
      "claude",
    );
    const h = makeTestDeps({ adapters: { claude } });
    const { pr, issue } = await openBotPr(h);
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "ci" }, null);
    expect((await h.gh.getPull(pr)).labels).toContain("factory:round-1");
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:in-review"]);
    expect(h.gh.dispatches).toEqual([
      {
        file: "factory-fix.yml",
        inputs: { pr: String(pr), sha: "sha-a", reason: "ci", issue: String(issue) },
      },
    ]);
  });

  it("feeds failing CI check names to the agent for reason=ci", async () => {
    const claude = createFakeAdapter([write(2)], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const { pr } = await openBotPr(h);
    h.gh.setChecks("sha-a", { typecheck: "success", unit: "failure", e2e: "failure" });
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "ci" }, null);
    expect(claude.calls[0]?.prompt).toContain("unit, e2e");
  });

  it("explains the evidence rule when the evidence check failed", async () => {
    const claude = createFakeAdapter([write(3)], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const { pr } = await openBotPr(h);
    h.gh.setChecks("sha-a", { unit: "success", evidence: "failure" });
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "ci" }, null);
    expect(claude.calls[0]?.prompt).toContain("CI 필수 체크가 실패했다: evidence");
    expect(claude.calls[0]?.prompt).toContain(
      "재현 테스트(Vitest)가 수정 전(base) 코드에서 실패하고 PR 코드에서 통과해야",
    );
  });

  it("discards T3 changes and asks a human", async () => {
    const claude = createFakeAdapter(
      [{ writeFiles: { "packages/factory/src/x.ts": "x\n" } }],
      "claude",
    );
    const h = makeTestDeps({ adapters: { claude } });
    const { pr, issue } = await openBotPr(h);
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "ci" }, null);
    expect(h.git.pushes).toHaveLength(0);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
  });

  it("re-verifies T3 in publish and does not push when the bundle disagrees", async () => {
    const claude = createFakeAdapter([write(3)], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const { pr, issue } = await openBotPr(h);
    const plan = (await fixStage.prepare(h.deps, { pr, sha: "sha-a", reason: "ci" }))!;
    const out = await fixStage.agent(h.deps, plan);
    h.git.descendsFromBase = false;
    await fixStage.publish(h.deps, plan, out);
    expect(h.git.pushes).toHaveLength(0);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
    const run = (await h.deps.runs.since(new Date(0))).find((r) => r.role === "fix");
    expect(run?.ok).toBe(false);
  });

  it("does not force-push over a head that moved while the agent ran", async () => {
    const claude = createFakeAdapter([write(4)], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const { pr, branch, issue } = await openBotPr(h);
    const plan = (await fixStage.prepare(h.deps, { pr, sha: "sha-a", reason: "ci" }))!;
    const out = await fixStage.agent(h.deps, plan);
    h.gh.setBranch(branch, "sha-human", ["apps/api/src/routes/tags.ts"]);
    await fixStage.publish(h.deps, plan, out);
    expect(h.git.pushes).toHaveLength(0);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:in-review"]);
    expect(h.gh.dispatches).toEqual([
      { file: "factory-review.yml", inputs: { pr: String(pr), issue: String(issue) } },
    ]);
  });

  it("clamps reported turns and cost, and rejects malformed outcomes", async () => {
    const claude = createFakeAdapter([], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const { pr } = await openBotPr(h);
    const plan = (await fixStage.prepare(h.deps, { pr, sha: "sha-a", reason: "ci" }))!;
    const result = {
      ok: true,
      summary: "s",
      model: "m",
      turns: 9999,
      costUsd: 999,
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
    };
    await fixStage.publish(h.deps, plan, { kind: "no-changes", result });
    const run = (await h.deps.runs.since(new Date(0))).find((r) => r.role === "fix");
    expect(run).toMatchObject({ turns: 40, costUsd: 3 });
    expect(() => fixStage.parseOutcome({ kind: "committed", result })).toThrow();
    expect(() => fixStage.parseOutcome({ kind: "nope" })).toThrow();
  });

  it("moves to needs-human when the factory is paused", async () => {
    const claude = createFakeAdapter([], "claude");
    const h = makeTestDeps({ adapters: { claude }, settings: { paused: true } });
    const { pr, issue } = await openBotPr(h);
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "ci" }, null);
    expect(claude.calls).toHaveLength(0);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
  });

  it("pushes with a lease on the sha it started from and records ok from the local checks", async () => {
    const claude = createFakeAdapter([write(5)], "claude");
    const h = makeTestDeps({ adapters: { claude }, spawn: scriptedSpawn({ test: [1, 1] }) });
    const { pr } = await openBotPr(h);
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "ci" }, null);
    expect(h.git.pushLeases).toEqual(["sha-a"]);
    const run = (await h.deps.runs.since(new Date(0))).find((r) => r.role === "fix");
    expect(run?.ok).toBe(false);
  });

  it("records a no-change round as not ok", async () => {
    const claude = createFakeAdapter([{ result: { summary: "nothing" } }], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const { pr } = await openBotPr(h);
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "ci" }, null);
    const run = (await h.deps.runs.since(new Date(0))).find((r) => r.role === "fix");
    expect(run?.ok).toBe(false);
  });

  it("escalates a failed round 3 to needs-human instead of re-dispatching", async () => {
    const claude = createFakeAdapter(
      [{ result: { ok: false, failureReason: "timeout" } }],
      "claude",
    );
    const h = makeTestDeps({ adapters: { claude } });
    const { pr, issue } = await openBotPr(h);
    await h.gh.addLabels(pr, ["factory:round-2"]);
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "ci" }, null);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
    expect(h.gh.dispatches.filter((d) => d.file !== "factory-postmortem.yml")).toEqual([]);
  });

  it("a crash spends the round and retries, then escalates at round 3", async () => {
    const h = makeTestDeps({ adapters: { claude: createFakeAdapter([], "claude") } });
    const { pr, issue } = await openBotPr(h);
    const plan = (await fixStage.prepare(h.deps, { pr, sha: "sha-a", reason: "ci" }))!;
    await fixStage.crashed(h.deps, plan);
    expect((await h.gh.getPull(pr)).labels).toContain("factory:round-1");
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:in-review"]);
    expect(h.gh.dispatches.map((d) => d.file)).toEqual(["factory-fix.yml"]);

    const h3 = makeTestDeps({ adapters: { claude: createFakeAdapter([], "claude") } });
    const b = await openBotPr(h3);
    await h3.gh.addLabels(b.pr, ["factory:round-2"]);
    const plan3 = (await fixStage.prepare(h3.deps, { pr: b.pr, sha: "sha-a", reason: "ci" }))!;
    await fixStage.crashed(h3.deps, plan3);
    expect((await h3.gh.getPull(b.pr)).labels).toContain("factory:round-3");
    expect((await h3.gh.getIssue(b.issue)).labels).toEqual(["factory:needs-human"]);
    expect(h3.gh.dispatches.filter((d) => d.file !== "factory-postmortem.yml")).toEqual([]);
  });

  it("a crash after the push sends the new head to review instead of retrying fix", async () => {
    const h = makeTestDeps({ adapters: { claude: createFakeAdapter([], "claude") } });
    const { pr, issue, branch } = await openBotPr(h);
    const plan = (await fixStage.prepare(h.deps, { pr, sha: "sha-a", reason: "ci" }))!;
    h.gh.setBranch(branch, "sha-pushed", ["apps/api/src/routes/tags.ts"]);
    await fixStage.crashed(h.deps, plan);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:in-review"]);
    expect(h.gh.dispatches).toEqual([
      { file: "factory-review.yml", inputs: { pr: String(pr), issue: String(issue) } },
    ]);
  });

  it("a crash after the push still dispatches review when the issue is already in-review", async () => {
    const h = makeTestDeps({ adapters: { claude: createFakeAdapter([], "claude") } });
    const { pr, issue, branch } = await openBotPr(h);
    const plan = (await fixStage.prepare(h.deps, { pr, sha: "sha-a", reason: "ci" }))!;
    h.gh.setBranch(branch, "sha-pushed", ["apps/api/src/routes/tags.ts"]);
    await h.gh.removeLabel(issue, "factory:in-progress");
    await h.gh.addLabels(issue, ["factory:in-review"]);
    await fixStage.crashed(h.deps, plan);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:in-review"]);
    expect(h.gh.dispatches).toEqual([
      { file: "factory-review.yml", inputs: { pr: String(pr), issue: String(issue) } },
    ]);
  });

  it("does not dispatch review after a crash when a human moved the issue to needs-human", async () => {
    const h = makeTestDeps({ adapters: { claude: createFakeAdapter([], "claude") } });
    const { pr, issue, branch } = await openBotPr(h);
    const plan = (await fixStage.prepare(h.deps, { pr, sha: "sha-a", reason: "ci" }))!;
    h.gh.setBranch(branch, "sha-pushed", ["apps/api/src/routes/tags.ts"]);
    await h.gh.removeLabel(issue, "factory:in-progress");
    await h.gh.addLabels(issue, ["factory:needs-human"]);
    await fixStage.crashed(h.deps, plan);
    expect(h.gh.dispatches).toEqual([]);
  });
});
