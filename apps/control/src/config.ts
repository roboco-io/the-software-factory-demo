export const DEFAULT_IMPLEMENT_MODEL = "claude-sonnet-5-5";

/** Comma-separated list, exact entries, whitespace around entries trimmed. Empty means no entries. */
export function parseList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function resolveModel(value: string | undefined): string {
  const candidate = value?.trim();
  return candidate !== undefined && MODEL_PATTERN.test(candidate)
    ? candidate
    : DEFAULT_IMPLEMENT_MODEL;
}
