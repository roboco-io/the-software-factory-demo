import { cap } from "./prompt";

export const MAX_VERDICT_TEXT_CHARS = 64 * 1024;
export const MAX_COMMENT_CHARS = 6000;
const MAX_SUMMARY = 2000;
const MAX_FINDINGS = 30;
const MAX_FILE = 300;
const MAX_MESSAGE = 1000;
// Findings shown in the comment. The stored verdict may hold more.
const SHOWN_FINDINGS = 10;
const SHOWN_MESSAGE = 300;
const SHOWN_SUMMARY = 1000;

export const SEVERITIES = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  file: string;
  severity: Severity;
  message: string;
}
export interface Verdict {
  verdict: "approve" | "changes_requested";
  summary: string;
  findings: Finding[];
}

export type ParsedVerdict = { ok: true; verdict: Verdict } | { ok: false };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const sameKeys = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => k in v);
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= max;

function stripFence(raw: string): string {
  const match = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/.exec(raw);
  return match === null ? raw : (match[1] as string);
}

/**
 * Validates the reviewer's final message. The whole message must be one JSON object
 * (optionally in a single code fence) with exactly the documented fields. Anything
 * else is "no verdict", which the caller must treat as needing a person.
 */
export function parseVerdict(raw: string): ParsedVerdict {
  const bad: ParsedVerdict = { ok: false };
  if (raw.length > MAX_VERDICT_TEXT_CHARS) return bad;
  let value: unknown;
  try {
    value = JSON.parse(stripFence(raw.trim()));
  } catch {
    return bad;
  }
  if (!isRecord(value) || !sameKeys(value, ["verdict", "summary", "findings"]))
    return bad;
  const { verdict, summary, findings } = value;
  if (verdict !== "approve" && verdict !== "changes_requested") return bad;
  if (!text(summary, MAX_SUMMARY)) return bad;
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) return bad;
  const out: Finding[] = [];
  for (const finding of findings) {
    if (
      !isRecord(finding) ||
      !sameKeys(finding, ["file", "severity", "message"])
    )
      return bad;
    const { file, severity, message } = finding;
    if (!text(file, MAX_FILE) || !text(message, MAX_MESSAGE)) return bad;
    if (!(SEVERITIES as readonly unknown[]).includes(severity)) return bad;
    out.push({ file, severity: severity as Severity, message });
  }
  // An approval that lists a serious defect contradicts itself.
  if (
    verdict === "approve" &&
    out.some((f) => f.severity === "high" || f.severity === "critical")
  )
    return bad;
  return { ok: true, verdict: { verdict, summary, findings: out } };
}

// Controls except tab; built from strings so the source has no raw control characters.
const CONTROLS = new RegExp(
  "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]",
  "g",
);

/** One line of untrusted text made safe to show: no mentions, issue links, HTML or control characters. */
function safeLine(value: string, limit: number): string {
  const flat = value.replace(CONTROLS, "").replace(/\s+/g, " ").trim();
  return (
    cap(flat, limit)
      .replace(/\n\[truncated\]$/, " (truncated)")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/@/g, "@​")
      .replace(/#(?=\d)/g, "#​")
      .replace(/:\/\//g, ":​//")
      // Markdown links and images need brackets; bare URLs become links by themselves.
      .replace(/\[/g, "&#91;")
      .replace(/\]/g, "&#93;")
  );
}

/** The pull request comment for a verdict. Reviewer text is data: it is escaped and length-capped. */
export function renderReviewComment(
  verdict: Verdict,
  context: { model: string; headSha: string; singleEngine?: boolean },
): string {
  const lines = [
    `Automated review (${safeLine(context.model, 64)}) of commit \`${context.headSha.slice(0, 12)}\`: **${verdict.verdict}**`,
    "",
    context.singleEngine === true
      ? "Single-engine review: the other engine's budget is used up, so a different model of the implementing engine reviewed this change in a new session. The factory allows this for risk tiers T0 and T1 only. It is not a human approval. The factory decides the merge from the risk tier, the required checks and this verdict."
      : "This is a machine-generated review by a second AI engine. It is not a human approval. The factory decides the merge from the risk tier, the required checks and this verdict.",
    "",
    safeLine(verdict.summary, SHOWN_SUMMARY),
  ];
  if (verdict.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of verdict.findings.slice(0, SHOWN_FINDINGS)) {
      lines.push(
        `- ${finding.severity}: \`${safeLine(finding.file, 120).replace(/`/g, "'")}\` ${safeLine(finding.message, SHOWN_MESSAGE)}`,
      );
    }
    if (verdict.findings.length > SHOWN_FINDINGS)
      lines.push(`- ... and ${verdict.findings.length - SHOWN_FINDINGS} more`);
  }
  const body = lines.join("\n");
  const chars = [...body];
  return chars.length <= MAX_COMMENT_CHARS
    ? body
    : `${chars.slice(0, MAX_COMMENT_CHARS - 14).join("")}\n[truncated]`;
}
