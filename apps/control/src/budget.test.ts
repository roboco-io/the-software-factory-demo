import { describe, expect, it } from "vitest";
import {
  assessBudget,
  budgetMode,
  billingPeriod,
  budgetConfig,
  chooseImplementer,
  chooseReviewer,
  spendByProvider,
  type BudgetStatus,
  type EngineModels,
} from "./budget";

const config = budgetConfig({});
const models: EngineModels = {
  implement: { anthropic: "claude-sonnet-5-5", openai: "gpt-6.1-terra" },
  review: { openai: "gpt-5.4-nano", anthropic: "claude-haiku-5-5" },
};
const usage = (input: number) => ({
  inputTokens: input,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function status(
  spent: { anthropic: number | null; openai: number | null },
  reserved = { anthropic: 0, openai: 0 },
): BudgetStatus {
  return assessBudget(config, "2026-11", spent, reserved);
}

describe("budgetConfig", () => {
  it("defaults to $50 per account and $5 per run", () => {
    expect(config).toEqual({
      monthlyUsd: { anthropic: 50, openai: 50 },
      runCapUsd: 5,
    });
  });

  it("reads positive amounts from the environment and ignores invalid ones", () => {
    expect(
      budgetConfig({
        BUDGET_ANTHROPIC_USD: "20",
        BUDGET_OPENAI_USD: "-1",
        RUN_BUDGET_USD: "2.5",
      }),
    ).toEqual({ monthlyUsd: { anthropic: 20, openai: 50 }, runCapUsd: 2.5 });
    expect(budgetConfig({ RUN_BUDGET_USD: "abc" }).runCapUsd).toBe(5);
    expect(budgetConfig({ BUDGET_OPENAI_USD: "0" }).monthlyUsd.openai).toBe(0);
  });
});

describe("billingPeriod", () => {
  it("is the UTC calendar month", () => {
    const p = billingPeriod(Date.UTC(2026, 10, 30, 23, 59, 59));
    expect(p).toEqual({
      key: "2026-11",
      start: Date.UTC(2026, 10, 1),
      end: Date.UTC(2026, 11, 1),
    });
    expect(billingPeriod(Date.UTC(2026, 11, 1)).key).toBe("2026-12");
    expect(billingPeriod(Date.UTC(2027, 0, 1)).key).toBe("2027-01");
  });
});

describe("spendByProvider", () => {
  it("sums the priced cost of each provider's models", () => {
    const spent = spendByProvider([
      { model: "claude-sonnet-5-5", usage: usage(1_000_000) },
      { model: "gpt-5.4-nano", usage: usage(1_000_000) },
      { model: "gpt-6.1-terra", usage: usage(1_000_000) },
    ]);
    expect(spent.anthropic).toBeCloseTo(2, 10);
    expect(spent.openai).toBeCloseTo(1.2, 10);
  });

  it("makes both providers unknown when any row has no price", () => {
    expect(spendByProvider([{ model: "mystery", usage: usage(1) }])).toEqual({
      anthropic: null,
      openai: null,
    });
  });
});

describe("assessBudget", () => {
  it("is available while one more run fits beside the reservations", () => {
    const s = status({ anthropic: 40, openai: 0 }, { anthropic: 5, openai: 0 });
    expect(s.providers.anthropic).toMatchObject({
      limitUsd: 50,
      spentUsd: 40,
      reservedUsd: 5,
      exhausted: false,
      available: true,
    });
  });

  it("is exhausted when less than one run's cap is left", () => {
    const s = status({ anthropic: 45.01, openai: 0 });
    expect(s.providers.anthropic.exhausted).toBe(true);
    expect(s.providers.anthropic.available).toBe(false);
  });

  it("is reserved, not exhausted, when only active runs hold the rest", () => {
    const s = status({ anthropic: 40, openai: 0 }, { anthropic: 6, openai: 0 });
    expect(s.providers.anthropic.exhausted).toBe(false);
    expect(s.providers.anthropic.available).toBe(false);
  });

  it("treats unknown spend as exhausted", () => {
    const s = status({ anthropic: null, openai: 0 });
    expect(s.providers.anthropic.exhausted).toBe(true);
    expect(s.providers.anthropic.available).toBe(false);
  });
});

describe("chooseImplementer", () => {
  it("uses Claude while Anthropic has room", () => {
    expect(
      chooseImplementer(status({ anthropic: 0, openai: 50 }), models),
    ).toEqual({
      kind: "engine",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
  });

  it("switches to Codex when Anthropic reached its limit", () => {
    expect(
      chooseImplementer(status({ anthropic: 50, openai: 0 }), models),
    ).toEqual({ kind: "engine", provider: "openai", model: "gpt-6.1-terra" });
  });

  it("stops new runs when both accounts reached their limit", () => {
    expect(
      chooseImplementer(status({ anthropic: 50, openai: 46 }), models),
    ).toEqual({ kind: "exhausted" });
  });

  it("asks to wait, without declaring exhaustion, when only reservations block", () => {
    expect(
      chooseImplementer(
        status({ anthropic: 50, openai: 40 }, { anthropic: 0, openai: 10 }),
        models,
      ),
    ).toEqual({ kind: "reserved" });
  });
});

describe("chooseReviewer", () => {
  const both = status({ anthropic: 0, openai: 0 });
  const onlyOpenai = status({ anthropic: 50, openai: 0 });
  const onlyAnthropic = status({ anthropic: 0, openai: 50 });
  const none = status({ anthropic: 50, openai: 50 });

  it("reviews with the other engine whenever it has room", () => {
    expect(chooseReviewer("T3", "claude-sonnet-5-5", both, models)).toEqual({
      kind: "engine",
      provider: "openai",
      model: "gpt-5.4-nano",
      singleEngine: false,
    });
    expect(chooseReviewer("T2", "gpt-6.1-terra", both, models)).toEqual({
      kind: "engine",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      singleEngine: false,
    });
  });

  it("lets another model of the same engine review T0 and T1 when only one engine is left", () => {
    for (const tier of ["T0", "T1"] as const) {
      expect(chooseReviewer(tier, "gpt-6.1-terra", onlyOpenai, models)).toEqual(
        {
          kind: "engine",
          provider: "openai",
          model: "gpt-5.4-nano",
          singleEngine: true,
        },
      );
      expect(
        chooseReviewer(tier, "claude-sonnet-5-5", onlyAnthropic, models),
      ).toEqual({
        kind: "engine",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        singleEngine: true,
      });
    }
  });

  it("makes T2, T3 and an unknown tier wait when only one engine is left", () => {
    for (const tier of ["T2", "T3", undefined] as const)
      expect(chooseReviewer(tier, "gpt-6.1-terra", onlyOpenai, models)).toEqual(
        {
          kind: "wait",
        },
      );
  });

  it("waits when the only model left is the implementer's own", () => {
    const same: EngineModels = {
      ...models,
      review: { ...models.review, openai: "gpt-6.1-terra" },
    };
    expect(chooseReviewer("T0", "gpt-6.1-terra", onlyOpenai, same)).toEqual({
      kind: "wait",
    });
  });

  it("waits when no engine has room", () => {
    expect(chooseReviewer("T0", "claude-sonnet-5-5", none, models)).toEqual({
      kind: "wait",
    });
  });
});

describe("budgetMode", () => {
  it("is normal, single_engine or paused", () => {
    expect(budgetMode(status({ anthropic: 0, openai: 0 }))).toBe("normal");
    expect(budgetMode(status({ anthropic: 50, openai: 0 }))).toBe(
      "single_engine",
    );
    expect(budgetMode(status({ anthropic: 0, openai: 50 }))).toBe(
      "single_engine",
    );
    expect(budgetMode(status({ anthropic: 50, openai: 50 }))).toBe("paused");
  });
});
