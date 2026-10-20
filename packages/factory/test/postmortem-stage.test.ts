import { describe, expect, it } from "vitest";
import { createFakeAdapter } from "../src/agents/fake";
import type { PostmortemAnalysis } from "../src/postmortem/analysis";
import { POSTMORTEM_MARKER } from "../src/postmortem/report";
import { stepRecord } from "../src/stages/common";
import { runPhase } from "../src/stages/phased";
import { postmortemStage, type PostmortemArgs } from "../src/stages/postmortem";
import { parseRevertIssues } from "../src/report/commit";
import { parsePrMeta } from "../src/report/pr";
import { BOT, makeTestDeps, type TestHarness } from "./helpers";

const ANALYSIS: PostmortemAnalysis = {
  classification: "bot_regression",
  causePr: 65,
  excerptQuote: "name: 'conduit'",
  rootCause: [{ text: "PR 65가 홈 제목을 지웠다", kind: "fact" }],
  defenses: [{ text: "e2e-preview는 필수 체크가 아니다", kind: "fact" }],
  actions: ["제목 복원"],
  summary: "홈 화면 제목이 사라져 스모크가 실패했다.",
};

const step = (a: PostmortemAnalysis = ANALYSIS, costUsd = 0.5) => ({
  result: { summary: JSON.stringify(a), model: "claude-sonnet-5-5", turns: 3, costUsd },
});

function setup(steps: ReturnType<typeof step>[] = [step(), step(), step()]) {
  const claude = createFakeAdapter(steps, "claude");
  const h = makeTestDeps({ adapters: { claude }, now: new Date("2026-10-12T12:00:00.000Z") });
  return { h, claude };
}

async function smokeIssue(h: TestHarness) {
  h.gh.addIssue({ title: "[스모크]", labels: ["source:smoke"] });
  await h.deps.runs.append({
    ...stepRecord("smoke", 1, null, false, "smoke_failed"),
    ts: "2026-10-12T10:00:00.000Z",
    detail: "expected getByRole('heading', { name: 'conduit' })",
  });
}

const args = (over: Partial<PostmortemArgs> = {}): PostmortemArgs => ({
  issue: 1,
  kind: "smoke",
  event: "detected",
  ...over,
});
const run = (h: TestHarness, a: PostmortemArgs) =>
  runPhase(postmortemStage, "all", h.deps, a, null);
const pmRecords = async (h: TestHarness) =>
  (await h.deps.runs.since(new Date(0))).filter((r) => r.role === "postmortem");
const bodyOf = async (h: TestHarness, n = 1) => (await h.gh.listComments(n)).map((c) => c.body);

