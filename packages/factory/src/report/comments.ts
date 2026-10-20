import { z } from "zod";
import type { Comment, Review } from "../github/port";
import { TIERS } from "../policy/risk";
import { cell, codeCell, inline, readMarker, sanitize, writeMarker } from "./text";

export const TriageSchema = z.object({
  type: z.enum(["feature", "bug", "docs", "feedback"]),
  duplicateOf: z.number().int().positive().nullable(),
  riskTier: z.enum(TIERS),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  summary: z.string(),
});
export type Triage = z.infer<typeof TriageSchema>;

export const FINDING_CATEGORIES = [
  "error-format",
  "missing-test",
  "security",
  "scope-creep",
  "style",
  "other",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const ReviewSchema = z.object({
  verdict: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  summary: z.string(),
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.number().int().nullable(),
      severity: z.enum(["blocker", "major", "minor"]),
      message: z.string(),
      // 집계(spec 7.2.1)를 위해 고정 목록만 받는다. 빠졌거나 목록 밖이면 other.
      category: z.enum(FINDING_CATEGORIES).catch("other"),
      // 구현 에이전트가 고칠 수 없는 지적(T3 경로 갱신, 설정·시크릿, 사람의 결정)이면 true.
      needsHuman: z.boolean().optional().catch(undefined),
    }),
  ),
  // 이전 리뷰의 미해결 지적(번호는 1부터)마다 이번 head에서 해소됐는지 답한다.
  previous: z
    .array(
      z.object({
        index: z.number().int().min(1),
        resolved: z.boolean(),
        note: z.string().catch(""),
      }),
    )
    .optional()
    .catch(undefined),
});
export type ReviewOutput = z.infer<typeof ReviewSchema>;

// 판정 표식에 남기는 미해결 지적. 다음 라운드 리뷰가 이 목록의 해소 여부를 답해야 승인할 수 있다.
const OpenFindingSchema = z.object({
  file: z.string(),
  message: z.string(),
  needsHuman: z.boolean().catch(false),
});
export type OpenFinding = z.infer<typeof OpenFindingSchema>;

const VerdictSchema = z.object({
  verdict: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  sha: z.string().min(1),
  open: z.array(OpenFindingSchema).catch([]).optional(),
});

export interface Verdict {
  verdict: "APPROVE" | "REQUEST_CHANGES";
  sha: string;
  body: string;
}

const MAX_OPEN = 10;

export function openFindings(r: ReviewOutput): OpenFinding[] {
  return r.findings
    .filter((f) => f.severity !== "minor")
    .slice(0, MAX_OPEN)
    .map((f) => ({
      file: f.file,
      message: f.message.slice(0, 500),
      needsHuman: f.needsHuman ?? false,
    }));
}

const TRIAGE_DATA = "factory:triage-data";
const VERDICT = "factory:verdict";

export function renderTriageComment(t: Triage, run: { engine: string; model: string }): string {
  return [
    "### 트리아지 결과",
    "",
    `- 분류: \`type:${t.type}\``,
    `- 예상 위험 등급: **${t.riskTier}** (최종 등급은 PR의 변경 파일로 다시 판정한다)`,
    `- 중복 후보: ${t.duplicateOf ? `#${t.duplicateOf}` : "없음"}`,
    `- 요약: ${inline(t.summary)}`,
    "",
    "**수용 기준**",
    "",
    ...t.acceptanceCriteria.map((c) => `- [ ] ${inline(c)}`),
    "",
    `<sub>${run.engine}/${run.model}. 구현을 시작하려면 리포 쓰기 권한자가 \`@factory go\`를 코멘트로 남긴다.</sub>`,
    writeMarker(TRIAGE_DATA, t),
  ].join("\n");
}

export function findTriage(comments: Comment[], botLogin: string): Triage | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (c.author !== botLogin) continue;
    const t = readMarker(c.body, TRIAGE_DATA, TriageSchema);
    if (t) return t;
  }
  return null;
}

export function renderReviewBody(
  r: ReviewOutput,
  ctx: { sha: string; engine: string; model: string },
): string {
  const title = r.verdict === "APPROVE" ? "승인(APPROVE)" : "변경 요청(REQUEST_CHANGES)";
  const rows = r.findings.map(
    (f) =>
      `| ${f.severity} | \`${codeCell(f.file)}${f.line ? `:${f.line}` : ""}\` | ${cell(f.message)} |`,
  );
  return [
    `### 팩토리 교차 리뷰: ${title}`,
    "",
    `리뷰어 ${ctx.engine}/${ctx.model}, 대상 커밋 \`${ctx.sha.slice(0, 7)}\`. GitHub App은 자기가 연 PR을 승인할 수 없으므로, 판정은 이 코멘트 리뷰의 표식으로 기록하고 병합 판단(gate)이 읽는다.`,
    "",
    sanitize(r.summary),
    "",
    ...(rows.length > 0
      ? ["| 심각도 | 위치 | 내용 |", "|---|---|---|", ...rows]
      : ["지적 사항 없음."]),
    "",
    writeMarker(VERDICT, { verdict: r.verdict, sha: ctx.sha, open: openFindings(r) }),
  ].join("\n");
}

// 현재 head가 아닌 커밋에 대한 가장 최근 판정의 미해결 지적. 다음 라운드 리뷰의 입력이다.
export function previousOpenFindings(
  reviews: Review[],
  botLogin: string,
  currentSha: string,
): OpenFinding[] {
  for (let i = reviews.length - 1; i >= 0; i--) {
    const r = reviews[i]!;
    if (r.author !== botLogin || r.state === "DISMISSED") continue;
    const v = readMarker(r.body, VERDICT, VerdictSchema);
    if (!v || v.sha === currentSha) continue;
    return v.open ?? [];
  }
  return [];
}

export function latestVerdict(reviews: Review[], botLogin: string, sha: string): Verdict | null {
  for (let i = reviews.length - 1; i >= 0; i--) {
    const r = reviews[i]!;
    if (r.author !== botLogin || r.state === "DISMISSED") continue;
    const v = readMarker(r.body, VERDICT, VerdictSchema);
    if (v && v.sha === sha && r.commitId === v.sha) return { ...v, body: r.body };
  }
  return null;
}
