import { describe, expect, it } from "vitest";
import { budgetConfig } from "./budget";
import { BudgetService } from "./budget-service";
import { D1BudgetRepo } from "./d1-budget";
import { D1RunRepo } from "./d1-repo";
import { createTestD1, readMigrations } from "./testing/d1";

const NOW = Date.UTC(2026, 10, 15);
const LAST_MONTH = Date.UTC(2026, 9, 31);

/** Fake usage: `usd` dollars of a model, as plain input tokens at its input price. */
const PER_MILLION: Record<string, number> = {
  "claude-sonnet-5-5": 2,
  "claude-haiku-5-5": 0.5,
  "gpt-5.4-nano": 0.2,
  "gpt-6.1-terra": 1,
};

function setup(
  over: { failIssue?: boolean; env?: Record<string, string> } = {},
) {
  const t = createTestD1(readMigrations());
  const runs = new D1RunRepo(t.d1 as never);
  const issues: { repo: string; title: string; body: string }[] = [];
  const service = new BudgetService({
    repo: new D1BudgetRepo(t.d1 as never),
    config: budgetConfig(over.env ?? {}),
    now: () => NOW,
    factoryRepo: "roboco-io/the-software-factory-demo",
    issues: {
      async createIssue(repo, title, body) {
        if (over.failIssue) throw new Error("GitHub down");
        issues.push({ repo, title, body });
        return issues.length;
      },
    },
  });
  let n = 0;
  async function spend(
    model: string,
    usd: number,
    opts: { runId?: string; ts?: number } = {},
  ) {
    const runId = opts.runId ?? `past${++n}`;
    if (opts.runId === undefined) {
      await runs.createRun(
        { id: runId, repo: "acme/demo", issueNumber: 1000 + n, ts: 1 },
        99,
      );
      await runs.transition({
        runId,
        from: "queued",
        to: "merged",
        code: null,
        ts: 2,
      });
    }
    await runs.recordUsage({
      runId,
      phase: "implement",
      model,
      inputTokens: Math.round((usd / PER_MILLION[model]!) * 1_000_000),
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ts: opts.ts ?? NOW - 1000,
    });
  }
  return { t, runs, service, issues, spend };
}

describe("BudgetService.status", () => {
  it("counts only this billing period", async () => {
    const { service, spend } = setup();
    await spend("claude-sonnet-5-5", 30);
    await spend("claude-sonnet-5-5", 40, { ts: LAST_MONTH });
    await spend("gpt-5.4-nano", 1);
    const s = await service.status();
    expect(s.period).toBe("2026-11");
    expect(s.providers.anthropic.spentUsd).toBeCloseTo(30, 6);
    expect(s.providers.openai.spentUsd).toBeCloseTo(1, 6);
    expect(s.providers.anthropic.available).toBe(true);
  });

  it("reserves the rest of the run cap for each active run's current engine", async () => {
    const { service, runs, spend } = setup();
    await runs.createRun(
      {
        id: "a",
        repo: "acme/demo",
        issueNumber: 1,
        ts: 1,
        implementModel: "claude-sonnet-5-5",
      },
      9,
    );
    await spend("claude-sonnet-5-5", 2, { runId: "a" });
    await runs.createRun(
      {
        id: "b",
        repo: "acme/demo",
        issueNumber: 2,
        ts: 1,
        implementModel: "claude-sonnet-5-5",
      },
      9,
    );
    await runs.transition({
      runId: "b",
      from: "queued",
      to: "reviewing",
      code: null,
      ts: 2,
    });
    await runs.recordFacts({ runId: "b", reviewModel: "gpt-5.4-nano" });
    await runs.createRun(
      {
        id: "c",
        repo: "acme/demo",
        issueNumber: 3,
        ts: 1,
        implementModel: "claude-sonnet-5-5",
      },
      9,
    );
    await runs.transition({
      runId: "c",
      from: "queued",
      to: "awaiting_engine",
      code: null,
      ts: 2,
    });
    const s = await service.status();
    // a: implementing on Anthropic with $3 of its $5 left; b: reviewing on OpenAI; c holds nothing.
    expect(s.providers.anthropic.reservedUsd).toBeCloseTo(3, 6);
    expect(s.providers.openai.reservedUsd).toBeCloseTo(5, 6);
    expect((await service.status("b")).providers.openai.reservedUsd).toBe(0);
  });
});

