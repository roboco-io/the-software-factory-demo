import { describe, expect, it } from "vitest";
import { createFakeAdapter, loadFakeScript } from "../src/agents/fake";
import { TooManyFilesError } from "../src/github/port";
import { latestVerdict } from "../src/report/comments";
import { runPhase } from "../src/stages/phased";
import { heldForRisk, reviewStage, truncateDiff } from "../src/stages/review";
import { BOT, makeTestDeps, openBotPr } from "./helpers";

describe("review stage", () => {
  it("reviews with a different engine, records the verdict as a COMMENT review and dispatches the gate", async () => {
    const codex = createFakeAdapter(loadFakeScript("review-approve"), "codex");
    const h = makeTestDeps({ adapters: { codex } });
    const { pr } = await openBotPr(h);
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    expect(h.requested).toEqual(["codex/gpt-6.1-sol"]);
    expect(codex.calls[0]).toMatchObject({
      role: "review",
      readOnly: true,
      budget: { maxTurns: 30, timeoutMs: 900_000, maxUsd: 2 },
    });
    const reviews = await h.gh.listReviews(pr);
    expect(reviews[0]?.state).toBe("COMMENTED");
    expect(latestVerdict(reviews, BOT, "sha-a")?.verdict).toBe("APPROVE");
    expect(h.gh.dispatches).toEqual([{ file: "factory-merge.yml", inputs: { pr: String(pr) } }]);
  });

  it("records finding categories and trimmed messages on the review run", async () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      file: `apps/api/src/routes/r${i}.ts`,
      line: i,
      severity: i === 11 ? "blocker" : "minor",
      message: "x".repeat(400),
      category: i % 2 === 0 ? "error-format" : "style",
    }));
    const codex = createFakeAdapter(
      [
        {
          result: {
            summary: JSON.stringify({ verdict: "REQUEST_CHANGES", summary: "s", findings }),
            model: "gpt-6.1-sol",
            turns: 3,
          },
        },
      ],
      "codex",
    );
    const h = makeTestDeps({ adapters: { codex } });
    const { pr } = await openBotPr(h);
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    const review = (await h.deps.runs.since(new Date(0))).find((r) => r.role === "review")!;
    expect(review.findings).toHaveLength(10);
    expect(review.findings![0]).toMatchObject({ category: "style" });
    expect(review.findings![0]?.message).toHaveLength(300);
  });

  it("dispatches fix with the reviewed sha on REQUEST_CHANGES", async () => {
    const codex = createFakeAdapter(loadFakeScript("review-changes"), "codex");
    const h = makeTestDeps({ adapters: { codex } });
    const { pr, issue } = await openBotPr(h);
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    expect(h.gh.dispatches).toEqual([
      {
        file: "factory-fix.yml",
        inputs: { pr: String(pr), sha: "sha-a", reason: "review", issue: String(issue) },
      },
    ]);
  });

  it("uses the fallback reviewer when the PR was written by codex", async () => {
    const claude = createFakeAdapter(loadFakeScript("review-approve"), "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const { pr } = await openBotPr(h, { implementEngine: "codex", implementModel: "gpt-6.1-sol" });
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    expect(h.requested).toEqual(["claude/claude-sonnet-5-5"]);
  });

  it("does not review the same head sha twice", async () => {
    const codex = createFakeAdapter(loadFakeScript("review-approve"), "codex");
    const h = makeTestDeps({ adapters: { codex } });
    const { pr } = await openBotPr(h);
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    expect(codex.calls).toHaveLength(1);
    expect(await h.gh.listReviews(pr)).toHaveLength(1);
  });

  it("ignores human PRs and issues that are not in review", async () => {
    const codex = createFakeAdapter([], "codex");
    const h = makeTestDeps({ adapters: { codex } });
    const { pr, issue } = await openBotPr(h);
    await h.gh.removeLabel(issue, "factory:in-review");
    await h.gh.addLabels(issue, ["factory:needs-human"]);
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    h.gh.setBranch("feature/x", "s", ["a.ts"]);
    const human = await h.gh.createPull({
      title: "h",
      body: "",
      head: "feature/x",
      base: "main",
      draft: false,
    });
    h.gh.pulls.get(human)!.author = "serithemage";
    await runPhase(reviewStage, "all", h.deps, { pr: human }, null);
    expect(codex.calls).toHaveLength(0);
  });

  it("moves to needs-human when the review output stays invalid", async () => {
    const codex = createFakeAdapter(
      [{ result: { summary: "x" } }, { result: { summary: "y" } }],
      "codex",
    );
    const h = makeTestDeps({ adapters: { codex } });
    const { pr, issue } = await openBotPr(h);
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    expect((await h.gh.getIssue(issue)).labels).toContain("factory:needs-human");
    expect(h.gh.dispatches).toEqual([]);
  });

  it("truncates very large diffs", () => {
    const t = truncateDiff("d".repeat(100_000), 90_000);
    expect(t.length).toBeLessThan(90_200);
    expect(t).toContain("diff가 90000자를 넘어 잘렸다");
  });

  const reviewStep = (out: object) => ({
    result: { summary: JSON.stringify(out), model: "gpt-6.1-sol", turns: 1 },
  });
  const SMOKE = {
    file: "apps/web/src/pages/Home.tsx",
    line: 8,
    severity: "major",
    message: "e2e-smoke/home.spec.ts의 conduit 기대값이 깨진다. T3라 사람이 갱신해야 한다",
    category: "other",
  };

  it("hands the issue to a human instead of a fix round when a blocking finding needs a human (PR #65)", async () => {
    const codex = createFakeAdapter(
      [
        reviewStep({
          verdict: "REQUEST_CHANGES",
          summary: "s",
          findings: [{ ...SMOKE, needsHuman: true }],
        }),
      ],
      "codex",
    );
    const h = makeTestDeps({ adapters: { codex } });
    const { pr, issue } = await openBotPr(h);
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    expect(latestVerdict(await h.gh.listReviews(pr), BOT, "sha-a")?.verdict).toBe(
      "REQUEST_CHANGES",
    );
    // fix·merge는 보내지 않는다. 정체 포스트모템 요청만 나간다.
    expect(h.gh.dispatches.map((d) => d.file)).toEqual(["factory-postmortem.yml"]);
    expect(await h.deps.runs.since(new Date(0))).toContainEqual(
      expect.objectContaining({
        role: "review",
        issue,
        ok: false,
        failureReason: "review_needs_human",
      }),
    );
    expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
    expect((await h.gh.listComments(issue)).at(-1)?.body).toContain("e2e-smoke/home.spec.ts");
  });

  it("carries open findings into the next review and refuses an approval that leaves one unresolved (PR #65)", async () => {
    const codex = createFakeAdapter(
      [
        reviewStep({ verdict: "REQUEST_CHANGES", summary: "s", findings: [SMOKE] }),
        reviewStep({ verdict: "APPROVE", summary: "지적 사항 없음", findings: [] }),
      ],
      "codex",
    );
    const h = makeTestDeps({ adapters: { codex } });
    const { pr, branch } = await openBotPr(h);
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    h.gh.setBranch(branch, "sha-b", ["apps/api/src/routes/tags.ts"]);
    h.gh.dispatches.length = 0;
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    expect(codex.calls[1]?.prompt).toContain("conduit 기대값이 깨진다");
    const v = latestVerdict(await h.gh.listReviews(pr), BOT, "sha-b");
    expect(v?.verdict).toBe("REQUEST_CHANGES");
    expect(v?.body).toContain("이전 리뷰 지적 1");
    expect(h.gh.dispatches.map((d) => d.file)).toEqual(["factory-fix.yml"]);
  });

  it("approves when the reviewer marks every open finding from the last round as resolved", async () => {
    const codex = createFakeAdapter(
      [
        reviewStep({ verdict: "REQUEST_CHANGES", summary: "s", findings: [SMOKE] }),
        reviewStep({
          verdict: "APPROVE",
          summary: "ok",
          findings: [],
          previous: [{ index: 1, resolved: true, note: "기대값이 갱신됐다" }],
        }),
      ],
      "codex",
    );
    const h = makeTestDeps({ adapters: { codex } });
    const { pr, branch } = await openBotPr(h);
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    h.gh.setBranch(branch, "sha-b", ["apps/api/src/routes/tags.ts"]);
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    expect(latestVerdict(await h.gh.listReviews(pr), BOT, "sha-b")?.verdict).toBe("APPROVE");
  });

  it("drops the verdict when the head moved during the review", async () => {
    const codex = createFakeAdapter(loadFakeScript("review-approve"), "codex");
    const h = makeTestDeps({ adapters: { codex } });
    const { pr, branch, issue } = await openBotPr(h);
    const plan = (await reviewStage.prepare(h.deps, { pr }))!;
    const out = await reviewStage.agent(h.deps, plan);
    h.gh.setBranch(branch, "sha-b", ["apps/api/src/routes/tags.ts"]);
    await reviewStage.publish(h.deps, plan, out);
    expect(await h.gh.listReviews(pr)).toHaveLength(0);
    expect(h.gh.dispatches).toEqual([
      { file: "factory-review.yml", inputs: { pr: String(pr), issue: String(issue) } },
    ]);
  });

  it("validates the outcome and treats ok=false as no verdict", async () => {
    const codex = createFakeAdapter(loadFakeScript("review-approve"), "codex");
    const h = makeTestDeps({ adapters: { codex } });
    const { pr, issue } = await openBotPr(h);
    const plan = (await reviewStage.prepare(h.deps, { pr }))!;
    expect(() => reviewStage.parseOutcome({ review: { verdict: "MAYBE" } })).toThrow();
    const out = await reviewStage.agent(h.deps, plan);
    await reviewStage.publish(h.deps, plan, { ...out, result: { ...out.result, ok: false } });
    expect((await h.gh.getIssue(issue)).labels).toContain("factory:needs-human");
    expect(await h.gh.listReviews(pr)).toHaveLength(0);
  });

  it("posts no verdict when the checkout is not the reviewed head", async () => {
    const codex = createFakeAdapter(loadFakeScript("review-approve"), "codex");
    const h = makeTestDeps({ adapters: { codex } });
    const { pr, issue } = await openBotPr(h);
    h.git.headOverride = "sha-other";
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    expect(codex.calls).toHaveLength(0);
    expect(await h.gh.listReviews(pr)).toHaveLength(0);
    expect((await h.gh.getIssue(issue)).labels).toContain("factory:needs-human");
    expect(h.gh.dispatches).toEqual([]);
  });

  it("does not approve an empty diff", async () => {
    const codex = createFakeAdapter(loadFakeScript("review-approve"), "codex");
    const h = makeTestDeps({ adapters: { codex } });
    const { pr, issue } = await openBotPr(h);
    h.git.baseDiff = "";
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    expect((await h.gh.getIssue(issue)).labels).toContain("factory:needs-human");
    expect(codex.calls).toHaveLength(0);
    expect(await h.gh.listReviews(pr)).toHaveLength(0);
    expect(h.gh.dispatches).toEqual([]);
  });

  it("ignores a PR whose branch is not the factory branch of its issue", async () => {
    const codex = createFakeAdapter([], "codex");
    const h = makeTestDeps({ adapters: { codex } });
    const { pr } = await openBotPr(h);
    h.gh.pulls.get(pr)!.headRef = "factory/issue-999";
    await runPhase(reviewStage, "all", h.deps, { pr }, null);
    expect(codex.calls).toHaveLength(0);
  });

  describe("risk hold (spec 7.1.1)", () => {
    async function heldRun(fixture: "review-approve" | "review-changes", files: string[]) {
      const codex = createFakeAdapter(loadFakeScript(fixture), "codex");
      const h = makeTestDeps({ adapters: { codex } });
      const { pr, issue } = await openBotPr(h, {}, files);
      const plan = (await reviewStage.prepare(h.deps, { pr }))!;
      const out = await reviewStage.agent(h.deps, plan);
      // 리뷰가 도는 동안 gate가 T2·T3 PR을 needs-human으로 옮긴 상황(2026-10-11 PR #10)을 재현한다.
      await h.gh.removeLabel(issue, "factory:in-review");
      await h.gh.addLabels(issue, ["factory:needs-human"]);
      await reviewStage.publish(h.deps, plan, out);
      return { h, pr, issue };
    }

    it("posts the verdict for a T2 PR held in needs-human without changing state or dispatching", async () => {
      const { h, pr, issue } = await heldRun("review-approve", ["apps/api/migrations/0003_x.sql"]);
      expect(latestVerdict(await h.gh.listReviews(pr), BOT, "sha-a")?.verdict).toBe("APPROVE");
      expect(h.gh.dispatches).toEqual([]);
      expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
      expect(
        (await h.deps.runs.since(new Date(0))).filter((r) => r.role === "review"),
      ).toHaveLength(1);
    });

    it("posts REQUEST_CHANGES for a held PR but does not start a fix round", async () => {
      const { h, pr } = await heldRun("review-changes", ["apps/api/migrations/0003_x.sql"]);
      expect(latestVerdict(await h.gh.listReviews(pr), BOT, "sha-a")?.verdict).toBe(
        "REQUEST_CHANGES",
      );
      expect(h.gh.dispatches).toEqual([]);
    });

    it("treats a PR whose file list cannot be read as held (T3)", async () => {
      const codex = createFakeAdapter(loadFakeScript("review-approve"), "codex");
      const h = makeTestDeps({ adapters: { codex } });
      const { pr } = await openBotPr(h);
      h.gh.listPullFiles = async () => {
        throw new TooManyFilesError("too many");
      };
      expect(await heldForRisk(h.deps, pr)).toBe(true);
    });

    it("posts nothing for a T1 PR that a human moved to needs-human (e.g. @factory stop)", async () => {
      const { h, pr } = await heldRun("review-approve", ["apps/api/src/routes/tags.ts"]);
      expect(await h.gh.listReviews(pr)).toEqual([]);
      expect(h.gh.dispatches).toEqual([]);
    });
  });
});
