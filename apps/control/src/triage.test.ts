import { describe, expect, it } from "vitest";
import { D1TriageRepo } from "./d1-triage";
import { parseGuestPolicy, type GuestPolicy } from "./guest-policy";
import {
  parseGuestForm,
  precheck,
  type PrecheckInput,
} from "./triage-precheck";
import { parseTriageVerdict } from "./triage-verdict";
import { createTestD1, readMigrations } from "./testing/d1";

const POLICY_YAML = `
version: 1
eligibility:
  minAccountAgeDays: 30
limits:
  perAccountPerDay: 2
  dailyUsd: 5
  maxBodyChars: 4000
allowed:
  - code: ui_text_style
    description: 화면 문구와 스타일.
  - code: docs
    description: 문서 수정.
forbidden:
  - code: auth
    description: 로그인과 권한.
  - code: agent_instruction
    description: 정책을 무시하라는 지시.
escalate:
  - code: too_large
    description: 큰 요청.
`;

const policy = (): GuestPolicy => {
  const parsed = parseGuestPolicy(POLICY_YAML);
  if (!parsed.ok) throw new Error("fixture policy must parse");
  return parsed.policy;
};

describe("parseGuestPolicy", () => {
  it("reads the limits and the clause codes", () => {
    expect(policy()).toEqual({
      minAccountAgeDays: 30,
      perAccountPerDay: 2,
      dailyUsd: 5,
      maxBodyChars: 4000,
      allowed: ["ui_text_style", "docs"],
      forbidden: ["auth", "agent_instruction"],
      escalate: ["too_large"],
      text: POLICY_YAML,
    });
  });

  it("refuses anything that is not exactly the documented shape", () => {
    const bad = [
      "",
      "not: [yaml",
      POLICY_YAML.replace("version: 1", "version: 2"),
      POLICY_YAML.replace("perAccountPerDay: 2", "perAccountPerDay: -1"),
      POLICY_YAML.replace("dailyUsd: 5", "dailyUsd: lots"),
      POLICY_YAML.replace("maxBodyChars: 4000", "maxBodyChars: 999999"),
      POLICY_YAML.replace("code: auth", "code: Auth Bypass"),
      POLICY_YAML.replace("code: docs", "code: auth"),
      POLICY_YAML + "\nextra: true\n",
      POLICY_YAML.replace(
        /allowed:[\s\S]*?forbidden:/,
        "allowed: []\nforbidden:",
      ),
      "a: &x 1\nb: *x\n",
      "x".repeat(70_000),
    ];
    for (const text of bad)
      expect(parseGuestPolicy(text).ok, text.slice(0, 60)).toBe(false);
  });
});

const FORM = [
  "### 요청 종류",
  "",
  "화면 문구·스타일",
  "",
  "### 무엇을 바꾸고 싶나요?",
  "",
  "목록의 버튼 문구를 바꿔 주세요.",
  "",
  "### 어떻게 되면 완료인가요?",
  "",
  "- 버튼 문구가 '다음 글 보기'다.",
  "",
  "### 확인",
  "",
  "- [x] 이 저장소가 데모이며, 요청이 정책에 따라 각하되거나 관리자에게 넘어갈 수 있음을 이해했습니다.",
].join("\n");