describe("BudgetService.callCheck (fake usage)", () => {
  it("allows a priced model while the run and the month have room", async () => {
    const { service, runs } = setup();
    await runs.createRun(
      { id: "r", repo: "acme/demo", issueNumber: 1, ts: 1 },
      9,
    );
    expect(
      await service.callCheck("r", "claude-sonnet-5-5", "implement"),
    ).toEqual({
      allow: true,
    });
  });

  it("refuses a model without a price", async () => {
    const { service } = setup();
    expect(await service.callCheck("r", "mystery", "implement")).toEqual({
      allow: false,
      reason: "model_not_priced",
    });
  });

  it("refuses once the run spent its cap on that account", async () => {
    const { service, runs, spend } = setup();
    await runs.createRun(
      { id: "r", repo: "acme/demo", issueNumber: 1, ts: 1 },
      9,
    );
    await spend("claude-sonnet-5-5", 5, { runId: "r" });
    expect(
      await service.callCheck("r", "claude-sonnet-5-5", "implement"),
    ).toEqual({
      allow: false,
      reason: "run_budget_exceeded",
    });
    // The other account's cap is separate.
    expect(await service.callCheck("r", "gpt-5.4-nano", "implement")).toEqual({
      allow: true,
    });
    expect(await service.overrun("r", "claude-sonnet-5-5", "implement")).toBe(
      true,
    );
    expect(await service.overrun("r", "gpt-5.4-nano", "implement")).toBe(false);
  });

  it("refuses once the account reached its monthly limit", async () => {
    const { service, runs, spend } = setup();
    await spend("gpt-6.1-terra", 50);
    await runs.createRun(
      { id: "r", repo: "acme/demo", issueNumber: 1, ts: 1 },
      9,
    );
    expect(await service.callCheck("r", "gpt-5.4-nano", "implement")).toEqual({
      allow: false,
      reason: "monthly_budget_exceeded",
    });
    expect(
      await service.callCheck("r", "claude-sonnet-5-5", "implement"),
    ).toEqual({
      allow: true,
    });
  });
});

describe("BudgetService.notifyExhausted", () => {
  it("registers one factory issue per billing period", async () => {
    const { service, spend, issues } = setup();
    await spend("claude-sonnet-5-5", 49);
    await spend("gpt-6.1-terra", 48);
    const s = await service.status();
    await service.notifyExhausted(s);
    await service.notifyExhausted(s);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.repo).toBe("roboco-io/the-software-factory-demo");
    expect(issues[0]!.title).toContain("2026-11");
    expect(issues[0]!.body).toContain("$49.00");
    expect(issues[0]!.body).not.toContain("@");
  });

  it("does nothing while one account still has room", async () => {
    const { service, spend, issues } = setup();
    await spend("claude-sonnet-5-5", 49);
    await service.notifyExhausted(await service.status());
    expect(issues).toHaveLength(0);
  });

  it("never throws, and tries again after a failed attempt", async () => {
    const failing = setup({ failIssue: true });
    await failing.spend("claude-sonnet-5-5", 50);
    await failing.spend("gpt-5.4-nano", 50);
    await expect(
      failing.service.notifyExhausted(await failing.service.status()),
    ).resolves.toBeUndefined();
    expect(failing.t.query("SELECT COUNT(*) AS n FROM budget_alerts")).toEqual([
      { n: 0 },
    ]);
  });
});

describe("BudgetService per-phase cap (review fix)", () => {
  it("gives the review its own cap when it bills the same account as the implementation", async () => {
    const { service, runs, spend } = setup();
    await runs.createRun(
      { id: "r", repo: "acme/demo", issueNumber: 1, ts: 1 },
      9,
    );
    await spend("claude-sonnet-5-5", 5, { runId: "r" });
    expect(
      await service.callCheck("r", "claude-sonnet-5-5", "implement"),
    ).toEqual({
      allow: false,
      reason: "run_budget_exceeded",
    });
    expect(await service.callCheck("r", "claude-haiku-5-5", "review")).toEqual({
      allow: true,
    });
    expect(await service.overrun("r", "claude-haiku-5-5", "review")).toBe(
      false,
    );
  });
});
