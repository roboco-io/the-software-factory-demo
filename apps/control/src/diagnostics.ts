/**
 * Operational logs for failures whose stored reason code is too coarse.
 * Callers pass fixed event names and values reduced by the helpers below.
 * Never pass error messages, request bodies, headers, or issue text.
 */
export function logDiagnostic(
  event: string,
  fields: Record<string, string | number | string[]> = {},
): void {
  console.log(JSON.stringify({ event, ...fields }));
}

const ERROR_CLASS = /^[A-Z][A-Za-z]{0,40}$/;

/** The error's class name only. A message can contain URLs with tokens. */
export function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  return ERROR_CLASS.test(error.name) ? error.name : "unknown";
}

const LABEL = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A container-supplied flag name, or "invalid" when it could carry other data. */
export function safeLabel(value: string): string {
  if (!LABEL.test(value) || value.startsWith("sk-")) return "invalid";
  return value;
}
