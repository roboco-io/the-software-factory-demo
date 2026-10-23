import { describe, expect, it } from "vitest";
import { createFakeAdapter, loadFakeScript, type FakeStep } from "../src/agents/fake";
import { runCommand } from "../src/stages/command";
import { runDeployed } from "../src/stages/deploy";
import { fixStage } from "../src/stages/fix";
import { runGate, runOnClosed } from "../src/stages/gate";
import { runGuard } from "../src/stages/guard";
import { implementStage } from "../src/stages/implement";
import { runPhase } from "../src/stages/phased";
import { reviewStage } from "../src/stages/review";
import { runRisk } from "../src/stages/risk";
import { triageStage } from "../src/stages/triage";
import { BOT, makeTestDeps, type TestHarness } from "./helpers";

const GREEN = {
  typecheck: "success",
  lint: "success",
  unit: "success",
  "forum-api": "success",
  e2e: "success",
  "risk-tier": "success",
  evidence: "success",
  eval: "success",
  codeql: "success",
  "deps-audit": "success",
  secrets: "success",
  deploy: "success",
  "e2e-preview": "success",
  "smoke-preview": "success",
};

const TAGS: FakeStep = {
  writeFiles: {
    "apps/api/src/routes/tags.ts": "export const tagsRouter = 1;\n",
    "apps/api/test/deferred.test.ts": "// tags는 이제 200을 반환한다\n",
    "tests/forum/skip.txt": "reports.hurl\nvotes.hurl\n",
  },
  result: { summary: "GET /api/tags 구현, skip.txt에서 tags.hurl 제거", turns: 25, costUsd: 0.9 },
};

const FAVORITES: FakeStep = {
  writeFiles: {
    "apps/api/migrations/0002_favorites.sql":
      "CREATE TABLE favorites (user_id INTEGER, article_id INTEGER);\n",
    "apps/api/src/routes/favorites.ts": "export const favoritesRouter = 1;\n",
    "tests/forum/skip.txt": "reports.hurl\n",
  },
  result: { summary: "즐겨찾기 구현" },
};

const labels = async (h: TestHarness, n: number) => (await h.gh.getIssue(n)).labels;

