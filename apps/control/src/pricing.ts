export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// USD per million tokens. Read 2026-11-07 from platform.claude.com and developers.openai.com.
const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
  },
  "gpt-5.4-nano": {
    input: 0.2,
    output: 1.25,
    cacheRead: 0.02,
    cacheWrite: 0.2,
  },
};

const TOKENS_PER_UNIT = 1000000;

// Returns the USD cost of the usage, or null when the model has no price entry.
export function costUsd(model: string, usage: TokenUsage): number | null {
  const price = Object.prototype.hasOwnProperty.call(PRICES, model)
    ? PRICES[model]
    : undefined;
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
