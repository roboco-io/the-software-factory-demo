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

describe("providerOf and the stage 5 models", () => {
  it("maps each priced model to its provider", async () => {
    const { providerOf } = await import("./pricing");
    expect(providerOf("claude-sonnet-5-5")).toBe("anthropic");
    expect(providerOf("claude-haiku-5-5")).toBe("anthropic");
    expect(providerOf("gpt-5.4-nano")).toBe("openai");
    expect(providerOf("gpt-6.1-terra")).toBe("openai");
  });

  it("returns null for a model with no price entry", async () => {
    const { providerOf } = await import("./pricing");
    expect(providerOf("unknown-model")).toBeNull();
    expect(providerOf("constructor")).toBeNull();
  });

  it("prices gpt-6.1-terra input, cached input and output", () => {
    const cost = costUsd("gpt-6.1-terra", {
      inputTokens: 1000000,
      outputTokens: 1000000,
      cacheReadTokens: 1000000,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(6.05, 10);
  });

  it("prices claude-haiku-5-5 at the long-prompt rate, so the estimate is never low", () => {
    const cost = costUsd("claude-haiku-5-5", {
      inputTokens: 1000000,
      outputTokens: 1000000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(3, 10);
  });
});
