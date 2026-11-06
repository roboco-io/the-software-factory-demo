export const DEFAULT_IMPLEMENT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_REVIEW_MODEL = "gpt-5.4-nano";

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
