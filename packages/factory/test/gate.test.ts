import { describe, expect, it, vi } from "vitest";
import { TooManyFilesError } from "../src/github/port";
import { renderReviewBody } from "../src/report/comments";
import { checkState, runGate, runOnClosed } from "../src/stages/gate";
import { makeTestDeps, openBotPr, type TestHarness } from "./helpers";

export const GREEN = {
  typecheck: "success",
  lint: "success",
  unit: "success",
  "realworld-api": "success",
  e2e: "success",
  "risk-tier": "success",
  evidence: "success",
  eval: "success",
  deploy: "success",
  "e2e-preview": "success",
  "smoke-preview": "success",
};

export async function verdict(
  h: TestHarness,
  pr: number,
  sha: string,
  v: "APPROVE" | "REQUEST_CHANGES",
) {
  await h.gh.createReview(pr, {
    event: "COMMENT",
    body: renderReviewBody(
      { verdict: v, summary: "s", findings: [] },
      { sha, engine: "codex", model: "gpt-6.1-sol" },
    ),
    commitId: sha,
  });
}

describe("checkState", () => {
  it.each([
    [undefined, "pending"],
    [{ name: "e2e", status: "in_progress", conclusion: null }, "pending"],
    [{ name: "e2e", status: "completed", conclusion: "cancelled" }, "pending"],
    [{ name: "e2e", status: "completed", conclusion: "skipped" }, "pass"],
    [{ name: "e2e", status: "completed", conclusion: "success" }, "pass"],
    [{ name: "e2e", status: "completed", conclusion: "timed_out" }, "fail"],
    [{ name: "e2e", status: "completed", conclusion: "failure" }, "fail"],
  ] as const)("%j → %s", (run, expected) => {
    expect(checkState(run)).toBe(expected);
  });
});

