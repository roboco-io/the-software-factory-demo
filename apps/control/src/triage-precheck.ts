import type { GuestPolicy } from "./guest-policy";

/** The label the guest issue template adds. Only issues that carry it are triaged. */
export const GUEST_LABEL = "demo:guest";

export const PRECHECK_REJECTIONS = [
  "account_too_new",
  "quota_account",
  "quota_daily",
  "bad_form",
] as const;
export type PrecheckRejection = (typeof PRECHECK_REJECTIONS)[number];

export type PrecheckResult =
  /** Not a guest request: no reply and no record. */
  | { kind: "ignore" }
  | { kind: "reject"; code: PrecheckRejection }
  /** The model may look at it. */
  | { kind: "pass" };

export interface PrecheckInput {
  author: {
    id: number;
    login: string;
    type: string;
    /** When GitHub created the account, in ms. null when it could not be read. */
    createdAt: number | null;
  };
  isOperator: boolean;
  labels: string[];
  body: string;
  /** Issues of this account triaged in the last 24 hours, this one not included. */
  accountTriagedLastDay: number;
  /** The repository's model spend of this UTC day. null when a model has no price. */
  dailySpendUsd: number | null;
  policy: GuestPolicy;
  now: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KINDS = ["화면 문구·스타일", "작은 UI 기능", "버그 수정", "문서"];
const HEADINGS = [
  "요청 종류",
  "무엇을 바꾸고 싶나요?",
  "어떻게 되면 완료인가요?",
  "확인",
] as const;
const EMPTY = "_No response_";

export interface GuestForm {
  kind: string;
  what: string;
  done: string;
}

/**
 * The answers of the guest issue template (docs/guest-demo.md 6). GitHub renders a form as
 * `### <label>` headings followed by the answer. Null unless the four headings are there
 * once and in order, the kind is one of the template's options, both text answers are
 * filled, and the consent box is ticked. GitHub does not check required fields of issues
 * made through its API, so this check is the one that counts.
 */
export function parseGuestForm(body: string): GuestForm | null {
  const text = body.replace(/\r\n?/g, "\n");
  const sections: { heading: string; answer: string }[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of text.split("\n")) {
    const match = /^### (.+)$/.exec(line);
    if (match !== null) {
      if (current !== null)
        sections.push({
          heading: current.heading,
          answer: current.lines.join("\n").trim(),
        });
      current = { heading: (match[1] as string).trim(), lines: [] };
    } else if (current !== null) current.lines.push(line);
    else if (line.trim() !== "") return null;
  }
  if (current !== null)
    sections.push({
      heading: current.heading,
      answer: current.lines.join("\n").trim(),
    });
  if (
    sections.length !== HEADINGS.length ||
    sections.some((s, i) => s.heading !== HEADINGS[i])
  )
    return null;
  const [kind, what, done, consent] = sections.map((s) => s.answer) as [
    string,
    string,
    string,
    string,
  ];
  if (!KINDS.includes(kind)) return null;
  if (what === "" || what === EMPTY || done === "" || done === EMPTY)
    return null;
  if (!/^- \[[xX]\] /.test(consent)) return null;
  return { kind, what, done };
}

/**
 * The program's check before any model call (docs/guest-demo.md 4.1). It ends at the first
 * condition that applies, in this order, so an abusive request costs no model budget.
 * A value that could not be read (the account's age, the day's spend) rejects: the gate
 * stays closed when the control plane does not know.
 */
export function precheck(input: PrecheckInput): PrecheckResult {
  const { author, policy } = input;
  if (author.type === "Bot" || author.login.endsWith("[bot]"))
    return { kind: "ignore" };
  // Operators start runs with the factory:go label, as before.
  if (input.isOperator) return { kind: "ignore" };
  if (!input.labels.includes(GUEST_LABEL)) return { kind: "ignore" };
  if (
    author.createdAt === null ||
    input.now - author.createdAt < policy.minAccountAgeDays * DAY_MS
  )
    return { kind: "reject", code: "account_too_new" };
  if (input.accountTriagedLastDay >= policy.perAccountPerDay)
    return { kind: "reject", code: "quota_account" };
  if (input.dailySpendUsd === null || input.dailySpendUsd >= policy.dailyUsd)
    return { kind: "reject", code: "quota_daily" };
  if (
    [...input.body].length > policy.maxBodyChars ||
    parseGuestForm(input.body) === null
  )
    return { kind: "reject", code: "bad_form" };
  return { kind: "pass" };
}
