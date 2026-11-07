import { describe, expect, it } from "vitest";
import { costUsd } from "./pricing";

describe("costUsd", () => {
  it("prices gpt-5.4-nano input and output per million tokens", () => {
    const cost = costUsd("gpt-5.4-nano", {
      inputTokens: 1000000,
      outputTokens: 1000000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(1.45, 10);
  });

  it("prices claude-sonnet-5-5 cache read and cache write", () => {
    const cost = costUsd("claude-sonnet-5-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1000000,
      cacheWriteTokens: 1000000,
    });
    expect(cost).toBeCloseTo(2.6, 10);
  });

  it("returns null for an unknown model", () => {
    const cost = costUsd("unknown-model", {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeNull();
  });

  it("zero usage costs 0", () => {
    const cost = costUsd("gpt-5.4-nano", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBe(0);
  });
});
