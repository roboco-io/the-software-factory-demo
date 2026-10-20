import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUG_RULE, NOT_BUG_RULE } from "../src/agents/prompt";
import { createFakeAdapter, loadFakeScript, type FakeStep } from "../src/agents/fake";
import { renderTriageComment } from "../src/report/comments";
import { parsePrMeta } from "../src/report/pr";
import { implementStage } from "../src/stages/implement";
import { runPhase } from "../src/stages/phased";
import { BOT, makeTestDeps, scriptedSpawn, type TestHarness } from "./helpers";

const TAGS: FakeStep = {
  writeFiles: {
    "apps/api/src/routes/tags.ts": "export const tags = 1;\n",
    "tests/realworld/skip.txt": "favorites.hurl\nfeed.hurl\nprofiles.hurl\n",
  },
  result: {
    summary: "GET /api/tags 구현\n남은 위험: 태그가 많으면 응답이 커진다",
    turns: 30,
    costUsd: 1.2,
  },
};

function approvedIssue(
  h: TestHarness,
  labels = ["factory:approved", "type:feature"],
  contractChanges?: string[],
): number {
  const issue = h.gh.addIssue({ title: "태그 목록 API", body: "GET /api/tags를 구현한다", labels });
  h.gh.addComment(
    issue.number,
    BOT,
    renderTriageComment(
      {
        type: "feature",
        duplicateOf: null,
        riskTier: "T1",
        acceptanceCriteria: ["GET /api/tags가 태그 목록을 반환한다"],
        summary: "s",
        ...(contractChanges ? { contractChanges } : {}),
      },
      { engine: "pi", model: "deepseek/deepseek-flash" },
    ),
  );
  return issue.number;
}

const run = (h: TestHarness, issue: number, sender?: string) =>
  runPhase(implementStage, "all", h.deps, sender ? { issue, sender } : { issue }, null);

const lastComment = async (h: TestHarness, n: number) =>
  (await h.gh.listComments(n)).at(-1)?.body ?? "";

