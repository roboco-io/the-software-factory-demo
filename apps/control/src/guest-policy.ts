import { isAlias, parseDocument, visit } from "yaml";

/**
 * The guest request policy of a demo repository (`.factory/guest-policy.yml`, read from the
 * default branch only; docs/guest-demo.md 5.2). The limits feed the program's pre-check;
 * the clause codes are the only reason codes a triage verdict may use. `text` is the file
 * as written: it goes into the triage model's system prompt.
 */
export interface GuestPolicy {
  minAccountAgeDays: number;
  perAccountPerDay: number;
  dailyUsd: number;
  maxBodyChars: number;
  allowed: string[];
  forbidden: string[];
  escalate: string[];
  text: string;
}

export type ParsedGuestPolicy =
  { ok: true; policy: GuestPolicy } | { ok: false };

export const MAX_GUEST_POLICY_BYTES = 64 * 1024;
const MAX_CLAUSES = 40;
const MAX_DESCRIPTION = 500;
const CODE = /^[a-z][a-z0-9_]{0,39}$/;
// Built from strings so the source has no raw control characters.
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((k) => k in value);
const intIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

function clauseCodes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CLAUSES)
    return null;
  const codes: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["code", "description"]))
      return null;
    const { code, description } = item;
    if (typeof code !== "string" || !CODE.test(code)) return null;
    if (
      typeof description !== "string" ||
      description.length < 1 ||
      description.length > MAX_DESCRIPTION ||
      CONTROL.test(description)
    )
      return null;
    codes.push(code);
  }
  return codes;
}

function validate(value: unknown, text: string): GuestPolicy | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "eligibility",
      "limits",
      "allowed",
      "forbidden",
      "escalate",
    ])
  )
    return null;
  if (value.version !== 1) return null;
  const { eligibility, limits } = value;
  if (
    !isRecord(eligibility) ||
    !hasOnlyKeys(eligibility, ["minAccountAgeDays"])
  )
    return null;
  if (
    !isRecord(limits) ||
    !hasOnlyKeys(limits, ["perAccountPerDay", "dailyUsd", "maxBodyChars"])
  )
    return null;
  if (!intIn(eligibility.minAccountAgeDays, 0, 3650)) return null;
  if (!intIn(limits.perAccountPerDay, 1, 100)) return null;
  const dailyUsd = limits.dailyUsd;
  if (
    typeof dailyUsd !== "number" ||
    !Number.isFinite(dailyUsd) ||
    dailyUsd <= 0 ||
    dailyUsd > 1000
  )
    return null;
  // The webhook keeps at most 20000 characters of an issue body.
  if (!intIn(limits.maxBodyChars, 100, 20_000)) return null;
  const allowed = clauseCodes(value.allowed);
  const forbidden = clauseCodes(value.forbidden);
  const escalate = clauseCodes(value.escalate);
  if (allowed === null || forbidden === null || escalate === null) return null;
  // A code names one clause. "allowed" is the reason code of every accepted request.
  const all = [...allowed, ...forbidden, ...escalate];
  if (new Set(all).size !== all.length || all.includes("allowed")) return null;
  return {
    minAccountAgeDays: eligibility.minAccountAgeDays,
    perAccountPerDay: limits.perAccountPerDay,
    dailyUsd,
    maxBodyChars: limits.maxBodyChars,
    allowed,
    forbidden,
    escalate,
    text,
  };
}

/** Strictly parses the guest policy. Any problem means "no policy": then nothing is triaged. */
export function parseGuestPolicy(text: string): ParsedGuestPolicy {
  if (new TextEncoder().encode(text).length > MAX_GUEST_POLICY_BYTES)
    return { ok: false };
  let value: unknown;
  try {
    const doc = parseDocument(text, {
      schema: "core",
      uniqueKeys: true,
      merge: false,
      strict: true,
      logLevel: "error",
    });
    if (doc.errors.length > 0 || doc.warnings.length > 0) return { ok: false };
    let alias = false;
    visit(doc, (_key, node) => {
      if (isAlias(node)) alias = true;
    });
    if (alias) return { ok: false };
    value = doc.toJS() as unknown;
  } catch {
    return { ok: false };
  }
  const policy = validate(value, text);
  return policy === null ? { ok: false } : { ok: true, policy };
}