describe("runGate", () => {
  it("waits for evidence and dispatches a ci fix when evidence fails", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    await verdict(h, pr, "sha-a", "APPROVE");
    const { evidence: _e, ...withoutEvidence } = GREEN;
    void _e;
    h.gh.setChecks("sha-a", withoutEvidence);
    expect(await runGate(h.deps, { pr })).toBe("pending");
    h.gh.setChecks("sha-a", { ...GREEN, evidence: "failure" });
    expect(await runGate(h.deps, { pr })).toBe("fix-dispatched");
    expect(h.gh.merges).toEqual([]);
  });

  it("squash-merges a green T1 PR approved at the current head, with trailers", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h);
    h.gh.setChecks("sha-a", GREEN);
    await verdict(h, pr, "sha-a", "APPROVE");
    expect(await runGate(h.deps, { pr })).toBe("merged");
    expect(h.gh.merges[0]).toMatchObject({ pr, sha: "sha-a", title: `feat: 태그 (#${pr})` });
    expect(h.gh.merges[0]?.message).toContain(
      `Agent-Signature: claude/claude-sonnet-5-5\nFactory-Issue: #${issue}`,
    );
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({ role: "gate", ok: true, pr });
  });

  it("waits for the PR preview before merging a T1 PR", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    await verdict(h, pr, "sha-a", "APPROVE");
    const { "smoke-preview": _s, ...withoutSmoke } = GREEN;
    void _s;
    h.gh.setChecks("sha-a", withoutSmoke);
    expect(await runGate(h.deps, { pr })).toBe("pending");
    h.gh.setChecks("sha-a", { ...GREEN, "e2e-preview": null });
    expect(await runGate(h.deps, { pr })).toBe("pending");
    expect(h.gh.merges).toEqual([]);
    h.gh.setChecks("sha-a", GREEN);
    expect(await runGate(h.deps, { pr })).toBe("merged");
  });

  it("hands a smoke-preview failure to a human because the agent cannot change the smoke contract", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h);
    await verdict(h, pr, "sha-a", "APPROVE");
    h.gh.setChecks("sha-a", { ...GREEN, "smoke-preview": "failure" });
    expect(await runGate(h.deps, { pr })).toBe("needs-human");
    expect(h.gh.dispatches.filter((d) => d.file !== "factory-postmortem.yml")).toEqual([]);
    expect(h.gh.merges).toEqual([]);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
    expect((await h.gh.listComments(issue))[0]?.body).toContain("스모크");
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({
      role: "gate",
      ok: false,
      failureReason: "smoke_contract",
    });
  });

  it("hands a failed preview deploy to a human instead of dispatching a fix", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    await verdict(h, pr, "sha-a", "APPROVE");
    h.gh.setChecks("sha-a", {
      ...GREEN,
      deploy: "failure",
      "e2e-preview": "skipped",
      "smoke-preview": "skipped",
    });
    expect(await runGate(h.deps, { pr })).toBe("needs-human");
    expect(h.gh.dispatches.filter((d) => d.file !== "factory-postmortem.yml")).toEqual([]);
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({
      failureReason: "preview_deploy",
    });
  });

  it("dispatches a ci fix when e2e-preview fails unless review already requested changes", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h);
    h.gh.setChecks("sha-a", { ...GREEN, "e2e-preview": "failure" });
    expect(await runGate(h.deps, { pr })).toBe("fix-dispatched");
    expect(h.gh.dispatches).toEqual([
      {
        file: "factory-fix.yml",
        inputs: { pr: String(pr), sha: "sha-a", reason: "ci", issue: String(issue) },
      },
    ]);
    await verdict(h, pr, "sha-a", "REQUEST_CHANGES");
    expect(await runGate(h.deps, { pr })).toBe("pending");
    expect(h.gh.dispatches).toHaveLength(1);
  });

  it("does not wait for preview checks on a T2 PR, whose preview is skipped until a human approves", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h, {}, ["apps/api/migrations/0002_x.sql"]);
    const { deploy: _d, "e2e-preview": _e, "smoke-preview": _s, ...required } = GREEN;
    void _d;
    void _e;
    void _s;
    h.gh.setChecks("sha-a", required);
    await verdict(h, pr, "sha-a", "APPROVE");
    expect(await runGate(h.deps, { pr })).toBe("needs-human");
  });

  it("hands a PR to a human when any check on the head fails, even one outside the required list", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h);
    await verdict(h, pr, "sha-a", "APPROVE");
    h.gh.setChecks("sha-a", { ...GREEN, "Analyze (actions)": "failure" });
    expect(await runGate(h.deps, { pr })).toBe("needs-human");
    expect(h.gh.merges).toEqual([]);
    expect(h.gh.dispatches.filter((d) => d.file !== "factory-postmortem.yml")).toEqual([]);
    expect((await h.gh.listComments(issue))[0]?.body).toContain("Analyze (actions)");
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({
      failureReason: "unlisted_check",
    });
  });

  it("hands a PR to a human when its author declared an action only a human can take (PR #65)", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h, {
      humanActions: ["apps/web/e2e-smoke/home.spec.ts의 heading 기대값을 conveyor로 갱신해야 한다"],
    });
    await verdict(h, pr, "sha-a", "APPROVE");
    h.gh.setChecks("sha-a", GREEN);
    expect(await runGate(h.deps, { pr })).toBe("needs-human");
    expect(h.gh.merges).toEqual([]);
    expect((await h.gh.listComments(issue))[0]?.body).toContain("e2e-smoke/home.spec.ts");
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({
      failureReason: "human_action",
    });
  });

  it("finds the PR by branch for workflow_run events", async () => {
    const h = makeTestDeps();
    const { pr, branch } = await openBotPr(h);
    h.gh.setChecks("sha-a", GREEN);
    await verdict(h, pr, "sha-a", "APPROVE");
    expect(await runGate(h.deps, { branch })).toBe("merged");
  });

  it("waits without a verdict, with a verdict for an older sha, or with checks still pending", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    h.gh.setChecks("sha-a", GREEN);
    expect(await runGate(h.deps, { pr })).toBe("pending");
    await verdict(h, pr, "old-sha", "APPROVE");
    expect(await runGate(h.deps, { pr })).toBe("pending");
    await verdict(h, pr, "sha-a", "APPROVE");
    h.gh.setChecks("sha-a", { ...GREEN, e2e: "cancelled" });
    expect(await runGate(h.deps, { pr })).toBe("pending");
    const { "risk-tier": _omit, ...withoutRisk } = GREEN;
    void _omit;
    h.gh.setChecks("sha-a", withoutRisk);
    expect(await runGate(h.deps, { pr })).toBe("pending");
    expect(h.gh.merges).toEqual([]);
    expect(h.gh.dispatches).toEqual([]);
  });

  it("dispatches a CI fix for a failing check unless review already requested changes", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h);
    h.gh.setChecks("sha-a", { ...GREEN, unit: "failure" });
    expect(await runGate(h.deps, { pr })).toBe("fix-dispatched");
    expect(h.gh.dispatches).toEqual([
      {
        file: "factory-fix.yml",
        inputs: { pr: String(pr), sha: "sha-a", reason: "ci", issue: String(issue) },
      },
    ]);
    await verdict(h, pr, "sha-a", "REQUEST_CHANGES");
    expect(await runGate(h.deps, { pr })).toBe("pending");
    expect(h.gh.dispatches).toHaveLength(1);
  });

  it("sends a failing risk-tier check to a human", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h);
    h.gh.setChecks("sha-a", { ...GREEN, "risk-tier": "failure" });
    expect(await runGate(h.deps, { pr })).toBe("needs-human");
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
  });

  it("never merges a T2 PR and asks for CODEOWNERS approval once", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h, {}, [
      "apps/api/migrations/0002_favorites.sql",
      "apps/api/src/routes/favorites.ts",
    ]);
    h.gh.setChecks("sha-a", GREEN);
    await verdict(h, pr, "sha-a", "APPROVE");
    expect(await runGate(h.deps, { pr })).toBe("needs-human");
    expect(await runGate(h.deps, { pr })).toBe("ignored");
    expect(h.gh.merges).toEqual([]);
    const comments = await h.gh.listComments(issue);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("CODEOWNERS");
    expect(comments[0]?.body).toContain("apps/api/migrations/0002_favorites.sql");
  });

  it("waits for the cross review before handing a T2 PR to a human, so REQUEST_CHANGES gets a fix round", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h, {}, ["apps/api/migrations/0002_favorites.sql"]);
    h.gh.setChecks("sha-a", GREEN);
    expect(await runGate(h.deps, { pr })).toBe("pending");
    await verdict(h, pr, "sha-a", "REQUEST_CHANGES");
    expect(await runGate(h.deps, { pr })).toBe("pending");
    // 리뷰 publish가 fix를 보내므로 gate는 이슈를 in-review에 두고 아무것도 보내지 않는다.
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:in-review"]);
    expect(await h.gh.listComments(issue)).toEqual([]);
    expect(h.gh.dispatches).toEqual([]);
    expect(h.gh.merges).toEqual([]);
  });

  it("hands a T3 PR to a human without waiting for the review", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h, {}, ["packages/factory/src/x.ts"]);
    h.gh.setChecks("sha-a", GREEN);
    expect(await runGate(h.deps, { pr })).toBe("needs-human");
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
  });

  it("treats a rename out of a T3 path as T3 and never merges it", async () => {
    const h = makeTestDeps();
    const { pr, branch, issue } = await openBotPr(h);
    h.gh.setBranch(branch, "sha-a", [
      {
        filename: "apps/api/src/x.ts",
        previousFilename: "packages/factory/src/x.ts",
        additions: [],
      },
    ]);
    h.gh.setChecks("sha-a", GREEN);
    await verdict(h, pr, "sha-a", "APPROVE");
    expect(await runGate(h.deps, { pr })).toBe("needs-human");
    expect(h.gh.merges).toEqual([]);
    expect((await h.gh.listComments(issue))[0]?.body).toContain("packages/factory/src/x.ts");
  });

  it("sends a PR with too many files to a human instead of merging", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h);
    h.gh.setChecks("sha-a", GREEN);
    await verdict(h, pr, "sha-a", "APPROVE");
    vi.spyOn(h.gh, "listPullFiles").mockRejectedValue(new TooManyFilesError("3000"));
    expect(await runGate(h.deps, { pr })).toBe("needs-human");
    expect(h.gh.merges).toEqual([]);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
  });

  it("does not merge when the head moved after the verdict (verdict bound to sha)", async () => {
    const h = makeTestDeps();
    const { pr, branch } = await openBotPr(h);
    await verdict(h, pr, "sha-a", "APPROVE");
    h.gh.setBranch(branch, "sha-b", ["apps/api/src/routes/tags.ts"]);
    h.gh.setChecks("sha-b", GREEN);
    expect(await runGate(h.deps, { pr })).toBe("pending");
    expect(h.gh.merges).toEqual([]);
  });

  it("refuses a skip.txt change it cannot verify even if risk-tier passed (F21)", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h, {}, [
      { filename: "tests/realworld/skip.txt", additions: [], additionCount: 2, patchMissing: true },
    ]);
    h.gh.setChecks("sha-a", GREEN);
    await verdict(h, pr, "sha-a", "APPROVE");
    expect(await runGate(h.deps, { pr })).toBe("needs-human");
    expect(h.gh.merges).toEqual([]);
  });

  it("records a run for the T2 hand-off", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h, {}, ["apps/api/migrations/0002_x.sql"]);
    h.gh.setChecks("sha-a", GREEN);
    await verdict(h, pr, "sha-a", "APPROVE");
    await runGate(h.deps, { pr });
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({
      role: "gate",
      ok: false,
      failureReason: "risk_t2",
    });
  });

  it("ignores PRs that do not target main", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    h.gh.pulls.get(pr)!.baseRef = "release";
    h.gh.setChecks("sha-a", GREEN);
    await verdict(h, pr, "sha-a", "APPROVE");
    expect(await runGate(h.deps, { pr })).toBe("ignored");
    expect(h.gh.merges).toEqual([]);
  });

  it("merges a green docs-only T0 PR without a verdict, but not over REQUEST_CHANGES", async () => {
    const h = makeTestDeps();
    const a = await openBotPr(h, {}, ["docs/guide.md"]);
    h.gh.setChecks("sha-a", GREEN);
    expect(await runGate(h.deps, { pr: a.pr })).toBe("merged");
    const h2 = makeTestDeps();
    const b = await openBotPr(h2, {}, ["docs/guide.md"]);
    h2.gh.setChecks("sha-a", GREEN);
    await verdict(h2, b.pr, "sha-a", "REQUEST_CHANGES");
    expect(await runGate(h2.deps, { pr: b.pr })).toBe("pending");
  });

  it("asks a human when GitHub refuses the merge", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h);
    h.gh.setChecks("sha-a", GREEN);
    await verdict(h, pr, "sha-a", "APPROVE");
    h.gh.mergeResult = false;
    expect(await runGate(h.deps, { pr })).toBe("merge-failed");
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
  });

  it("leaves improvement PRs to a human even when every check passes", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h, { role: "improve" });
    h.gh.setChecks("sha-a", GREEN);
    await verdict(h, pr, "sha-a", "APPROVE");
    expect(await runGate(h.deps, { pr })).toBe("ignored");
    expect(h.gh.merges).toEqual([]);
    expect(h.logs).toContain(`gate: 개선 PR #${pr}은 사람이 병합한다`);
  });

  it("ignores PRs whose issue is not in review", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h);
    await h.gh.removeLabel(issue, "factory:in-review");
    await h.gh.addLabels(issue, ["factory:in-progress"]);
    h.gh.setChecks("sha-a", { ...GREEN, unit: "failure" });
    expect(await runGate(h.deps, { pr })).toBe("ignored");
    expect(h.gh.dispatches).toEqual([]);
  });
});