describe("postmortem stage", () => {
  it("analyzes a new smoke incident and posts one postmortem comment", async () => {
    const { h, claude } = setup();
    await smokeIssue(h);
    await run(h, args());
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]).toMatchObject({
      role: "postmortem",
      readOnly: true,
      budget: { maxTurns: 20, timeoutMs: 900_000, maxUsd: 2 },
    });
    const comments = await bodyOf(h);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("## 요약");
    expect(comments[0]).toContain("[사실] PR 65가 홈 제목을 지웠다");
    expect(comments[0]).toContain(`<!-- ${POSTMORTEM_MARKER} {"key":"1#1","phase":"initial"} -->`);
    expect(claude.calls[0]!.prompt).toContain("<timeline>");
  });

  it("does nothing for a duplicate dispatch of the same incident and phase", async () => {
    const { h, claude } = setup();
    await smokeIssue(h);
    await run(h, args());
    await run(h, args());
    expect(claude.calls).toHaveLength(1);
    expect(await bodyOf(h)).toHaveLength(1);
    expect(await pmRecords(h)).toHaveLength(1);
  });

  it("updates the same comment on the followup analysis", async () => {
    const { h, claude } = setup();
    await smokeIssue(h);
    await run(h, args());
    const before = (await h.gh.listComments(1))[0]!;
    await h.deps.runs.append({
      ...stepRecord("smoke", 1, null, true),
      ts: "2026-10-12T11:00:00.000Z",
    });
    await run(h, args({ event: "recovered" }));
    expect(claude.calls).toHaveLength(2);
    const after = (await h.gh.listComments(1)).filter((c) => c.body.includes(POSTMORTEM_MARKER));
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.body).toContain('"phase":"followup"');
  });

  it("keeps the initial record and skips the followup agent when the per-incident limit is reached", async () => {
    const { h, claude } = setup();
    h.deps.postmortem = {
      ...h.deps.postmortem,
      budget: { ...h.deps.postmortem.budget, perIncidentAnalyses: 1 },
    };
    await smokeIssue(h);
    await run(h, args());
    await h.deps.runs.append({
      ...stepRecord("smoke", 1, null, true),
      ts: "2026-10-12T11:00:00.000Z",
    });
    await run(h, args({ event: "recovered" }));
    expect(claude.calls).toHaveLength(1);
    const comments = await bodyOf(h);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("[사실] PR 65가 홈 제목을 지웠다");
    expect(await pmRecords(h)).toMatchObject([
      { ok: true, incident: { phase: "initial" } },
      { ok: false, engine: null, incident: { phase: "followup" } },
    ]);
  });

  it("says the analysis was skipped when the limit blocks the first analysis", async () => {
    const { h, claude } = setup();
    h.deps.postmortem = {
      ...h.deps.postmortem,
      budget: { ...h.deps.postmortem.budget, perIncidentAnalyses: 1 },
    };
    await smokeIssue(h);
    await h.deps.runs.append({
      ts: "2026-10-12T10:30:00.000Z",
      issue: 1,
      pr: null,
      role: "postmortem",
      engine: "claude",
      model: "m",
      ok: false,
      turns: 1,
      costUsd: 0.1,
      durationMs: 1,
      failureReason: "timeout",
      round: 0,
      incident: {
        key: "1#1",
        kind: "smoke",
        phase: "followup",
        detectedAt: "2026-10-12T10:00:00.000Z",
        recoveredAt: null,
        causePr: null,
        reverted: false,
        classification: null,
      },
    });
    await run(h, args());
    expect(claude.calls).toHaveLength(0);
    expect((await bodyOf(h))[0]).toContain("분석 생략");
  });

  it("skips the agent when today's postmortem cost reached the daily cap, even for a flapping smoke", async () => {
    const { h, claude } = setup();
    await smokeIssue(h);
    // 오늘(UTC) 다른 장애들이 이미 10 USD를 썼다.
    await h.deps.runs.append({
      ts: "2026-10-12T05:00:00.000Z",
      issue: 99,
      pr: null,
      role: "postmortem",
      engine: "claude",
      model: "m",
      ok: true,
      turns: 1,
      costUsd: 10,
      durationMs: 1,
      failureReason: null,
      round: 0,
    });
    await run(h, args());
    expect(claude.calls).toHaveLength(0);
    const [comment] = await bodyOf(h);
    expect(comment).toContain("분석 생략");
    expect(comment).toContain("## 타임라인");
    expect((await pmRecords(h)).at(-1)).toMatchObject({ ok: false, engine: null });
    // 흔들림: 복구 뒤 다시 실패해 회차 2가 생겨도 일일 상한이 막는다.
    await h.deps.runs.append({
      ...stepRecord("smoke", 1, null, true),
      ts: "2026-10-12T10:30:00.000Z",
    });
    await h.deps.runs.append({
      ...stepRecord("smoke", 1, null, false, "smoke_failed"),
      ts: "2026-10-12T10:40:00.000Z",
    });
    await run(h, args());
    expect(claude.calls).toHaveLength(0);
    expect(await pmRecords(h)).toHaveLength(3);
  });

  it("ignores a stall whose latest reason is excluded or not listed", async () => {
    for (const reason of ["risk_t2", "permission_denied", "deploy_failed", "something_else"]) {
      const { h, claude } = setup();
      const i = h.gh.addIssue({ title: "req", labels: ["factory:needs-human"] });
      await h.deps.runs.append({
        ...stepRecord("gate", i.number, 9, false, reason),
        ts: "2026-10-12T10:00:00.000Z",
      });
      await run(h, { issue: i.number, kind: "stall", event: "detected" });
      expect(claude.calls, reason).toHaveLength(0);
      expect(await bodyOf(h, i.number), reason).toEqual([]);
    }
  });

  it("analyzes a stall whose latest reason is listed", async () => {
    const { h, claude } = setup([step({ ...ANALYSIS, classification: "stall", causePr: null })]);
    const i = h.gh.addIssue({ title: "req", labels: ["factory:needs-human"] });
    await h.deps.runs.append({
      ...stepRecord("gate", i.number, 9, false, "skip_txt"),
      ts: "2026-10-12T10:00:00.000Z",
    });
    await run(h, { issue: i.number, kind: "stall", event: "detected" });
    expect(claude.calls).toHaveLength(1);
    expect(await bodyOf(h, i.number)).toHaveLength(1);
  });

  it("ignores a production incident whose issue lacks the trigger label", async () => {
    const { h, claude } = setup();
    h.gh.addIssue({ title: "x", labels: [] });
    await run(h, args());
    expect(claude.calls).toHaveLength(0);
  });

  it("writes a dry-run replay to a new issue only", async () => {
    const { h, claude } = setup();
    await smokeIssue(h);
    await run(h, args({ dryRun: true }));
    expect(claude.calls).toHaveLength(1);
    expect(await bodyOf(h)).toEqual([]);
    expect(h.gh.dispatches).toEqual([]);
    const replay = await h.gh.getIssue(2);
    expect(replay.title).toBe("[포스트모템 재생] #1");
    expect(replay.body).toContain("## 요약");
    expect(await pmRecords(h)).toHaveLength(0);
  });

  it("records the incident fields for the dashboard", async () => {
    const { h } = setup();
    await smokeIssue(h);
    await run(h, args());
    expect(await pmRecords(h)).toMatchObject([
      {
        role: "postmortem",
        issue: 1,
        ok: true,
        engine: "claude",
        costUsd: 0.5,
        incident: {
          key: "1#1",
          kind: "smoke",
          phase: "initial",
          detectedAt: "2026-10-12T10:00:00.000Z",
          recoveredAt: null,
          causePr: 65,
          reverted: false,
          classification: "bot_regression",
        },
      },
    ]);
  });

  it("records a failed analysis and still posts the timeline with the reason", async () => {
    const { h } = setup(
      Array.from({ length: 2 }, () => ({
        result: { summary: "not json", model: "m", turns: 1, costUsd: 0.1 },
      })),
    );
    await smokeIssue(h);
    await run(h, args());
    const [comment] = await bodyOf(h);
    expect(comment).toContain("분석 생략");
    expect(await pmRecords(h)).toMatchObject([{ ok: false, failureReason: "invalid_output" }]);
  });

  it("records a crash without changing any state", async () => {
    const { h } = setup();
    await smokeIssue(h);
    const plan = await postmortemStage.prepare(h.deps, args());
    await postmortemStage.crashed(h.deps, plan!);
    expect(await pmRecords(h)).toMatchObject([{ ok: false, failureReason: "engine_error" }]);
    expect(await bodyOf(h)).toEqual([]);
    expect((await h.gh.getIssue(1)).labels).toEqual(["source:smoke"]);
  });
});

