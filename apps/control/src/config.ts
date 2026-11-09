export const DEFAULT_IMPLEMENT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_REVIEW_MODEL = "gpt-5.4-nano";
/** Stage 5. pi implements with this once Anthropic reached its limit. */
export const DEFAULT_FALLBACK_IMPLEMENT_MODEL = "gpt-6.1-terra";
/** Stage 5. Reviews on Anthropic: pi's work on OpenAI, or T0/T1 when only Anthropic is left. */
export const DEFAULT_ANTHROPIC_REVIEW_MODEL = "claude-haiku-5-5";
/** Stage 5. The once-per-period budget issue goes here. It is not a managed project. */
export const DEFAULT_FACTORY_REPO = "roboco-io/the-software-factory-demo";

/** Comma-separated list, exact entries, whitespace around entries trimmed. Empty means no entries. */
export function parseList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function resolveModel(
  value: string | undefined,
  fallback: string = DEFAULT_IMPLEMENT_MODEL,
): string {
  const candidate = value?.trim();
  return candidate !== undefined && MODEL_PATTERN.test(candidate)
    ? candidate
    : fallback;
}

/** The reviewing engine's model. An invalid value falls back to the default. */
export const resolveReviewModel = (value: string | undefined): string =>
  resolveModel(value, DEFAULT_REVIEW_MODEL);
