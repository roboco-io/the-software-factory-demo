import { cell, inline } from "../report/text";
import type { PostmortemAnalysis } from "./analysis";
import type { CandidatePr, Timeline } from "./timeline";

export const POSTMORTEM_MARKER = "factory:postmortem";

// 줄 시작의 블록 마크다운(제목·인용·목록·표·번호·펜스)이 되지 않게 첫 글자를 이스케이프한다.
function line(s: string): string {
  return inline(s)
    .replace(/^(\d+)([.)])/, "$1\\$2")
    .replace(/^([#>\-+*|=~`])/, "\\$1");
}

const TRUNCATED = "\n\n(길이 상한 때문에 이후 내용을 줄였다.)";

function span(t: Timeline): string {
  const { detectedAt, recoveredAt } = t.incident;
  return recoveredAt ? `${detectedAt} - ${recoveredAt}` : `${detectedAt} - 진행 중`;
}

function prRow(c: CandidatePr): string {
  const failing = c.checks.filter((k) => k.state === "fail").map((k) => k.name);
  return `| #${c.number} | ${cell(c.title)} | ${c.author === "bot" ? "봇" : "사람"} | ${cell(c.mergedAt)} | ${c.tier} | ${cell(failing.join(", ") || "-")} |`;
}

function timelineSection(t: Timeline, action: string | null, rows: number): string {
  const i = t.incident;
  const lines = [
    "## 타임라인",
    "",
    `- 마지막 정상: ${inline(i.lastGoodAt ?? "알 수 없음")}`,
    `- 감지: ${inline(i.detectedAt)}`,
    ...(action === null ? [] : [`- 조치: ${inline(action)}`]),
    `- 복구: ${inline(i.recoveredAt ?? "확인 전")}`,
  ];
  if (t.candidates.length > 0) {
    lines.push(
      "",
      "후보 PR(장애 구간 안에 병합된 것):",
      "",
      "| PR | 제목 | 작성자 | 병합 | 위험 등급 | 실패한 체크 |",
      "|---|---|---|---|---|---|",
      ...t.candidates.slice(0, rows).map(prRow),
    );
    if (rows < t.candidates.length) {
      lines.push("", `(후보 ${t.candidates.length - rows}개는 길이 상한 때문에 생략했다.)`);
    }
  }
  return lines.join("\n");
}

function tagged(items: PostmortemAnalysis["rootCause"]): string[] {
  if (items.length === 0) return ["- 기록된 내용이 없다."];
  return items.map((s) => `- ${s.kind === "fact" ? "[사실]" : "[추정]"} ${inline(s.text)}`);
}

// 포스트모템 기록 본문. 분석이 없으면(예산 초과·분석 실패) 타임라인과 생략 사유만 쓴다.
// 길이 상한을 넘으면 타임라인 표를 뒤에서부터 줄이고, 그래도 넘으면 본문을 자른다.
export function renderPostmortem(
  t: Timeline,
  a: PostmortemAnalysis | null,
  outcome: { action: string },
  maxChars: number,
): string {
  const build = (rows: number): string => {
    if (a === null) {
      return [
        `## 요약\n\n분석 생략: ${inline(outcome.action)}`,
        timelineSection(t, null, rows),
      ].join("\n\n");
    }
    return [
      `## 요약\n\n${line(a.summary)}\n\n영향 기간: ${inline(span(t))}`,
      timelineSection(t, outcome.action, rows),
      ["## 원인", "", ...tagged(a.rootCause)].join("\n"),
      ["## 막지 못한 방어선", "", ...tagged(a.defenses)].join("\n"),
      [
        "## 조치와 개선 PR",
        "",
        `- 이번 조치: ${inline(outcome.action)}`,
        ...a.actions.map((x) => `- 권장: ${inline(x)}`),
      ].join("\n"),
    ].join("\n\n");
  };
  for (let rows = t.candidates.length; rows >= 0; rows--) {
    const body = build(rows);
    if (body.length <= maxChars) return body;
  }
  const room = maxChars - TRUNCATED.length;
  return room > 0 ? build(0).slice(0, room) + TRUNCATED : build(0).slice(0, Math.max(0, maxChars));
}
