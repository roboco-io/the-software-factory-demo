import { describe, expect, it } from "vitest";
import { D1BudgetRepo } from "./d1-budget";
import { D1RunRepo } from "./d1-repo";
import { REASON_CODES, STATES } from "./run-types";
import { createTestD1, readMigrations } from "./testing/d1";

function setup(migrations = readMigrations()) {
  const t = createTestD1(migrations);
  return {
    ...t,
    runs: new D1RunRepo(t.d1 as never),
    budget: new D1BudgetRepo(t.d1 as never),
  };
}
const tokens = (input: number) => ({
  inputTokens: input,
  outputTokens: 1,
  cacheReadTokens: 2,
  cacheWriteTokens: 3,
});

describe("migration 0007", () => {
  it("keeps runs, events and usage rows written before it", async () => {
    const all = readMigrations();
    const at = all.findIndex((m) =>
      m.includes("Stage 5: budget and engine switching"),
    );
    const before = all.slice(0, at);
    const t = createTestD1(before);
    t.exec(`
      INSERT INTO runs (id, repo, issue_number, state, created_at, updated_at, title, tier, head_sha)
        VALUES ('r1', 'acme/demo', 7, 'queued', 1000, 1000, 'x', 'T1', 'abc');
      INSERT INTO events (run_id, ts, kind, to_state) VALUES ('r1', 1000, 'created', 'queued');
      INSERT INTO run_usage (run_id, phase, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ts)
        VALUES ('r1', 'implement', 'claude-sonnet-5-5', 10, 1, 2, 3, 1500);
    `);
    t.exec(all[at]!);
    expect(
      t.query(
        "SELECT id, state, title, tier, head_sha, implement_model FROM runs",
      ),
    ).toEqual([
      {
        id: "r1",
        state: "queued",
        title: "x",
        tier: "T1",
        head_sha: "abc",
        implement_model: null,
      },
    ]);
    expect(t.query("SELECT COUNT(*) AS n FROM events")).toEqual([{ n: 1 }]);
    expect(t.query("SELECT run_id, input_tokens FROM run_usage")).toEqual([
      { run_id: "r1", input_tokens: 10 },
    ]);
  });

  it("accepts every state and reason code the code knows", async () => {
    const { runs, query } = setup();
    await runs.createRun(
      { id: "r1", repo: "acme/demo", issueNumber: 7, ts: 1 },
      9,
    );
    for (const state of STATES)
      await runs.transition({
        runId: "r1",
        from: "queued",
        to: state,
        code: null,
        ts: 2,
      });
    for (const code of REASON_CODES)
      await runs.transition({
        runId: "r1",
        from: "queued",
        to: "failed",
        code,
        ts: 3,
      });
    expect(query("SELECT COUNT(*) AS n FROM events")[0]).toEqual({
      n: 1 + STATES.length + REASON_CODES.length,
    });
  });

  it("does not count awaiting_engine against capacity", async () => {
    const { runs } = setup();
    await runs.createRun(
      { id: "r1", repo: "acme/demo", issueNumber: 1, ts: 1 },
      1,
    );
    await runs.transition({
      runId: "r1",
      from: "queued",
      to: "awaiting_engine",
      code: null,
      ts: 2,
    });
    expect(
      await runs.createRun(
        { id: "r2", repo: "acme/demo", issueNumber: 2, ts: 3 },
        1,
      ),
    ).toBe("created");
  });
});

