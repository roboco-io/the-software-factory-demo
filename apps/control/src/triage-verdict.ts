import type { GuestPolicy } from "./guest-policy";

export const MAX_TRIAGE_TEXT_CHARS = 16 * 1024;
const MAX_SUMMARY = 200;
const MAX_ACCEPTANCE_ITEMS = 5;
const MAX_ACCEPTANCE_CHARS = 200;

export interface TriageVerdict {
  decision: "accept" | "reject" | "escalate";
  /** A clause code of the policy's allowed list, or "forbidden" or "out_of_scope". */
  category: string;
  /** "allowed" for an accepted request, else a clause code of the policy. */
  reasonCode: string;
  summary: string;
  acceptance: string[];
}

export type ParsedTriageVerdict =
  { ok: true; verdict: TriageVerdict } | { ok: false };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length >= 1 && v.length <= max;
const KEYS = ["decision", "category", "reasonCode", "summary", "acceptance"];

function stripFence(raw: string): string {
  const match = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/.exec(raw);
  return match === null ? raw : (match[1] as string);
}

/**
 * Validates the triage model's answer (docs/guest-demo.md 4.2). The whole answer must be
 * one JSON object, optionally in a single code fence, with exactly the documented fields,
 * values from the policy, and a matching decision, category and reason code. Anything else
 * is "no verdict": the caller then leaves the request to the administrator, so a model
 * error never becomes an acceptance.
 */
export function parseTriageVerdict(
  raw: string,
  policy: GuestPolicy,
): ParsedTriageVerdict {
  const bad: ParsedTriageVerdict = { ok: false };
  if (raw.length > MAX_TRIAGE_TEXT_CHARS) return bad;
  let value: unknown;
  try {
    value = JSON.parse(stripFence(raw.trim()));
  } catch {
    return bad;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== KEYS.length ||
    !KEYS.every((k) => k in value)
  )
    return bad;
  const { decision, category, reasonCode, summary, acceptance } = value;
  if (typeof category !== "string" || typeof reasonCode !== "string")
    return bad;
  if (!text(summary, MAX_SUMMARY)) return bad;
  if (
    !Array.isArray(acceptance) ||
    !acceptance.every((a) => text(a, MAX_ACCEPTANCE_CHARS))
  )
    return bad;
  const items = acceptance as string[];
  if (decision === "accept") {
    if (!policy.allowed.includes(category) || reasonCode !== "allowed")
      return bad;
    if (items.length < 1 || items.length > MAX_ACCEPTANCE_ITEMS) return bad;
  } else if (decision === "reject") {
    if (category !== "forbidden" || !policy.forbidden.includes(reasonCode))
      return bad;
    if (items.length !== 0) return bad;
  } else if (decision === "escalate") {
    if (category !== "out_of_scope" || !policy.escalate.includes(reasonCode))
      return bad;
    if (items.length !== 0) return bad;
  } else return bad;
  return {
    ok: true,
    verdict: { decision, category, reasonCode, summary, acceptance: items },
  };
}
