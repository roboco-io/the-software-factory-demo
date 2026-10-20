import { z } from "zod";
import type { TimedResult } from "../agents/budget";
import type { Budget, EngineName, FailureReason, Role } from "../agents/types";
import type { GitHubPort, Issue, Permission } from "../github/port";
import type { RunRecord } from "../runs/store";
import {
  canTransition,
  stateFromLabels,
  stateLabel,
  transition,
  type Actor,
  type State,
} from "../state/machine";
import { syncBoard } from "./board";
import type { Settings, StageDeps } from "./deps";
import { requestPostmortem } from "./postmortem-trigger";

export const FailureReasonSchema = z.enum([
  "max_turns",
  "timeout",
  "budget",
  "engine_error",
  "invalid_output",
]);

// agent VM이 만든 결과 파일 안의 에이전트 실행 결과를 검증하는 스키마.
export const TimedResultSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  model: z.string(),
  turns: z.number().int().min(0),
  costUsd: z.number().min(0).optional(),
  usage: z.object({ inputTokens: z.number().min(0), outputTokens: z.number().min(0) }),
  failureReason: FailureReasonSchema.optional(),
  durationMs: z.number().min(0),
});

export const WRITE_PERMISSIONS: readonly Permission[] = ["admin", "maintain", "write"];
export const ROUND_PREFIX = "factory:round-";
export const MAX_ROUNDS = 3;

export function branchFor(issue: number): string {
  return `factory/issue-${issue}`;
}

export function isBot(settings: Settings, login: string): boolean {
  return login === settings.botLogin;
}

export async function isWriter(gh: GitHubPort, user: string): Promise<boolean> {
  return WRITE_PERMISSIONS.includes(await gh.getPermission(user));
}

export async function readState(
  gh: GitHubPort,
  n: number,
): Promise<{ issue: Issue; state: State; stale: State[] }> {
  const issue = await gh.getIssue(n);
  return { issue, ...stateFromLabels(issue.labels) };
}

export async function moveTo(
  deps: StageDeps,
  n: number,
  to: State,
  actor: Actor,
  reason?: string,
): Promise<boolean> {
  const { issue, state, stale } = await readState(deps.gh, n);
  if (!canTransition(state, to, actor)) {
    deps.log(`ignored transition #${n}: ${state} → ${to} by ${actor}`);
    return false;
  }
  transition(state, to, actor);
  for (const s of [state, ...stale]) {
    const label = stateLabel(s);
    if (issue.labels.includes(label)) await deps.gh.removeLabel(n, label);
  }
  await deps.gh.addLabels(n, [stateLabel(to)]);
  await syncBoard(deps, n, to);
  if (reason) await deps.gh.comment(n, reason);
  // 사람이 `@factory stop`으로 옮긴 needs-human은 정체가 아니다.
  if (to === "needs-human" && actor !== "command") {
    await requestPostmortem(deps, { issue: n, kind: "stall", event: "detected" });
  }
  return true;
}

export function roundFromLabels(labels: string[]): number {
  let max = 0;
  for (const l of labels) {
    if (!l.startsWith(ROUND_PREFIX)) continue;
    const n = Number(l.slice(ROUND_PREFIX.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function agentRunsOn(runs: RunRecord[], day: string): number {
  return runs.filter((r) => (r.role === "implement" || r.role === "fix") && r.ts.startsWith(day))
    .length;
}

// 오늘 사용한 implement·fix 런 수. 아직 기록되지 않은 진행 중 런은 factory:in-progress 이슈 수로 센다.
export async function usedToday(deps: StageDeps, runs: RunRecord[], day: string): Promise<number> {
  const inFlight = (await deps.gh.listOpenIssues()).filter((i) =>
    i.labels.includes(stateLabel("in-progress")),
  ).length;
  return agentRunsOn(runs, day) + inFlight;
}

export async function blockedReason(deps: StageDeps): Promise<string | null> {
  if (deps.settings.paused) {
    return "팩토리가 일시 중지 상태다(리포 변수 FACTORY_PAUSED=true). 사람이 변수를 false로 바꾸면 다시 진행한다.";
  }
  const day = utcDay(deps.now());
  const used = await usedToday(deps, await deps.runs.since(new Date(`${day}T00:00:00.000Z`)), day);
  if (used >= deps.settings.dailyLimit) {
    return `오늘(UTC ${day}) implement·fix 런이 일일 상한 ${deps.settings.dailyLimit}회에 도달했다. factory-guard가 다음 날(UTC) 다시 시작한다.`;
  }
  return null;
}

const FAILURE_TEXT: Record<FailureReason, string> = {
  max_turns: "최대 턴 수 초과",
  timeout: "시간 초과",
  budget: "비용 예산 초과",
  engine_error: "엔진 오류",
  invalid_output: "출력 형식 오류",
};

export function failureText(reason: string | null | undefined): string {
  return reason && reason in FAILURE_TEXT
    ? FAILURE_TEXT[reason as FailureReason]
    : "알 수 없는 오류";
}

export function budgetText(b: Budget): string {
  return `${b.maxTurns}턴 / ${Math.round(b.timeoutMs / 60_000)}분 / ${b.maxUsd ?? "-"} USD`;
}

export function runLink(settings: Settings): string {
  return settings.runUrl ? ` 워크플로 run: ${settings.runUrl}` : "";
}

export function agentRecord(
  role: Role,
  engine: EngineName,
  model: string,
  r: TimedResult,
  issue: number,
  pr: number | null,
  round: number,
): Omit<RunRecord, "ts"> {
  return {
    issue,
    pr,
    role,
    engine,
    model,
    ok: r.ok,
    turns: r.turns,
    costUsd: r.costUsd ?? null,
    durationMs: r.durationMs,
    failureReason: r.failureReason ?? null,
    round,
  };
}

// agent job이 결과 파일 없이 끝났을 때(비정상 종료) 남기는 실패 런 기록.
export function crashRecord(
  role: Role,
  plan: { issue: number; engine: EngineName; model: string; pr?: number | null; round?: number },
): Omit<RunRecord, "ts"> {
  return {
    issue: plan.issue,
    pr: plan.pr ?? null,
    role,
    engine: plan.engine,
    model: plan.model,
    ok: false,
    turns: 0,
    costUsd: null,
    durationMs: 0,
    failureReason: "engine_error",
    round: plan.round ?? 0,
  };
}

export function stepRecord(
  role: "command" | "gate" | "deploy" | "intake" | "smoke" | "review",
  issue: number,
  pr: number | null,
  ok: boolean,
  failureReason: string | null = null,
  round = 0,
): Omit<RunRecord, "ts"> {
  return {
    issue,
    pr,
    role,
    engine: null,
    model: null,
    ok,
    turns: 0,
    costUsd: null,
    durationMs: 0,
    failureReason,
    round,
  };
}

export async function record(deps: StageDeps, r: Omit<RunRecord, "ts">): Promise<void> {
  await deps.runs.append({ ts: deps.now().toISOString(), ...r });
}