describe("D1BudgetRepo", () => {
  it("sums one billing period per model", async () => {
    const { runs, budget } = setup();
    await runs.createRun(
      { id: "r1", repo: "acme/demo", issueNumber: 1, ts: 1 },
      9,
    );
    for (const [model, ts] of [
      ["claude-sonnet-5-5", 99],
      ["claude-sonnet-5-5", 100],
      ["claude-sonnet-5-5", 150],
      ["gpt-5.4-nano", 199],
      ["gpt-5.4-nano", 200],
    ] as const)
      await runs.recordUsage({
        runId: "r1",
        phase: "implement",
        model,
        ...tokens(10),
        ts,
      });
    const rows = await budget.periodUsage(100, 200);
    expect(rows).toEqual([
      {
        model: "claude-sonnet-5-5",
        usage: {
          inputTokens: 20,
          outputTokens: 2,
          cacheReadTokens: 4,
          cacheWriteTokens: 6,
        },
      },
      {
        model: "gpt-5.4-nano",
        usage: {
          inputTokens: 10,
          outputTokens: 1,
          cacheReadTokens: 2,
          cacheWriteTokens: 3,
        },
      },
    ]);
  });

  it("lists active runs with their models and usage", async () => {
    const { runs, budget } = setup();
    await runs.createRun(
      {
        id: "r1",
        repo: "acme/demo",
        issueNumber: 1,
        ts: 1,
        implementModel: "gpt-6.1-terra",
      },
      9,
    );
    await runs.createRun(
      { id: "r2", repo: "acme/demo", issueNumber: 2, ts: 1 },
      9,
    );
    await runs.transition({
      runId: "r2",
      from: "queued",
      to: "failed",
      code: null,
      ts: 2,
    });
    await runs.recordFacts({
      runId: "r1",
      reviewModel: "gpt-5.4-nano",
      singleEngine: true,
    });
    await runs.recordUsage({
      runId: "r1",
      phase: "implement",
      model: "gpt-6.1-terra",
      ...tokens(5),
      ts: 3,
    });
    expect(await budget.activeRuns()).toEqual([
      {
        id: "r1",
        state: "queued",
        implementModel: "gpt-6.1-terra",
        reviewModel: "gpt-5.4-nano",
        usage: [
          {
            phase: "implement",
            model: "gpt-6.1-terra",
            usage: {
              inputTokens: 5,
              outputTokens: 1,
              cacheReadTokens: 2,
              cacheWriteTokens: 3,
            },
          },
        ],
      },
    ]);
    expect(await budget.runUsage("r1")).toHaveLength(1);
  });

  it("claims a billing period's alert once and can release it", async () => {
    const { budget, query } = setup();
    expect(await budget.claimAlert("2026-11", 1)).toBe(true);
    expect(await budget.claimAlert("2026-11", 2)).toBe(false);
    await budget.recordAlertIssue("2026-11", 42);
    expect(query("SELECT period, issue_number FROM budget_alerts")).toEqual([
      { period: "2026-11", issue_number: 42 },
    ]);
    expect(await budget.claimAlert("2026-12", 3)).toBe(true);
    await budget.releaseAlert("2026-12");
    expect(await budget.claimAlert("2026-12", 4)).toBe(true);
  });
});

describe("D1BudgetRepo review fixes", () => {
  it("reads one phase of a run's usage", async () => {
    const { runs, budget } = setup();
    await runs.createRun(
      { id: "r1", repo: "acme/demo", issueNumber: 1, ts: 1 },
      9,
    );
    await runs.recordUsage({
      runId: "r1",
      phase: "implement",
      model: "claude-sonnet-5-5",
      ...tokens(10),
      ts: 2,
    });
    await runs.recordUsage({
      runId: "r1",
      phase: "review",
      model: "claude-haiku-5-5",
      ...tokens(7),
      ts: 3,
    });
    expect((await budget.runUsage("r1", "review")).map((u) => u.model)).toEqual(
      ["claude-haiku-5-5"],
    );
    const active = await budget.activeRuns();
    expect(active[0]!.usage.map((u) => [u.phase, u.model])).toEqual([
      ["implement", "claude-sonnet-5-5"],
      ["review", "claude-haiku-5-5"],
    ]);
  });

  it("hands out at most `max` in-flight slots per run, frees them, and expires stale ones", async () => {
    const { budget } = setup();
    const a = await budget.acquireInflight("r1", 1000, 2, 500);
    const b = await budget.acquireInflight("r1", 1000, 2, 500);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(await budget.acquireInflight("r1", 1000, 2, 500)).toBeNull();
    // Another run has its own slots.
    expect(await budget.acquireInflight("r2", 1000, 2, 500)).not.toBeNull();
    await budget.releaseInflight(a!);
    expect(await budget.acquireInflight("r1", 1000, 2, 500)).not.toBeNull();
    // A slot older than the stale age no longer counts (a crashed call).
    expect(await budget.acquireInflight("r1", 1600, 2, 500)).not.toBeNull();
  });
});

describe("operator budget limits (migration 0008)", () => {
  it("has no limits until an operator sets them, then returns the latest", async () => {
    const t = setup();
    expect(await t.budget.latestLimits()).toBeNull();
    await t.budget.recordLimits({
      ts: 1000,
      actorId: "3435720",
      anthropicUsd: 40,
      openaiUsd: 30,
      runCapUsd: 4,
    });
    await t.budget.recordLimits({
      ts: 2000,
      actorId: "3435720",
      anthropicUsd: 60,
      openaiUsd: 0,
      runCapUsd: 5.5,
    });
    expect(await t.budget.latestLimits()).toEqual({
      ts: 2000,
      actorId: "3435720",
      anthropicUsd: 60,
      openaiUsd: 0,
      runCapUsd: 5.5,
    });
  });

  it("keeps every change: rows cannot be updated or deleted", () => {
    const t = setup();
    t.exec(
      "INSERT INTO budget_limits (ts, actor_id, anthropic_usd, openai_usd, run_cap_usd) VALUES (1, 'a', 1, 1, 1)",
    );
    expect(() => t.exec("UPDATE budget_limits SET anthropic_usd = 9")).toThrow(
      /append-only/,
    );
    expect(() => t.exec("DELETE FROM budget_limits")).toThrow(/append-only/);
  });

  it("refuses a negative amount", () => {
    const t = setup();
    expect(() =>
      t.exec(
        "INSERT INTO budget_limits (ts, actor_id, anthropic_usd, openai_usd, run_cap_usd) VALUES (1, 'a', -1, 1, 1)",
      ),
    ).toThrow();
  });
});
