import { z } from "zod";
import type { Issue } from "../github/port";
import { cell, codeCell, inline, codeBlock, readMarker, writeMarker } from "../report/text";
import { isBot, record, runLink, stepRecord } from "./common";
import type { Settings, StageDeps } from "./deps";
import { requestPostmortem } from "./postmortem-trigger";

export const INTAKE_MARKER = "factory:intake";
export const INTAKE_SOURCES = ["source:error", "source:feedback", "source:smoke"] as const;

const IntakeKeySchema = z.object({
  kind: z.enum(["error", "feedback", "smoke"]),
  key: z.string().min(1).max(100),
});
export type IntakeKind = z.infer<typeof IntakeKeySchema>["kind"];

export function intakeMarker(kind: IntakeKind, key: string): string {
  return writeMarker(INTAKE_MARKER, { kind, key });
}

// 사람이 연 이슈의 표식은 믿지 않는다. 봇이 연 이슈(PR 제외)의 마지막 표식만 본다.
function matches(i: Issue, settings: Settings, kind: IntakeKind, key: string): boolean {
  if (i.isPullRequest || !isBot(settings, i.author)) return false;
  const m = readMarker(i.body, INTAKE_MARKER, IntakeKeySchema);
  return m !== null && m.kind === kind && m.key === key;
}

export function findIntakeIssue(
  issues: Issue[],
  settings: Settings,
  kind: IntakeKind,
  key: string,
): Issue | null {
  return issues.find((i) => i.state === "open" && matches(i, settings, kind, key)) ?? null;
}

const Timestamp = z.string().max(40);
// API 응답은 신뢰하지 않는다. 형식이 틀리면 아무 이슈도 만들지 않고 ack도 하지 않는다.
export const IntakeResponseSchema = z.object({
  errors: z
    .array(
      z.object({
        fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
        message: z.string().max(2000),
        path: z.string().max(200),
        count: z.number().int().positive(),
        firstSeen: Timestamp,
        lastSeen: Timestamp,
      }),
    )
    .max(50),
  feedback: z
    .array(
      z.object({
        id: z.number().int().positive(),
        body: z.string().min(1).max(2000),
        path: z.string().max(200),
        createdAt: Timestamp,
      }),
    )
    .max(50),
});
export type IntakeError = z.infer<typeof IntakeResponseSchema>["errors"][number];
export type IntakeFeedback = z.infer<typeof IntakeResponseSchema>["feedback"][number];

// API의 ack 본문. 에러는 목록에서 읽은 lastSeen을 함께 보내, 읽은 뒤 다시 발생한 에러가 ack되지 않게 한다.
export const IntakeAckSchema = z.object({
  errors: z
    .array(z.object({ fingerprint: z.string().regex(/^[0-9a-f]{16}$/), lastSeen: Timestamp }))
    .max(50),
  feedback: z.array(z.number().int().positive()).max(50),
});
export type IntakeAck = z.infer<typeof IntakeAckSchema>;

export interface IntakeClient {
  pending(): Promise<unknown>;
  ack(input: IntakeAck): Promise<void>;
}

const SHAPE_ERROR = "intake 응답 형식이 틀렸다";

// 오류 메시지에 토큰을 넣지 않는다.
export function createIntakeClient(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): IntakeClient {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    async pending() {
      const res = await fetchImpl(`${base}/_factory/intake`, { headers });
      if (!res.ok) {
        throw new Error(
          `intake 목록 요청이 HTTP ${res.status}로 실패했다(404는 INTAKE_TOKEN 불일치일 수 있다)`,
        );
      }
      try {
        const parsed: unknown = await res.json();
        return parsed;
      } catch {
        throw new Error(`${SHAPE_ERROR}(JSON이 아니다). 아무것도 처리하지 않는다.`);
      }
    },
    async ack(input) {
      const res = await fetchImpl(`${base}/_factory/intake/ack`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`intake ack 요청이 HTTP ${res.status}로 실패했다`);
    },
  };
}