describe("runOnClosed", () => {
  it("moves the issue to merged only for a merged bot PR", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h);
    expect(await runOnClosed(h.deps, { pr })).toBe(false);
    h.gh.humanMerge(pr, "m");
    expect(await runOnClosed(h.deps, { pr })).toBe(true);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:merged"]);
  });

  it("sends the issue to a human when a bot PR is closed without merging", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h);
    h.gh.pulls.get(pr)!.state = "closed";
    expect(await runOnClosed(h.deps, { pr })).toBe(false);
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
    expect((await h.gh.listComments(issue))[0]?.body).toContain("병합 없이");
  });

  it("comments on the report issue without changing labels when an improvement PR closes", async () => {
    const h = makeTestDeps();
    const merged = await openBotPr(h, { role: "improve" });
    await h.gh.removeLabel(merged.issue, "factory:in-review");
    await h.gh.addLabels(merged.issue, ["factory:report"]);
    h.gh.humanMerge(merged.pr, "m");
    expect(await runOnClosed(h.deps, { pr: merged.pr })).toBe(false);
    expect((await h.gh.getIssue(merged.issue)).labels).toEqual(["factory:report"]);
    expect((await h.gh.listComments(merged.issue)).map((c) => c.body)).toEqual([
      `개선 PR #${merged.pr}이 병합되었다.`,
    ]);

    const closed = await openBotPr(h, { role: "improve" });
    h.gh.pulls.get(closed.pr)!.state = "closed";
    expect(await runOnClosed(h.deps, { pr: closed.pr })).toBe(false);
    expect((await h.gh.getIssue(closed.issue)).labels).toEqual(["factory:in-review"]);
    expect((await h.gh.listComments(closed.issue)).map((c) => c.body)).toEqual([
      `개선 PR #${closed.pr}이 병합 없이 닫혔다.`,
    ]);
  });
});
