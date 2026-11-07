import { describe, expect, it } from "vitest";
import {
  costUsdText,
  isAttention,
  isGithubAuthorize,
  costLine,
  moneyText,
  tokenCount,
  tokenCountShort,
  tokenTotal,
  shortSha,
} from "./console-labels";

const DAY = 86_400_000;

const USAGE = (i: number, o = 0, cr = 0, cw = 0) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadTokens: cr,
  cacheWriteTokens: cw,
});

describe("tokens", () => {
  it("adds every kind of token", () => {
    expect(tokenTotal(USAGE(1, 2, 3, 4))).toBe(10);
  });
  it("writes full and short counts", () => {
    expect(tokenCount(1234567)).toBe("1,234,567");
    expect(tokenCountShort(999)).toBe("999");
    expect(tokenCountShort(9999)).toBe("9,999");
    expect(tokenCountShort(12_345)).toBe("1.2만");
    expect(tokenCountShort(250_000_000)).toBe("2.5억");
  });
  it("gives one line for a run in each cost status", () => {
    const tokens = { implement: USAGE(10_000), review: USAGE(2_000) };
    expect(costLine({ status: "measured", totalUsd: 0.47, tokens })).toBe(
      "토큰 1.2만 · $0.47",
    );
    expect(costLine({ status: "unknown", totalUsd: null, tokens })).toBe(
      "토큰 1.2만 · 비용 계산 불가",
    );
    expect(
      costLine({ status: "not_measured", totalUsd: null, tokens: null }),
    ).toBe("토큰과 비용 측정 전");
  });
});

describe("moneyText", () => {
  it("keeps a small amount from reading as zero", () => {
    expect(moneyText({ status: "measured", totalUsd: 0.0008 })).toBe("$0.0008");
    expect(moneyText({ status: "measured", totalUsd: 0.01 })).toBe("$0.01");
  });
  it("names each cost status", () => {
    expect(moneyText({ status: "not_measured", totalUsd: null })).toBe(
      "측정 전",
    );
    expect(moneyText({ status: "unknown", totalUsd: null })).toBe("계산 불가");
    expect(moneyText({ status: "measured", totalUsd: 0.47 })).toBe("$0.47");
    expect(moneyText({ status: "measured", totalUsd: 0 })).toBe("$0.00");
  });
  it("never shows a number for a status without one", () => {
    expect(moneyText({ status: "unknown", totalUsd: 3 })).toBe("계산 불가");
    expect(moneyText({ status: "measured", totalUsd: null })).toBe("계산 불가");
  });
});

describe("costUsdText", () => {
  it("shows null as not computable", () => {
    expect(costUsdText(null)).toBe("계산 불가");
    expect(costUsdText(1.234)).toBe("$1.23");
  });
});

describe("attention", () => {
  const now = 100 * DAY;
  it("counts awaiting_approval, and recent needs_human or failed", () => {
    expect(isAttention({ state: "awaiting_approval", updatedAt: 0 }, now)).toBe(
      true,
    );
    expect(
      isAttention({ state: "needs_human", updatedAt: now - 6 * DAY }, now),
    ).toBe(true);
    expect(
      isAttention({ state: "failed", updatedAt: now - 8 * DAY }, now),
    ).toBe(false);
    expect(isAttention({ state: "merged", updatedAt: now }, now)).toBe(false);
  });
});

describe("helpers", () => {
  it("shortens a commit", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
  it("accepts only the GitHub authorize address", () => {
    expect(
      isGithubAuthorize("https://github.com/login/oauth/authorize?client_id=x"),
    ).toBe(true);
    expect(isGithubAuthorize("https://evil.example/")).toBe(false);
    expect(
      isGithubAuthorize(
        "https://github.com.evil.example/login/oauth/authorize",
      ),
    ).toBe(false);
    expect(
      isGithubAuthorize("https://github.com/login/oauth/authorizeevil"),
    ).toBe(false);
    expect(isGithubAuthorize("javascript:alert(1)")).toBe(false);
    expect(isGithubAuthorize(undefined)).toBe(false);
  });
});
