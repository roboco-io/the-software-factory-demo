import { describe, expect, it } from "vitest";
import { budgetNotice } from "./budget-notice";
import type { BudgetInfo } from "./api";

const info = (
  mode: BudgetInfo["mode"],
  anthropic: number | null,
  openai: number | null,
): BudgetInfo => ({
  period: "2026-11",
  runCapUsd: 5,
  mode,
  providers: {
    anthropic: {
      limitUsd: 50,
      spentUsd: anthropic,
      exhausted: mode !== "normal",
    },
    openai: { limitUsd: 50, spentUsd: openai, exhausted: mode === "paused" },
  },
});

describe("budgetNotice (stage 5)", () => {
  it("says nothing while both accounts have room", () => {
    expect(budgetNotice(info("normal", 1, 1))).toBeNull();
  });

  it("explains that new runs stopped when both accounts reached their limit", () => {
    const n = budgetNotice(info("paused", 50, 49.5))!;
    expect(n.kind).toBe("alert");
    expect(n.text).toContain("새 실행을 멈췄습니다");
    expect(n.text).toContain("2026-11");
    expect(n.text).toContain("Anthropic $50.00 / $50.00");
    expect(n.text).toContain("OpenAI $49.50 / $50.00");
    expect(n.text).toContain("추정");
  });

  it("explains single-engine mode and what waits", () => {
    const n = budgetNotice(info("single_engine", 46, 3))!;
    expect(n.kind).toBe("status");
    expect(n.text).toContain("Anthropic");
    expect(n.text).toContain("T0·T1");
    expect(n.text).toContain("T2·T3");
  });

  it("shows an unknown spend as unknown", () => {
    expect(budgetNotice(info("paused", null, 50))!.text).toContain(
      "Anthropic 알 수 없음",
    );
  });
});