function short(s: string, max: number): string {
  const t = inline(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const GO_NOTE = "구현은 리포 쓰기 권한자의 `@factory go`가 있어야 시작한다.";

export function renderErrorIssue(
  e: IntakeError,
  settings: Settings,
  previous: number | null = null,
): { title: string; body: string } {
  const regression =
    previous === null
      ? []
      : [
          `같은 fingerprint의 이전 이슈 #${previous}은 닫혀 있다. 고친 뒤 다시 발생한 회귀일 수 있다.`,
          "",
        ];
  return {
    title: `[에러] ${short(e.message, 80) || e.fingerprint}`,
    body: [
      "프로덕션 API에서 처리되지 않은 예외가 기록되었다. 아래 값은 Worker가 기록한 것이며 신뢰할 수 없는 입력으로 다룬다. 메시지와 경로의 숫자·UUID·slug는 `{n}`·`{uuid}`·`{slug}`로 정규화되어 있다.",
      "",
      ...regression,
      "| 항목 | 값 |",
      "|---|---|",
      `| fingerprint | \`${e.fingerprint}\` |`,
      `| 경로 | \`${codeCell(e.path)}\` |`,
      `| 발생 횟수 | ${e.count} |`,
      `| 처음 발생 | ${cell(e.firstSeen)} |`,
      `| 마지막 발생 | ${cell(e.lastSeen)} |`,
      "",
      "대표 메시지:",
      "",
      codeBlock(e.message || "(메시지 없음)"),
      "",
      `같은 fingerprint의 에러가 다시 기록되면 새 이슈 대신 이 이슈에 코멘트로 횟수를 갱신한다. ${GO_NOTE}${runLink(settings)}`,
      "",
      intakeMarker("error", e.fingerprint),
      writeMarker("factory:error-first-seen", { at: e.firstSeen }),
    ].join("\n"),
  };
}

// 반복 코멘트가 이슈를 뒤덮지 않도록 횟수 임계(1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, ...)를 넘었을 때,
// 또는 봇의 마지막 횟수 코멘트로부터 24시간이 지났을 때만 코멘트한다.
const REPEAT_MARKER = "factory:intake-count";
const RepeatMarkerSchema = z.object({
  count: z.number().int().nonnegative(),
  at: z.string().max(40),
});
const REPEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function crossedThreshold(prev: number, next: number): boolean {
  if ([1, 2, 5].some((t) => t > prev && t <= next)) return true;
  for (let base = 10; base <= next; base *= 10) {
    if ([base, base * 2.5, base * 5].some((t) => t > prev && t <= next)) return true;
  }
  return false;
}

export function renderErrorRepeat(e: IntakeError, settings: Settings, now: Date): string {
  return [
    `같은 에러(fingerprint \`${e.fingerprint}\`)가 다시 기록되었다. 누적 ${e.count}회, 마지막 발생 ${cell(e.lastSeen)}.${runLink(settings)}`,
    "",
    writeMarker(REPEAT_MARKER, { count: e.count, at: now.toISOString() }),
  ].join("\n");
}

async function shouldComment(deps: StageDeps, issue: Issue, e: IntakeError): Promise<boolean> {
  const mine = (await deps.gh.listComments(issue.number)).filter((c) =>
    isBot(deps.settings, c.author),
  );
  let last: z.infer<typeof RepeatMarkerSchema> | null = null;
  for (const c of mine) last = readMarker(c.body, REPEAT_MARKER, RepeatMarkerSchema) ?? last;
  if (!last) return true;
  if (crossedThreshold(last.count, e.count)) return true;
  const at = Date.parse(last.at);
  return Number.isNaN(at) || deps.now().getTime() - at >= REPEAT_INTERVAL_MS;
}

export function renderFeedbackIssue(
  f: IntakeFeedback,
  settings: Settings,
): { title: string; body: string } {
  return {
    title: `[피드백] ${short(f.body, 60) || `#${f.id}`}`,
    body: [
      "앱 푸터의 피드백 버튼으로 익명 사용자가 보낸 의견이다. 본문은 신뢰할 수 없는 입력으로 다룬다. API는 IP 원문을 저장하지 않는다.",
      "",
      "| 항목 | 값 |",
      "|---|---|",
      `| 피드백 ID | ${f.id} |`,
      `| 화면 경로 | \`${codeCell(f.path)}\` |`,
      `| 받은 시각 | ${cell(f.createdAt)} |`,
      "",
      "본문:",
      "",
      codeBlock(f.body),
      "",
      `${GO_NOTE}${runLink(settings)}`,
      "",
      intakeMarker("feedback", String(f.id)),
    ].join("\n"),
  };
}

export interface IntakeSummary {
  created: number[];
  updated: number[];
  acked: { errors: number; feedback: number };
  failed: number;
}

export async function runIntake(deps: StageDeps, client: IntakeClient): Promise<IntakeSummary> {
  const parsed = IntakeResponseSchema.safeParse(await client.pending());
  if (!parsed.success) {
    throw new Error(
      `${SHAPE_ERROR}(문제 ${parsed.error.issues.length}개). 아무것도 처리하지 않는다.`,
    );
  }
  const open = await deps.gh.listOpenIssues();
  // 닫힌 유입 이슈는 열린 이슈에서 찾지 못했을 때만, 라벨별로 한 번 읽는다.
  const closedByLabel = new Map<string, Promise<Issue[]>>();
  const latestClosed = async (label: string, kind: IntakeKind, key: string) => {
    let list = closedByLabel.get(label);
    if (!list) {
      list = deps.gh.listClosedIssuesWithLabel(label);
      closedByLabel.set(label, list);
    }
    const hits = (await list).filter(
      (i) => i.state === "closed" && matches(i, deps.settings, kind, key),
    );
    return hits.reduce<Issue | null>((a, b) => (a && a.number > b.number ? a : b), null);
  };
  const summary: IntakeSummary = {
    created: [],
    updated: [],
    acked: { errors: 0, feedback: 0 },
    failed: 0,
  };
  const ack: IntakeAck = { errors: [], feedback: [] };
  // 이슈·코멘트가 이미 만들어진 뒤의 기록 실패로 항목을 실패 처리하면 ack가 빠져 중복 이슈가 생긴다. 로그만 남긴다.
  const tryRecord = async (n: number) => {
    try {
      await record(deps, stepRecord("intake", n, null, true));
    } catch (err) {
      deps.log(`intake: #${n} 실행 기록 실패(무시): ${String(err)}`);
    }
  };
  const create = async (issue: { title: string; body: string }, labels: string[]) => {
    const n = await deps.gh.createIssue(issue.title, issue.body, labels);
    open.push({
      number: n,
      title: issue.title,
      body: issue.body,
      author: deps.settings.botLogin,
      labels,
      state: "open",
      isPullRequest: false,
    });
    summary.created.push(n);
    await tryRecord(n);
  };
  for (const e of parsed.data.errors) {
    try {
      const existing = findIntakeIssue(open, deps.settings, "error", e.fingerprint);
      if (existing) {
        if (await shouldComment(deps, existing, e)) {
          await deps.gh.comment(existing.number, renderErrorRepeat(e, deps.settings, deps.now()));
          summary.updated.push(existing.number);
          await tryRecord(existing.number);
        }
      } else {
        // 같은 fingerprint의 이슈가 닫혀 있으면 코멘트하지 않고 회귀로 새 이슈를 연다.
        const previous = await latestClosed("source:error", "error", e.fingerprint);
        await create(renderErrorIssue(e, deps.settings, previous?.number ?? null), [
          "source:error",
          "type:bug",
        ]);
        await requestPostmortem(deps, {
          issue: summary.created[summary.created.length - 1]!,
          kind: "error",
          event: "detected",
        });
      }
      ack.errors.push({ fingerprint: e.fingerprint, lastSeen: e.lastSeen });
    } catch (err) {
      summary.failed++;
      deps.log(`intake: error ${e.fingerprint} 처리 실패, ack하지 않는다: ${String(err)}`);
    }
  }
  for (const f of parsed.data.feedback) {
    try {
      // 이전 실행이 이슈를 만든 뒤 ack에 실패했다면 같은 피드백이 다시 온다. 이미 있는 이슈(열림·닫힘)를 재사용한다.
      const key = String(f.id);
      const seen =
        findIntakeIssue(open, deps.settings, "feedback", key) ??
        (await latestClosed("source:feedback", "feedback", key));
      if (!seen) await create(renderFeedbackIssue(f, deps.settings), ["source:feedback"]);
      ack.feedback.push(f.id);
    } catch (err) {
      summary.failed++;
      deps.log(`intake: feedback ${f.id} 처리 실패, ack하지 않는다: ${String(err)}`);
    }
  }
  if (ack.errors.length + ack.feedback.length > 0) {
    try {
      await client.ack(ack);
      summary.acked = { errors: ack.errors.length, feedback: ack.feedback.length };
    } catch (err) {
      // 이슈는 이미 만들었다. 요약은 출력되어야 하므로 던지지 않고 실패로 센다. 다음 실행이 같은 항목을 중복 없이 ack한다.
      summary.failed += ack.errors.length + ack.feedback.length;
      deps.log(`intake: ack 실패, 다음 실행에서 다시 시도한다: ${String(err)}`);
    }
  }
  return summary;
}
