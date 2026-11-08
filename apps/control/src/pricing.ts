export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type Provider = "anthropic" | "openai";

interface ModelPrice {
  provider: Provider;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// USD per million tokens. Read 2026-11-07 (gpt-6.1-terra and claude-haiku-5-5: 2026-11-08) from
// platform.claude.com and developers.openai.com. claude-haiku-5-5 costs more above 100K prompt
// tokens; the higher rate is used for every call, so the budget estimate is never too low.
const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-sonnet-5-5": {
    provider: "anthropic",
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
  },
  "claude-haiku-5-5": {
    provider: "anthropic",
    input: 0.5,
    output: 2.5,
    cacheRead: 0.05,
    cacheWrite: 0.625,
  },
  "gpt-5.4-nano": {
    provider: "openai",
    input: 0.2,
    output: 1.25,
    cacheRead: 0.02,
    cacheWrite: 0.2,
  },
  "gpt-6.1-terra": {
    provider: "openai",
    input: 1,
    output: 5,
    cacheRead: 0.05,
    cacheWrite: 1,
  },
};

const TOKENS_PER_UNIT = 1000000;

function priceOf(model: string): ModelPrice | undefined {
  return Object.prototype.hasOwnProperty.call(PRICES, model)
    ? PRICES[model]
    : undefined;
}

/** The provider that bills this model, or null when the model has no price entry. */
export function providerOf(model: string): Provider | null {
  return priceOf(model)?.provider ?? null;
}

// Returns the USD cost of the usage, or null when the model has no price entry.
export function costUsd(model: string, usage: TokenUsage): number | null {
  const price = priceOf(model);
  if (price === undefined) {
    return null;
  }
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    TOKENS_PER_UNIT
  );
}
