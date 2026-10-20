import { describe, expect, it } from "vitest";
import {
  decideRevert,
  PostmortemAnalysisSchema,
  type PostmortemAnalysis,
} from "../src/postmortem/analysis";
import type { CandidatePr, Timeline } from "../src/postmortem/timeline";
import { POSTMORTEM_MARKER, renderPostmortem } from "../src/postmortem/report";
import { loadPostmortemPolicy } from "../src/policy/postmortem";

const valid = {
  classification: "bot_regression",
  causePr: 66,
  excerptQuote: "TypeError: x is undefined",
  rootCause: [{ text: "PR 66이 x 초기화를 지웠다", kind: "fact" }],
  defenses: [{ text: "스모크가 이 경로를 확인하지 않았다", kind: "guess" }],
  actions: ["회귀 테스트 추가"],
  summary: "배포 후 기사 목록이 실패했다.",
};

describe("PostmortemAnalysisSchema", () => {
  it("accepts a complete analysis", () => {
    expect(PostmortemAnalysisSchema.parse(valid)).toEqual(valid);
  });

  it("accepts null causePr and excerptQuote", () => {
    const a = { ...valid, classification: "external", causePr: null, excerptQuote: null };
    expect(PostmortemAnalysisSchema.parse(a).causePr).toBeNull();
  });

  it.each([
    ["unknown classification", { classification: "bug" }],
    ["non-positive causePr", { causePr: 0 }],
    ["fractional causePr", { causePr: 1.5 }],
    ["unknown kind", { rootCause: [{ text: "t", kind: "maybe" }] }],
    ["missing summary", { summary: undefined }],
  ])("rejects %s", (_name, patch) => {
    expect(PostmortemAnalysisSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

// 2026-10-21 #66 재생: #65가 Home.tsx의 "conduit" 제목을 지워 e2e-preview와 스모크가 실패했다.
const pr = (over: Partial<CandidatePr> & { number: number }): CandidatePr => ({
  title: `feat: change ${over.number}`,
  author: "bot",
  mergedAt: "2026-10-21T01:00:00.000Z",
  mergeSha: `m${over.number}`,
  tier: "T1",
  files: [],
  checks: [],
  requestIssue: null,
  ...over,
});
const PR_65 = pr({
  number: 65,
  files: [
    {
      path: "apps/web/src/pages/Home.tsx",
      tier: "T1",
      deletions: ['<h1 className="logo-font">conduit</h1>'],
      additions: ["<h1>Home</h1>"],
    },
  ],
  checks: [
    { name: "ci", state: "pass" },
    { name: "e2e-preview", state: "fail" },
  ],
  requestIssue: 60,
});
const PR_70 = pr({
  number: 70,
  mergedAt: "2026-10-21T02:00:00.000Z",
  files: [{ path: "docs/readme.md", tier: "T0", deletions: [], additions: ["hello world"] }],
});
const EXCERPT = "Error: expect(locator).toBeVisible()\ngetByRole('heading', { name: 'conduit' })";
const TIMELINE_66: Timeline = {
  incident: {
    issue: 66,
    kind: "smoke",
    episode: 1,
    detectedAt: "2026-10-21T03:00:00.000Z",
    lastGoodAt: null,
    recoveredAt: null,
  },
  excerpt: EXCERPT,
  candidates: [PR_65, PR_70],
  runs: [],
  windowStart: "2026-10-20T03:00:00.000Z",
};
const A: PostmortemAnalysis = {
  classification: "bot_regression",
  causePr: 65,
  excerptQuote: "getByRole('heading', { name: 'conduit' })",
  rootCause: [
    { text: "PR 65가 Home 제목을 지웠다", kind: "fact" },
    { text: "리뷰가 e2e-preview 실패를 보지 않았을 수 있다", kind: "guess" },
  ],
  defenses: [{ text: "e2e-preview는 필수 체크가 아니다", kind: "fact" }],
  actions: ["제목 복원"],
  summary: "홈 화면 제목이 사라져 스모크가 실패했다.",
};
const POLICY = loadPostmortemPolicy();

describe("decideRevert", () => {
  it("reverts #65 in the #66 replay", () => {
    expect(decideRevert(TIMELINE_66, A, POLICY)).toEqual({
      revert: true,
      pr: expect.objectContaining({ number: 65 }),
    });
  });

  it.each<[string, Partial<PostmortemAnalysis>, string]>([
    ["external", { classification: "external" }, "not_regression"],
    ["stall classification", { classification: "stall" }, "not_regression"],
    ["no cause", { causePr: null }, "no_cause"],
    ["cause outside window", { causePr: 999 }, "unknown_cause"],
    ["no quote", { excerptQuote: null }, "quote_not_in_excerpt"],
    ["invented quote", { excerptQuote: "TypeError: x" }, "quote_not_in_excerpt"],
    ["unrelated PR", { causePr: 70 }, "no_overlap"],
  ])("refuses to revert: %s", (_n, over, reason) => {
    expect(decideRevert(TIMELINE_66, { ...A, ...over }, POLICY)).toEqual({ revert: false, reason });
  });

  it("refuses for deploy and stall incidents", () => {
    for (const kind of ["deploy", "stall"] as const) {
      const t = { ...TIMELINE_66, incident: { ...TIMELINE_66.incident, kind } };
      expect(decideRevert(t, A, POLICY)).toEqual({
        revert: false,
        reason: "not_production_breakage",
      });
    }
  });

  it("refuses without a failure excerpt (#72)", () => {
    expect(decideRevert({ ...TIMELINE_66, excerpt: null }, A, POLICY)).toEqual({
      revert: false,
      reason: "no_excerpt",
    });
  });

  it("refuses when the cause was already reverted", () => {
    const reverted = pr({
      number: 71,
      title: 'Revert "feat: change 65" (#65)',
      mergedAt: "2026-10-21T02:30:00.000Z",
    });
    const t = { ...TIMELINE_66, candidates: [PR_65, PR_70, reverted] };
    expect(decideRevert(t, A, POLICY)).toEqual({ revert: false, reason: "already_reverted" });
  });

  it("ignores a revert title merged before the cause", () => {
    const early = pr({
      number: 72,
      title: "Revert #65 draft",
      mergedAt: "2026-10-20T23:00:00.000Z",
    });
    const t = { ...TIMELINE_66, candidates: [PR_65, early] };
    expect(decideRevert(t, A, POLICY).revert).toBe(true);
  });

  it("refuses when the policy disables revert", () => {
    const off = { ...POLICY, revert: { ...POLICY.revert, enabled: false } };
    expect(decideRevert(TIMELINE_66, A, off)).toEqual({ revert: false, reason: "disabled" });
  });
});

describe("renderPostmortem", () => {
  it("renders the five sections and tags facts and guesses", () => {
    const body = renderPostmortem(TIMELINE_66, A, { action: "되돌리기 PR #80" }, 6000);
    expect(body).toMatch(
      /## 요약[\s\S]*## 타임라인[\s\S]*## 원인[\s\S]*## 막지 못한 방어선[\s\S]*## 조치/,
    );
    expect(body).toContain("[사실] PR 65가 Home 제목을 지웠다");
    expect(body).toContain("[추정] 리뷰가");
    expect(body).toContain("되돌리기 PR");
    expect(body).toContain("e2e-preview");
  });

  it("stays under maxChars by trimming timeline rows from the end", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      pr({ number: 1000 + i, title: `feat: a long title number ${i} ${"x".repeat(40)}` }),
    );
    const big = { ...TIMELINE_66, candidates: [PR_65, ...many] };
    const body = renderPostmortem(big, A, { action: "x" }, 6000);
    expect(body.length).toBeLessThanOrEqual(6000);
    expect(body).toContain("#65");
    expect(body).toContain("## 조치");
  });

  it("writes only the timeline and the reason when the analysis is missing", () => {
    const body = renderPostmortem(TIMELINE_66, null, { action: "일일 예산 초과" }, 6000);
    expect(body).toContain("분석 생략: 일일 예산 초과");
    expect(body).toContain("## 타임라인");
    expect(body).not.toContain("## 원인");
  });

  it("neutralizes mentions, closing keywords and markers from external text", () => {
    const evil = {
      ...A,
      summary: "fixes #1 @someone <!-- factory:x {} -->",
      rootCause: [{ text: "closes #2\n## 가짜 절", kind: "fact" as const }],
    };
    const body = renderPostmortem(TIMELINE_66, evil, { action: "x" }, 6000);
    expect(body).not.toMatch(/fixes #1/);
    expect(body).not.toMatch(/closes #2/);
    expect(body).not.toContain("@someone");
    expect(body).not.toContain("<!--");
    expect(body.match(/^## 가짜 절/m)).toBeNull();
  });

  it("exposes the marker name", () => {
    expect(POSTMORTEM_MARKER).toBe("factory:postmortem");
  });
});
