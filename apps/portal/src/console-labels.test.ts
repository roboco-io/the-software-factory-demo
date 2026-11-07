import { describe, expect, it } from "vitest";
import {
  costUsdText,
  isAttention,
  isGithubAuthorize,
  moneyText,
  shortSha,
  sortAttentionFirst,
} from "./console-labels";

const DAY = 86_400_000;

describe("moneyText", () => {
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
  it("sorts attention first and keeps the order otherwise", () => {
    const runs = [
      { id: "a", state: "merged", updatedAt: now },
      { id: "b", state: "awaiting_approval", updatedAt: now },
      { id: "c", state: "queued", updatedAt: now },
      { id: "d", state: "failed", updatedAt: now },
    ];
    expect(sortAttentionFirst(runs, now).map((r) => r.id)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
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