describe("postmortem revert PR", () => {
  const addCause = (
    h: TestHarness,
    files: { filename: string; additions?: string[]; deletions?: string[] }[] = [
      { filename: "apps/web/src/pages/Home.tsx", deletions: ["conduit"], additions: ["Home"] },
    ],
  ) => {
    h.gh.pulls.set(65, {
      number: 65,
      title: "feat: 홈 제목 정리",
      body: "",
      author: BOT,
      headRef: "factory/issue-60",
      headSha: "head-65",
      baseRef: "main",
      labels: [],
      draft: false,
      state: "closed",
      merged: true,
      mergedAt: "2026-10-12T08:00:00.000Z",
      files: files.map((f) => ({ additions: [], deletions: [], ...f })),
    });
    h.gh.merges.push({ pr: 65, sha: "head-65", title: "t", message: "m", mergeSha: "merge-65" });
  };
  const openPulls = (h: TestHarness) => h.gh.listOpenPulls();

  it("opens one revert PR on factory/revert-issue-N with the revert meta and trailer (#66 replay)", async () => {
    const { h } = setup();
    await smokeIssue(h);
    addCause(h);
    h.deps.settings.token = "t";
    await run(h, args());
    expect(h.git.pushes.map((p) => p.branch)).toEqual(["factory/revert-issue-1"]);
    const pulls = await openPulls(h);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.title).toBe("revert: #65 feat: 홈 제목 정리 (장애 #1)");
    expect(parsePrMeta(pulls[0]!.body)).toMatchObject({
      issue: 1,
      role: "revert",
      implementEngine: "claude",
      round: 0,
    });
    expect(h.git.reverts).toHaveLength(1);
    expect(h.git.reverts[0]!.sha).toBe("merge-65");
    expect(h.git.reverts[0]!.message).toContain("Factory-Revert: #1");
    expect(parseRevertIssues(h.git.reverts[0]!.message)).toEqual([1]);
    expect((await bodyOf(h))[0]).toContain(`되돌리기 PR #${pulls[0]!.number}`);
    expect((await pmRecords(h))[0]).toMatchObject({
      incident: { causePr: 65, reverted: true },
    });
  });

  it("restores migration files after the revert", async () => {
    const { h } = setup();
    await smokeIssue(h);
    addCause(h, [
      { filename: "apps/web/src/pages/Home.tsx", deletions: ["conduit"] },
      { filename: "apps/api/migrations/0004_x.sql" },
    ]);
    h.deps.settings.token = "t";
    await run(h, args());
    expect(h.git.restores).toEqual([
      { paths: ["apps/api/migrations/0004_x.sql"], fromSha: "merge-65" },
    ]);
    expect(await openPulls(h)).toHaveLength(1);
  });

  it("only diagnoses when the revert conflicts with later commits", async () => {
    const { h } = setup();
    await smokeIssue(h);
    addCause(h);
    h.deps.settings.token = "t";
    h.git.revertResult = null;
    await run(h, args());
    expect(await openPulls(h)).toHaveLength(0);
    expect(h.git.pushes).toEqual([]);
    expect((await bodyOf(h))[0]).toContain("되돌리기 충돌");
    expect((await pmRecords(h))[0]).toMatchObject({ incident: { reverted: false } });
  });

  it("does not revert a cause that was already reverted by hand (Review Focus 3)", async () => {
    const { h } = setup();
    await smokeIssue(h);
    addCause(h);
    h.deps.settings.token = "t";
    h.gh.pulls.set(68, {
      ...h.gh.pulls.get(65)!,
      number: 68,
      title: 'Revert "feat: 홈 제목 정리" (#65)',
      headSha: "head-68",
      mergedAt: "2026-10-12T09:00:00.000Z",
    });
    await run(h, args());
    expect(h.git.reverts).toEqual([]);
    expect(await openPulls(h)).toHaveLength(0);
    expect((await bodyOf(h))[0]).toContain("이미 되돌려졌다");
  });

  it("does not open a second revert PR while one is open", async () => {
    const { h } = setup();
    await smokeIssue(h);
    addCause(h);
    h.deps.settings.token = "t";
    h.gh.pulls.set(90, {
      number: 90,
      title: "revert",
      body: "",
      author: BOT,
      headRef: "factory/revert-issue-1",
      headSha: "h90",
      baseRef: "main",
      labels: [],
      draft: false,
      state: "open",
      merged: false,
      files: [],
    });
    await run(h, args());
    expect(h.git.reverts).toEqual([]);
    expect(await openPulls(h)).toHaveLength(1);
    expect((await bodyOf(h))[0]).toContain("#90");
  });

  it("never reverts in a dry-run replay", async () => {
    const { h } = setup();
    await smokeIssue(h);
    addCause(h);
    h.deps.settings.token = "t";
    await run(h, args({ dryRun: true }));
    expect(h.git.reverts).toEqual([]);
    expect(await openPulls(h)).toHaveLength(0);
  });

  it("does not revert on the followup analysis", async () => {
    const { h } = setup();
    await smokeIssue(h);
    addCause(h);
    h.deps.settings.token = "t";
    h.git.revertResult = null;
    await run(h, args());
    h.git.revertResult = "revert-sha";
    await h.deps.runs.append({
      ...stepRecord("smoke", 1, null, true),
      ts: "2026-10-12T11:00:00.000Z",
    });
    await run(h, args({ event: "recovered" }));
    expect(h.git.reverts).toHaveLength(1);
    expect(await openPulls(h)).toHaveLength(0);
  });
});