describe("implement stage", () => {
  it("tells the agent which protected contracts to report as human actions", async () => {
    const agent = createFakeAdapter([TAGS], "claude");
    const h = makeTestDeps({ adapters: { claude: agent } });
    await run(
      h,
      approvedIssue(h, undefined, ["apps/web/e2e-smoke/home.spec.ts: heading 기대값"]),
      BOT,
    );
    expect(agent.calls[0]?.prompt).toContain("apps/web/e2e-smoke/home.spec.ts: heading 기대값");
    expect(agent.calls[0]?.prompt).toContain("사람 조치 필요:");
  });

  it("puts the reproduction-test rule into the prompt of type:bug issues only", async () => {
    const bugAgent = createFakeAdapter([TAGS], "claude");
    const bugH = makeTestDeps({ adapters: { claude: bugAgent } });
    await run(bugH, approvedIssue(bugH, ["factory:approved", "type:bug"]), BOT);
    expect(bugAgent.calls[0]?.prompt).toContain(BUG_RULE);

    const featureAgent = createFakeAdapter([TAGS], "claude");
    const featureH = makeTestDeps({ adapters: { claude: featureAgent } });
    await run(featureH, approvedIssue(featureH), BOT);
    expect(featureAgent.calls[0]?.prompt).toContain(NOT_BUG_RULE);
    expect(featureAgent.calls[0]?.prompt).not.toContain(BUG_RULE);
  });

  it("implements, checks, commits with trailers, opens a T1 PR and moves to in-review", async () => {
    const claude = createFakeAdapter([TAGS], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const n = approvedIssue(h);
    await run(h, n, BOT);
    const pr = await h.gh.findOpenPullByHead(`factory/issue-${n}`);
    expect(pr).not.toBeNull();
    expect(pr!.draft).toBe(false);
    expect(pr!.labels).toEqual(["risk:T1"]);
    expect(pr!.title).toBe(`feat: 태그 목록 API (#${n})`);
    expect(parsePrMeta(pr!.body)).toEqual({
      issue: n,
      role: "implement",
      implementEngine: "claude",
      implementModel: "claude-sonnet-5-5",
      round: 0,
    });
    expect(pr!.body).toContain(`pr-preview/pr-${pr!.number}/`);
    expect(pr!.body).toContain("태그가 많으면 응답이 커진다");
    expect(h.git.messages[0]).toContain(
      "Agent-Signature: claude/claude-sonnet-5-5\nFactory-Issue: #1",
    );
    expect(h.git.pushes.map((p) => p.branch)).toEqual([`factory/issue-${n}`]);
    expect(h.gh.dispatches).toEqual([
      { file: "factory-review.yml", inputs: { pr: String(pr!.number), issue: String(n) } },
    ]);
    expect((await h.gh.getIssue(n)).labels).toEqual(["type:feature", "factory:in-review"]);
    expect(claude.calls[0]).toMatchObject({
      role: "implement",
      readOnly: false,
      budget: { maxTurns: 80, timeoutMs: 1_800_000, maxUsd: 5 },
    });
    expect(claude.calls[0]?.prompt).toContain("- GET /api/tags가 태그 목록을 반환한다");
    expect(await h.deps.runs.since(new Date(0))).toMatchObject([
      { role: "implement", engine: "claude", ok: true, turns: 30, costUsd: 1.2 },
    ]);
  });

  it("writes a bundle in the agent phase when FACTORY_BUNDLE is set", async () => {
    const h = makeTestDeps({
      adapters: { claude: createFakeAdapter([TAGS], "claude") },
      settings: { bundlePath: "/tmp/work.bundle" },
    });
    const n = approvedIssue(h);
    await run(h, n, BOT);
    expect(h.git.bundles).toEqual(["/tmp/work.bundle"]);
  });

  it("removes a factory:approved label added by a user without write permission", async () => {
    const claude = createFakeAdapter([], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    h.gh.permissions.set("mallory", "triage");
    const n = approvedIssue(h, ["factory:triaged", "factory:approved"]);
    await run(h, n, "mallory");
    expect((await h.gh.getIssue(n)).labels).toEqual(["factory:triaged"]);
    expect(await lastComment(h, n)).toContain("@mallory");
    expect(claude.calls).toHaveLength(0);
  });

  it("does nothing for a late label event on an issue that already moved on", async () => {
    const claude = createFakeAdapter([], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const n = approvedIssue(h, ["factory:in-review"]);
    await run(h, n, BOT);
    expect(claude.calls).toHaveLength(0);
    expect((await h.gh.getIssue(n)).labels).toEqual(["factory:in-review"]);
  });

  it("stays approved with a comment when paused or over the daily limit", async () => {
    const paused = makeTestDeps({
      adapters: { claude: createFakeAdapter([], "claude") },
      settings: { paused: true },
    });
    const p = approvedIssue(paused);
    await run(paused, p, BOT);
    expect((await paused.gh.getIssue(p)).labels).toContain("factory:approved");
    expect(await lastComment(paused, p)).toContain("FACTORY_PAUSED");

    const limited = makeTestDeps({ adapters: { claude: createFakeAdapter([], "claude") } });
    for (let i = 0; i < 20; i++) {
      await limited.deps.runs.append({
        ts: "2026-10-12T01:00:00.000Z",
        issue: 99,
        pr: null,
        role: i % 2 ? "fix" : "implement",
        engine: "claude",
        model: "m",
        ok: true,
        turns: 1,
        costUsd: null,
        durationMs: 1,
        failureReason: null,
        round: 0,
      });
    }
    const l = approvedIssue(limited);
    await run(limited, l, BOT);
    expect((await limited.gh.getIssue(l)).labels).toContain("factory:approved");
    expect(await lastComment(limited, l)).toContain("일일 상한 20회");
  });

  it("moves to needs-human without a PR when the agent exceeds its budget", async () => {
    const claude = createFakeAdapter(loadFakeScript("implement-budget-exceeded"), "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const n = approvedIssue(h);
    await run(h, n, BOT);
    expect((await h.gh.getIssue(n)).labels).toContain("factory:needs-human");
    expect(await lastComment(h, n)).toContain("비용 예산 초과");
    expect(h.git.pushes).toEqual([]);
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({
      ok: false,
      failureReason: "budget",
    });
  });

  it("discards changes that touch T3 paths", async () => {
    const claude = createFakeAdapter(
      [{ writeFiles: { ".github/workflows/x.yml": "on: push\n", "apps/a.ts": "a\n" } }],
      "claude",
    );
    const h = makeTestDeps({ adapters: { claude } });
    const n = approvedIssue(h);
    await run(h, n, BOT);
    expect((await h.gh.getIssue(n)).labels).toContain("factory:needs-human");
    expect(await lastComment(h, n)).toContain(".github/workflows/x.yml");
    expect(h.git.pushes).toEqual([]);
  });

  it("runs one in-run fix when local checks fail, then opens a normal PR", async () => {
    const claude = createFakeAdapter(
      [TAGS, { writeFiles: { "apps/api/src/routes/tags.ts": "export const tags = 2;\n" } }],
      "claude",
    );
    const h = makeTestDeps({ adapters: { claude }, spawn: scriptedSpawn({ lint: [1] }) });
    const n = approvedIssue(h);
    await run(h, n, BOT);
    expect(claude.calls[1]).toMatchObject({
      role: "fix",
      budget: { maxTurns: 40, timeoutMs: 1_200_000, maxUsd: 3 },
    });
    expect(claude.calls[1]?.prompt).toContain("### pnpm lint 실패");
    expect((await h.gh.findOpenPullByHead(`factory/issue-${n}`))?.draft).toBe(false);
    expect((await h.deps.runs.since(new Date(0))).map((r) => r.role)).toEqual(["implement", "fix"]);
  });

  it("opens a draft PR and asks a human when checks still fail after the in-run fix", async () => {
    const claude = createFakeAdapter([TAGS, {}], "claude");
    const h = makeTestDeps({ adapters: { claude }, spawn: scriptedSpawn({ test: [1, 1] }) });
    const n = approvedIssue(h);
    await run(h, n, BOT);
    expect((await h.gh.findOpenPullByHead(`factory/issue-${n}`))?.draft).toBe(true);
    expect((await h.gh.getIssue(n)).labels).toContain("factory:needs-human");
    expect(await lastComment(h, n)).toContain("draft PR");
  });

  it("asks a human when the agent changed nothing", async () => {
    const h = makeTestDeps({ adapters: { claude: createFakeAdapter([{}], "claude") } });
    const n = approvedIssue(h);
    await run(h, n, BOT);
    expect(await lastComment(h, n)).toContain("파일을 바꾸지 않았다");
  });

  it("moves to needs-human when the agent phase crashed", async () => {
    const h = makeTestDeps({ adapters: { claude: createFakeAdapter([], "claude") } });
    const n = approvedIssue(h);
    const dir = mkdtempSync(path.join(tmpdir(), "impl-"));
    const files = { plan: path.join(dir, "plan.json"), outcome: path.join(dir, "outcome.json") };
    await runPhase(implementStage, "prepare", h.deps, { issue: n }, files);
    await runPhase(implementStage, "publish", h.deps, { issue: n }, files);
    expect((await h.gh.getIssue(n)).labels).toContain("factory:needs-human");
    expect(await lastComment(h, n)).toContain("비정상 종료");
  });

  describe("publish trusts only the repository, not the outcome file", () => {
    async function agentPhases(h: TestHarness, n: number) {
      const dir = mkdtempSync(path.join(tmpdir(), "impl-"));
      const files = { plan: path.join(dir, "plan.json"), outcome: path.join(dir, "outcome.json") };
      await runPhase(implementStage, "prepare", h.deps, { issue: n }, files);
      await runPhase(implementStage, "agent", h.deps, { issue: n }, files);
      return files;
    }
    const readOutcome = (f: string) =>
      (JSON.parse(readFileSync(f, "utf8")) as { outcome: Record<string, unknown> }).outcome;
    const publish = (h: TestHarness, n: number, f: { plan: string; outcome: string }) =>
      runPhase(implementStage, "publish", h.deps, { issue: n }, f);

    it("treats a structurally invalid outcome as a crash", async () => {
      const h = makeTestDeps({ adapters: { claude: createFakeAdapter([TAGS], "claude") } });
      const n = approvedIssue(h);
      const files = await agentPhases(h, n);
      writeFileSync(
        files.outcome,
        JSON.stringify({ outcome: { kind: "committed", runs: "x", checks: [], summary: 1 } }),
      );
      await publish(h, n, files);
      expect((await h.gh.getIssue(n)).labels).toContain("factory:needs-human");
      expect(await lastComment(h, n)).toContain("비정상 종료");
      expect(h.git.pushes).toEqual([]);
    });

    it("rejects a T3 change hidden in the bundle even when the outcome looks clean", async () => {
      const h = makeTestDeps({ adapters: { claude: createFakeAdapter([TAGS], "claude") } });
      const n = approvedIssue(h);
      const files = await agentPhases(h, n);
      mkdirSync(path.join(h.dir, ".github/workflows"), { recursive: true });
      writeFileSync(path.join(h.dir, ".github/workflows/evil.yml"), "on: push\n");
      const sha = await h.git.commitAll("evil");
      const outcome = readOutcome(files.outcome);
      writeFileSync(files.outcome, JSON.stringify({ outcome: { ...outcome, sha } }));
      await publish(h, n, files);
      expect(h.git.pushes).toEqual([]);
      expect(await h.gh.findOpenPullByHead(`factory/issue-${n}`)).toBeNull();
      expect((await h.gh.getIssue(n)).labels).toContain("factory:needs-human");
      expect(await lastComment(h, n)).toContain(".github/workflows/evil.yml");
    });

    it("rejects an outcome whose commit SHA differs from the bundle head", async () => {
      const h = makeTestDeps({ adapters: { claude: createFakeAdapter([TAGS], "claude") } });
      const n = approvedIssue(h);
      const files = await agentPhases(h, n);
      writeFileSync(
        files.outcome,
        JSON.stringify({ outcome: { ...readOutcome(files.outcome), sha: "f".repeat(40) } }),
      );
      await publish(h, n, files);
      expect(h.git.pushes).toEqual([]);
      expect((await h.gh.getIssue(n)).labels).toContain("factory:needs-human");
      expect(await lastComment(h, n)).toContain("SHA");
    });

    it("rejects a bundle whose head does not descend from the prepared base", async () => {
      const h = makeTestDeps({ adapters: { claude: createFakeAdapter([TAGS], "claude") } });
      const n = approvedIssue(h);
      const files = await agentPhases(h, n);
      h.git.descendsFromBase = false;
      await publish(h, n, files);
      expect(h.git.pushes).toEqual([]);
      expect(await h.gh.findOpenPullByHead(`factory/issue-${n}`)).toBeNull();
      expect(await lastComment(h, n)).toContain("후손이 아니다");
    });

    it("does not publish when the issue left in-progress during the agent phase", async () => {
      const h = makeTestDeps({ adapters: { claude: createFakeAdapter([TAGS], "claude") } });
      const n = approvedIssue(h);
      const files = await agentPhases(h, n);
      await h.gh.removeLabel(n, "factory:in-progress");
      await h.gh.addLabels(n, ["factory:needs-human"]);
      await publish(h, n, files);
      expect(h.git.pushes).toEqual([]);
    });
  });

  it("reuses a draft PR on retry: marks it ready and clears stale round labels", async () => {
    const retry: FakeStep = {
      writeFiles: { "apps/api/src/routes/tags.ts": "export const tags = 3;\n" },
    };
    const claude = createFakeAdapter([TAGS, {}, retry], "claude");
    const h = makeTestDeps({ adapters: { claude }, spawn: scriptedSpawn({ test: [1, 1] }) });
    const n = approvedIssue(h);
    await run(h, n, BOT);
    const first = await h.gh.findOpenPullByHead(`factory/issue-${n}`);
    expect(first?.draft).toBe(true);
    await h.gh.addLabels(first!.number, ["factory:round-2", "risk:T2"]);
    h.gh.issues.get(n)!.labels = ["factory:approved", "type:feature"];
    await run(h, n, BOT);
    const second = await h.gh.findOpenPullByHead(`factory/issue-${n}`);
    expect(second?.number).toBe(first?.number);
    expect(second?.draft).toBe(false);
    expect(second?.labels).toEqual(["risk:T1"]);
    expect((await h.gh.getIssue(n)).labels).toContain("factory:in-review");
    expect(h.gh.dispatches).toHaveLength(1);
  });

  it("keeps a reused draft PR draft while checks still fail", async () => {
    const claude = createFakeAdapter([TAGS, {}], "claude");
    const h = makeTestDeps({ adapters: { claude }, spawn: scriptedSpawn({ test: [1, 1] }) });
    const n = approvedIssue(h);
    await run(h, n, BOT);
    expect(h.gh.dispatches).toEqual([]);
    expect((await h.gh.findOpenPullByHead(`factory/issue-${n}`))?.draft).toBe(true);
  });
});

describe("implement stage run records and commit ownership", () => {
  async function phases(h: TestHarness, n: number) {
    const dir = mkdtempSync(path.join(tmpdir(), "impl-"));
    const files = { plan: path.join(dir, "plan.json"), outcome: path.join(dir, "outcome.json") };
    await runPhase(implementStage, "prepare", h.deps, { issue: n }, files);
    await runPhase(implementStage, "agent", h.deps, { issue: n }, files);
    return files;
  }
  interface Loose {
    runs: { result: Record<string, unknown> }[];
    sha: string;
  }
  const edit = (f: string, fn: (o: Loose) => void) => {
    const doc = JSON.parse(readFileSync(f, "utf8")) as { outcome: Loose };
    fn(doc.outcome);
    writeFileSync(f, JSON.stringify(doc));
  };
  const publish = (h: TestHarness, n: number, f: { plan: string; outcome: string }) =>
    runPhase(implementStage, "publish", h.deps, { issue: n }, f);

  it("treats an outcome with no runs as a crash and records exactly one failed run", async () => {
    const h = makeTestDeps({ adapters: { claude: createFakeAdapter([TAGS], "claude") } });
    const n = approvedIssue(h);
    const files = await phases(h, n);
    edit(files.outcome, (o) => {
      o.runs = [];
    });
    await publish(h, n, files);
    expect((await h.gh.getIssue(n)).labels).toContain("factory:needs-human");
    const recs = await h.deps.runs.since(new Date(0));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ ok: false, failureReason: "engine_error" });
  });

  it("records ok=false for an agent-failed outcome even if the file forges ok=true", async () => {
    const claude = createFakeAdapter(loadFakeScript("implement-budget-exceeded"), "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const n = approvedIssue(h);
    const files = await phases(h, n);
    edit(files.outcome, (o) => {
      o.runs[0]!.result.ok = true;
      delete o.runs[0]!.result.failureReason;
    });
    await publish(h, n, files);
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({
      ok: false,
      failureReason: "budget",
    });
  });

  it("clamps forged turns and cost to the role budget", async () => {
    const h = makeTestDeps({ adapters: { claude: createFakeAdapter([TAGS], "claude") } });
    const n = approvedIssue(h);
    const files = await phases(h, n);
    edit(files.outcome, (o) => {
      o.runs[0]!.result.turns = 99999;
      o.runs[0]!.result.costUsd = 1e6;
    });
    await publish(h, n, files);
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({ turns: 80, costUsd: 5 });
  });

  it("records the implement run as failed when publish verification rejects the bundle", async () => {
    const h = makeTestDeps({ adapters: { claude: createFakeAdapter([TAGS], "claude") } });
    const n = approvedIssue(h);
    const files = await phases(h, n);
    h.git.descendsFromBase = false;
    await publish(h, n, files);
    const recs = await h.deps.runs.since(new Date(0));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ role: "implement", ok: false });
  });

  it("rejects a failureReason outside the enum", () => {
    expect(() =>
      implementStage.parseOutcome({
        kind: "agent-failed",
        runs: [
          {
            role: "implement",
            result: {
              ok: false,
              summary: "",
              model: "m",
              turns: 0,
              usage: { inputTokens: 0, outputTokens: 0 },
              durationMs: 0,
            },
          },
        ],
        reason: "constructor",
      }),
    ).toThrow();
  });

  it("replaces an agent-authored commit with a trusted one", async () => {
    const h = makeTestDeps({ adapters: { claude: createFakeAdapter([TAGS], "claude") } });
    const n = approvedIssue(h);
    const files = await phases(h, n);
    writeFileSync(path.join(h.dir, "apps/extra.ts"), "x\n");
    const sha = await h.git.commitAll("evil\n\nCo-authored-by: Mallory <m@example.com>");
    edit(files.outcome, (o) => {
      o.sha = sha;
    });
    await publish(h, n, files);
    const last = h.git.messages.at(-1) ?? "";
    expect(last).not.toContain("Mallory");
    expect(last).toContain(`Factory-Issue: #${n}`);
    expect(h.git.pushes).toHaveLength(1);
  });

  it("does not double count a run when publish throws after recording", async () => {
    const h = makeTestDeps({ adapters: { claude: createFakeAdapter([TAGS], "claude") } });
    const n = approvedIssue(h);
    h.gh.createPull = async () => {
      throw new Error("boom");
    };
    await expect(run(h, n, BOT)).rejects.toThrow("boom");
    expect((await h.deps.runs.since(new Date(0))).map((r) => [r.role, r.ok])).toEqual([
      ["implement", true],
    ]);
    expect((await h.gh.getIssue(n)).labels).toContain("factory:needs-human");
  });

  it("does not start the agent when the in-progress transition is refused", async () => {
    const claude = createFakeAdapter([], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const n = approvedIssue(h);
    h.gh.listComments = async (num: number) => {
      h.gh.issues.get(num)!.labels = ["factory:needs-human"];
      return [];
    };
    await run(h, n, BOT);
    expect(claude.calls).toHaveLength(0);
    expect((await h.gh.getIssue(n)).labels).toEqual(["factory:needs-human"]);
  });
});