describe("factory flow with fake engines (spec 8장)", () => {
  it("takes a T1 feature from a new issue to deployed with no human step after @factory go", async () => {
    const pi = createFakeAdapter(loadFakeScript("triage-feature"), "pi");
    const claude = createFakeAdapter([TAGS], "claude");
    const codex = createFakeAdapter(loadFakeScript("review-approve"), "codex");
    const h = makeTestDeps({ adapters: { pi, claude, codex } });
    h.gh.permissions.set("outsider", "read");
    const issue = h.gh.addIssue({
      title: "태그 목록 API",
      body: "GET /api/tags",
      author: "outsider",
    }).number;

    await runPhase(triageStage, "all", h.deps, { issue }, null);
    expect(await labels(h, issue)).toContain("factory:triaged");
    expect(await runCommand(h.deps, { issue, actor: "outsider", body: "@factory go" })).toBe(
      "rejected",
    );
    expect(await labels(h, issue)).not.toContain("factory:approved");
    expect(await runCommand(h.deps, { issue, actor: "serithemage", body: "@factory go" })).toBe(
      "approved",
    );

    await runPhase(implementStage, "all", h.deps, { issue, sender: BOT }, null);
    const pr = (await h.gh.findOpenPullByHead(`factory/issue-${issue}`))!;
    expect(pr.labels).toEqual(["risk:T1"]);
    expect((await runRisk(h.deps, { pr: pr.number, check: true })).previewAllowed).toBe(true);

    await runPhase(reviewStage, "all", h.deps, { pr: pr.number }, null);
    expect(h.gh.dispatches.at(-1)).toEqual({
      file: "factory-merge.yml",
      inputs: { pr: String(pr.number) },
    });
    h.gh.setChecks(pr.headSha, GREEN);
    expect(await runGate(h.deps, { pr: pr.number })).toBe("merged");
    expect(await runOnClosed(h.deps, { pr: pr.number })).toBe(true);
    expect(await runDeployed(h.deps, { sha: h.gh.merges[0]!.mergeSha })).toEqual([issue]);

    const final = await h.gh.getIssue(issue);
    expect(final.state).toBe("closed");
    expect(final.labels).toContain("factory:deployed");
    expect((await h.deps.runs.since(new Date(0))).map((r) => r.role)).toEqual([
      "triage",
      "command",
      "command",
      "implement",
      "review",
      "gate",
      "deploy",
    ]);
  });

  it("escalates to needs-human when review requests changes more than three times", async () => {
    const codex = createFakeAdapter(
      Array.from({ length: 4 }, () => loadFakeScript("review-changes")).flat(),
      "codex",
    );
    const claude = createFakeAdapter(
      [
        TAGS,
        ...[1, 2, 3].map((n) => ({
          writeFiles: { "apps/api/src/routes/tags.ts": `export const tagsRouter = ${n + 1};\n` },
        })),
      ],
      "claude",
    );
    const h = makeTestDeps({ adapters: { claude, codex } });
    const issue = h.gh.addIssue({ title: "태그 목록 API", labels: ["factory:approved"] }).number;
    await runPhase(implementStage, "all", h.deps, { issue, sender: BOT }, null);
    const pr = (await h.gh.findOpenPullByHead(`factory/issue-${issue}`))!.number;
    for (let i = 0; i < 4; i++) {
      await runPhase(reviewStage, "all", h.deps, { pr }, null);
      const d = h.gh.dispatches.at(-1)!;
      expect(d.file).toBe("factory-fix.yml");
      await runPhase(fixStage, "all", h.deps, { pr, sha: d.inputs.sha!, reason: "review" }, null);
    }
    expect(claude.calls.filter((c) => c.role === "fix")).toHaveLength(3);
    expect(await labels(h, issue)).toContain("factory:needs-human");
    expect((await h.gh.getPull(pr)).labels).toContain("factory:round-3");
    expect(h.gh.merges).toEqual([]);
  });

  it("holds a T2 migration PR for a human, skips its preview, and deploys after the human merges", async () => {
    const claude = createFakeAdapter([FAVORITES], "claude");
    const codex = createFakeAdapter(loadFakeScript("review-approve"), "codex");
    const h = makeTestDeps({ adapters: { claude, codex } });
    const issue = h.gh.addIssue({ title: "즐겨찾기", labels: ["factory:approved"] }).number;
    await runPhase(implementStage, "all", h.deps, { issue, sender: BOT }, null);
    const pr = (await h.gh.findOpenPullByHead(`factory/issue-${issue}`))!;
    expect(pr.labels).toEqual(["risk:T2"]);
    expect(pr.body).toContain("프리뷰를 만들지 않는다");
    expect((await runRisk(h.deps, { pr: pr.number, check: true })).previewAllowed).toBe(false);
    await runPhase(reviewStage, "all", h.deps, { pr: pr.number }, null);
    h.gh.setChecks(pr.headSha, GREEN);
    expect(await runGate(h.deps, { pr: pr.number })).toBe("needs-human");
    expect(h.gh.merges).toEqual([]);

    const sha = h.gh.humanMerge(
      pr.number,
      `feat: 즐겨찾기 (#${pr.number})\n\n* ${h.git.messages[0]}`,
    );
    expect(await runOnClosed(h.deps, { pr: pr.number })).toBe(true);
    expect(await runDeployed(h.deps, { sha })).toEqual([issue]);
    expect(await labels(h, issue)).toContain("factory:deployed");
    expect(await labels(h, issue)).not.toContain("factory:needs-human");
    expect((await h.gh.getIssue(issue)).state).toBe("closed");
  });

  it("keeps triaging but stops starting implement runs after the breaker trips", async () => {
    const pi = createFakeAdapter(loadFakeScript("triage-feature"), "pi");
    const claude = createFakeAdapter([], "claude");
    const h = makeTestDeps({ adapters: { pi, claude } });
    for (let i = 0; i < 10; i++) {
      await h.deps.runs.append({
        ts: "2026-10-11T10:00:00.000Z",
        issue: 50,
        pr: null,
        role: "implement",
        engine: "claude",
        model: "m",
        ok: false,
        turns: 1,
        costUsd: null,
        durationMs: 1,
        failureReason: "timeout",
        round: 0,
      });
    }
    expect((await runGuard(h.deps)).paused).toBe(true);
    h.deps.settings.paused = h.gh.variables.get("FACTORY_PAUSED") === "true";
    const issue = h.gh.addIssue({ title: "새 기능", author: "serithemage" }).number;
    await runPhase(triageStage, "all", h.deps, { issue }, null);
    expect(await labels(h, issue)).toContain("factory:triaged");
    await runCommand(h.deps, { issue, actor: "serithemage", body: "@factory go" });
    await runPhase(implementStage, "all", h.deps, { issue, sender: BOT }, null);
    expect(claude.calls).toHaveLength(0);
    expect(await labels(h, issue)).toContain("factory:approved");
    const alerts = (await h.gh.listOpenIssues()).filter((i) => i.labels.includes("factory:alert"));
    expect(alerts).toHaveLength(1);
    expect((await h.gh.listComments(issue)).some((c) => c.body.includes("FACTORY_PAUSED"))).toBe(
      true,
    );
  });
});