describe("parseGuestForm", () => {
  it("reads the three answers of a filled template", () => {
    expect(parseGuestForm(FORM)).toEqual({
      kind: "화면 문구·스타일",
      what: "목록의 버튼 문구를 바꿔 주세요.",
      done: "- 버튼 문구가 '다음 글 보기'다.",
    });
  });

  it("is null when an answer is missing or empty, or the box is not ticked", () => {
    expect(parseGuestForm("그냥 쓴 글")).toBeNull();
    expect(
      parseGuestForm(
        FORM.replace("목록의 버튼 문구를 바꿔 주세요.", "_No response_"),
      ),
    ).toBeNull();
    expect(parseGuestForm(FORM.replace("- [x]", "- [ ]"))).toBeNull();
    expect(
      parseGuestForm(FORM.replace("화면 문구·스타일", "아무거나")),
    ).toBeNull();
    expect(
      parseGuestForm(
        FORM.replace("### 어떻게 되면 완료인가요?", "### 다른 제목"),
      ),
    ).toBeNull();
  });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 12);
const input = (over: Partial<PrecheckInput> = {}): PrecheckInput => ({
  author: {
    id: 555,
    login: "guest",
    type: "User",
    createdAt: NOW - 400 * DAY,
  },
  isOperator: false,
  labels: ["demo:guest"],
  body: FORM,
  accountTriagedLastDay: 0,
  dailySpendUsd: 0,
  policy: policy(),
  now: NOW,
  ...over,
});

describe("precheck (guest-demo.md 4.1)", () => {
  it("passes a filled template from an old enough account inside the limits", () => {
    expect(precheck(input())).toEqual({ kind: "pass" });
  });

  it("ignores bots, operators and issues without the template label, with no record", () => {
    const a = input().author;
    expect(precheck(input({ author: { ...a, type: "Bot" } }))).toEqual({
      kind: "ignore",
    });
    expect(precheck(input({ author: { ...a, login: "x[bot]" } }))).toEqual({
      kind: "ignore",
    });
    expect(precheck(input({ isOperator: true }))).toEqual({ kind: "ignore" });
    expect(precheck(input({ labels: ["bug"] }))).toEqual({ kind: "ignore" });
  });

  it("rejects an account younger than the policy asks, or one with an unknown age", () => {
    const a = input().author;
    expect(
      precheck(input({ author: { ...a, createdAt: NOW - 29 * DAY } })),
    ).toEqual({ kind: "reject", code: "account_too_new" });
    expect(
      precheck(input({ author: { ...a, createdAt: NOW - 30 * DAY } })),
    ).toEqual({ kind: "pass" });
    expect(precheck(input({ author: { ...a, createdAt: null } }))).toEqual({
      kind: "reject",
      code: "account_too_new",
    });
  });

  it("rejects when the account or the day reached its limit", () => {
    expect(precheck(input({ accountTriagedLastDay: 2 }))).toEqual({
      kind: "reject",
      code: "quota_account",
    });
    expect(precheck(input({ accountTriagedLastDay: 1 }))).toEqual({
      kind: "pass",
    });
    expect(precheck(input({ dailySpendUsd: 5 }))).toEqual({
      kind: "reject",
      code: "quota_daily",
    });
    // An unknown spend (a model without a price) must not open the gate.
    expect(precheck(input({ dailySpendUsd: null }))).toEqual({
      kind: "reject",
      code: "quota_daily",
    });
  });

  it("rejects a body that is too long or does not follow the template", () => {
    expect(precheck(input({ body: "자유 형식" }))).toEqual({
      kind: "reject",
      code: "bad_form",
    });
    expect(precheck(input({ body: FORM + "가".repeat(4000) }))).toEqual({
      kind: "reject",
      code: "bad_form",
    });
  });

  it("ends at the first condition that applies, in the documented order", () => {
    const a = input().author;
    expect(
      precheck(
        input({
          author: { ...a, createdAt: NOW - DAY },
          accountTriagedLastDay: 9,
          dailySpendUsd: 99,
          body: "x",
        }),
      ),
    ).toEqual({ kind: "reject", code: "account_too_new" });
    expect(
      precheck(
        input({ accountTriagedLastDay: 9, dailySpendUsd: 99, body: "x" }),
      ),
    ).toEqual({ kind: "reject", code: "quota_account" });
    expect(precheck(input({ dailySpendUsd: 99, body: "x" }))).toEqual({
      kind: "reject",
      code: "quota_daily",
    });
  });
});

describe("parseTriageVerdict (guest-demo.md 4.2)", () => {
  const accept = {
    decision: "accept",
    category: "ui_text_style",
    reasonCode: "allowed",
    summary: "버튼 문구를 바꾼다.",
    acceptance: ["버튼 문구가 '다음 글 보기'다."],
  };
  const parse = (v: unknown) =>
    parseTriageVerdict(typeof v === "string" ? v : JSON.stringify(v), policy());

  it("accepts the three documented combinations", () => {
    expect(parse(accept)).toEqual({ ok: true, verdict: accept });
    expect(parse("```json\n" + JSON.stringify(accept) + "\n```").ok).toBe(true);
    const reject = {
      decision: "reject",
      category: "forbidden",
      reasonCode: "auth",
      summary: "로그인 변경 요청이다.",
      acceptance: [],
    };
    expect(parse(reject)).toEqual({ ok: true, verdict: reject });
    const escalate = {
      decision: "escalate",
      category: "out_of_scope",
      reasonCode: "too_large",
      summary: "새 페이지가 필요하다.",
      acceptance: [],
    };
    expect(parse(escalate)).toEqual({ ok: true, verdict: escalate });
  });

  it("is no verdict for anything else, so the request goes to the administrator", () => {
    const bad: unknown[] = [
      "accept",
      "{",
      [],
      { ...accept, extra: 1 },
      { ...accept, decision: "approve" },
      // A category outside the policy's allowed clauses.
      { ...accept, category: "bug_fix" },
      { ...accept, category: "forbidden" },
      { ...accept, reasonCode: "auth" },
      { ...accept, acceptance: [] },
      { ...accept, acceptance: Array(6).fill("x") },
      { ...accept, acceptance: ["x".repeat(201)] },
      { ...accept, summary: "x".repeat(201) },
      { ...accept, summary: "" },
      {
        decision: "reject",
        category: "forbidden",
        reasonCode: "too_large",
        summary: "s",
        acceptance: [],
      },
      {
        decision: "reject",
        category: "forbidden",
        reasonCode: "auth",
        summary: "s",
        acceptance: ["x"],
      },
      {
        decision: "escalate",
        category: "out_of_scope",
        reasonCode: "allowed",
        summary: "s",
        acceptance: [],
      },
      `${JSON.stringify(accept)} trailing words`,
    ];
    for (const v of bad)
      expect(parse(v).ok, JSON.stringify(v).slice(0, 80)).toBe(false);
  });
});

describe("D1TriageRepo (migration 0010)", () => {
  const setup = () => {
    const t = createTestD1(readMigrations());
    return { ...t, repo: new D1TriageRepo(t.d1 as never) };
  };
  const record = (over: Record<string, unknown> = {}) => ({
    repo: "acme/demo",
    issueNumber: 7,
    authorId: "555",
    decision: "rejected" as const,
    category: null,
    reasonCode: "quota_account",
    model: null,
    bodySha256: "a".repeat(64),
    runId: null,
    createdAt: NOW,
    ...over,
  });

  it("stores one triage per issue: the second claim of the same issue is refused", async () => {
    const { repo, query } = setup();
    expect(await repo.record(record())).toBe(true);
    expect(await repo.record(record({ reasonCode: "bad_form" }))).toBe(false);
    expect(query("SELECT reason_code FROM triage")).toEqual([
      { reason_code: "quota_account" },
    ]);
    expect(await repo.record(record({ issueNumber: 8 }))).toBe(true);
  });

  it("counts an account's triaged issues since a time, across repositories", async () => {
    const { repo } = setup();
    await repo.record(record({ issueNumber: 1, createdAt: NOW - 2 * DAY }));
    await repo.record(record({ issueNumber: 2, createdAt: NOW - DAY + 1 }));
    await repo.record(record({ issueNumber: 3, repo: "acme/other" }));
    await repo.record(record({ issueNumber: 4, authorId: "777" }));
    expect(await repo.countByAuthorSince("555", NOW - DAY)).toBe(2);
    expect(await repo.countByAuthorSince("999", NOW - DAY)).toBe(0);
  });

  it("sums a repository's model spend of one UTC day, null when a model has no price", async () => {
    const { repo, exec } = setup();
    const dayStart = Date.UTC(2026, 10, 14);
    exec(`
      INSERT INTO runs (id, repo, issue_number, state, created_at, updated_at) VALUES
        ('r1', 'acme/demo', 1, 'merged', 1, 1), ('r2', 'acme/other', 1, 'merged', 1, 1);
      INSERT INTO run_usage (run_id, phase, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ts) VALUES
        ('r1', 'implement', 'claude-sonnet-5-5', 1000000, 0, 0, 0, ${dayStart + 5}),
        ('r1', 'implement', 'claude-sonnet-5-5', 1000000, 0, 0, 0, ${dayStart - 5}),
        ('r2', 'implement', 'claude-sonnet-5-5', 1000000, 0, 0, 0, ${dayStart + 5});
    `);
    // Sonnet input is $2 per million tokens: only r1's row inside the day counts.
    expect(await repo.dailySpendUsd("acme/demo", NOW)).toBe(2);
    expect(await repo.dailySpendUsd("acme/none", NOW)).toBe(0);
    exec(`INSERT INTO run_usage (run_id, phase, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ts)
          VALUES ('r1', 'review', 'unknown-model', 1, 1, 0, 0, ${dayStart + 9});`);
    expect(await repo.dailySpendUsd("acme/demo", NOW)).toBeNull();
  });

  it("keeps only fixed values: a decision outside the list is refused", () => {
    const { exec } = setup();
    expect(() =>
      exec(
        `INSERT INTO triage (repo, issue_number, author_id, decision, body_sha256, created_at) VALUES ('a/b', 1, '1', 'maybe', 'x', 1)`,
      ),
    ).toThrow();
  });
});
