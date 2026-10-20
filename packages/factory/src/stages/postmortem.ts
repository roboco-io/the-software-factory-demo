import { z } from "zod";
import { runStructured, type TimedResult } from "../agents/budget";
import { loadPrompt, renderPrompt } from "../agents/prompt";
import type { Budget, EngineName } from "../agents/types";
import { resolveModel, toBudget } from "../config/agents";
import { PostmortemAnalysisSchema, type PostmortemAnalysis } from "../postmortem/analysis";
import { resolveIncident, incidentKey, type Incident } from "../postmortem/incident";
import { POSTMORTEM_MARKER, renderPostmortem } from "../postmortem/report";
import { collectTimeline, type Timeline } from "../postmortem/timeline";
import { readMarker, writeMarker } from "../report/text";
import type { IncidentInfo, RunRecord } from "../runs/store";
import {
  TimedResultSchema,
  agentRecord,
  crashRecord,
  failureText,
  isBot,
  record,
  utcDay,
} from "./common";
import type { StageDeps } from "./deps";
import type { PhasedStage } from "./phased";
import type { IncidentKind, PostmortemEvent } from "./postmortem-trigger";
import { clampResult } from "./protect";

export interface PostmortemArgs {
  issue: number;
  kind: IncidentKind;
  event: PostmortemEvent;
  dryRun?: boolean;
  excerptOverride?: string;
}

export type SkipAnalysis = null | "budget_incident" | "budget_daily";

export interface PostmortemPlan {
  args: PostmortemArgs;
  incident: Incident;
  timeline: Timeline;
  phase: "initial" | "followup";
  engine: EngineName;
  model: string;
  budget: Budget;
  prompt: string;
  skipAnalysis: SkipAnalysis;
}

export interface PostmortemOutcome {
  result: TimedResult;
  analysis: PostmortemAnalysis | null;
}

const Text = z.string().max(2_000);
const Statement = z.object({ text: Text, kind: z.enum(["fact", "guess"]) });
// agent VM이 쓴 결과 파일은 신뢰할 수 없다. 길이를 제한해 기록이 부풀지 않게 한다.
const BoundedAnalysisSchema = PostmortemAnalysisSchema.extend({
  excerptQuote: z.string().max(4_000).nullable(),
  rootCause: z.array(Statement).max(20),
  defenses: z.array(Statement).max(20),
  actions: z.array(Text).max(20),
  summary: z.string().max(4_000),
});
const OutcomeSchema = z.object({
  result: TimedResultSchema,
  analysis: BoundedAnalysisSchema.nullable(),
});

const SKIP_TEXT: Record<Exclude<SkipAnalysis, null>, string> = {
  budget_incident: "이 장애의 분석 횟수 한도에 도달했다",
  budget_daily: "오늘(UTC) 포스트모템 비용이 일일 상한에 도달했다",
};

const PRODUCTION_LABEL: Record<Exclude<IncidentKind, "stall">, string> = {
  smoke: "source:smoke",
  deploy: "source:deploy",
  error: "source:error",
};

// 트리거 필터(spec 4.2). 정체는 가장 최근 실패 사유가 정책 목록에 있고 제외 목록에 없을 때만 본다.
async function triggered(
  deps: StageDeps,
  args: PostmortemArgs,
  labels: string[],
): Promise<boolean> {
  const { triggers } = deps.postmortem;
  if (args.kind !== "stall") {
    const label = PRODUCTION_LABEL[args.kind];
    return triggers.production.includes(label) && labels.includes(label);
  }
  const failures = (await deps.runs.since(new Date(0))).filter(
    (r) => r.issue === args.issue && !r.ok && r.role !== "postmortem",
  );
  const reason = failures.at(-1)?.failureReason;
  return (
    !!reason && triggers.stall.reasons.includes(reason) && !triggers.stall.exclude.includes(reason)
  );
}

const minOf = (a: number | undefined, b: number): number => (a === undefined ? b : Math.min(a, b));

function info(plan: PostmortemPlan, analysis: PostmortemAnalysis | null): IncidentInfo {
  return {
    key: incidentKey(plan.incident),
    kind: plan.incident.kind,
    phase: plan.phase,
    detectedAt: plan.incident.detectedAt,
    recoveredAt: plan.incident.recoveredAt,
    causePr: analysis?.causePr ?? null,
    reverted: false,
    classification: analysis?.classification ?? null,
  };
}

const SKIPPED = {
  ok: false,
  summary: "skipped",
  turns: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
  durationMs: 0,
} as const;

// 이미 실행 기록을 남긴 계획. publish 도중 예외가 나도 crashed()가 같은 런을 다시 세지 않게 한다.
const RECORDED = new WeakSet<PostmortemPlan>();

export const postmortemStage: PhasedStage<PostmortemArgs, PostmortemPlan, PostmortemOutcome> = {
  name: "postmortem",

  async prepare(deps, args) {
    const issue = await deps.gh.getIssue(args.issue);
    if (!(await triggered(deps, args, issue.labels))) return null;
    const incident = await resolveIncident(deps, args.issue, args.kind);
    const phase = args.event === "recovered" ? "followup" : "initial";
    const key = incidentKey(incident);
    const mine = (await deps.runs.since(new Date(0))).filter((r) => r.role === "postmortem");
    // 같은 (장애, 단계)는 한 번만 처리한다. 재실행·중복 dispatch가 두 번째 분석을 만들지 않는다.
    // 재생(dryRun)은 이미 처리된 장애를 다시 분석하는 것이 목적이다.
    if (!args.dryRun && mine.some((r) => r.incident?.key === key && r.incident.phase === phase)) {
      return null;
    }
    const { budget: policy } = deps.postmortem;
    const analyses = mine.filter((r) => r.incident?.key === key && r.engine !== null).length;
    const day = utcDay(deps.now());
    const spent = mine
      .filter((r) => r.ts.startsWith(day))
      .reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    const skipAnalysis: SkipAnalysis =
      analyses >= policy.perIncidentAnalyses
        ? "budget_incident"
        : spent >= policy.dailyUsd
          ? "budget_daily"
          : null;
    const role = deps.agents.roles.postmortem;
    const configured = toBudget(role.budget);
    const budget: Budget = {
      maxTurns: configured.maxTurns,
      timeoutMs: Math.min(configured.timeoutMs, Math.round(policy.perAnalysisMinutes * 60_000)),
      maxUsd: minOf(configured.maxUsd, policy.perAnalysisUsd),
    };
    const timeline = await collectTimeline(deps, incident, {
      ...(args.excerptOverride ? { excerptOverride: args.excerptOverride } : {}),
    });
    const model = resolveModel(deps.agents, role.engine, deps.settings.env);
    return {
      args,
      incident,
      timeline,
      phase,
      engine: role.engine,
      model,
      budget,
      prompt: renderPrompt(loadPrompt("postmortem"), { timeline: JSON.stringify(timeline) }),
      skipAnalysis,
    };
  },

  async agent(deps, plan) {
    if (plan.skipAnalysis) {
      return {
        result: { ...SKIPPED, model: plan.model, failureReason: "budget" },
        analysis: null,
      };
    }
    const { result, value } = await runStructured(
      deps.adapterFor(plan.engine, plan.model),
      {
        role: "postmortem",
        prompt: plan.prompt,
        cwd: deps.settings.workdir,
        readOnly: true,
        budget: plan.budget,
      },
      PostmortemAnalysisSchema,
    );
    return { result, analysis: value };
  },

  parseOutcome(raw) {
    return OutcomeSchema.parse(raw);
  },

  async publish(deps, plan, out) {
    const { analysis } = out;
    const { maxChars } = deps.postmortem.report;
    const marker = writeMarker(POSTMORTEM_MARKER, {
      key: incidentKey(plan.incident),
      phase: plan.phase,
    });
    const action = analysis
      ? "진단을 기록했다. 되돌리기·재오픈·개선 PR은 이 기록에 따로 남긴다."
      : plan.skipAnalysis
        ? SKIP_TEXT[plan.skipAnalysis]
        : `분석 실패(${failureText(out.result.failureReason)})`;
    const body = renderPostmortem(
      plan.timeline,
      analysis,
      { action },
      maxChars - marker.length - 2,
    );
    if (plan.args.dryRun) {
      // 재생: 장애 이슈를 건드리지 않고 새 이슈에만 쓴다. 런 기록도 남기지 않는다.
      await deps.gh.createIssue(
        `[포스트모템 재생] #${plan.args.issue}`,
        `${body}\n\n${marker}`,
        [],
      );
      return;
    }
    await recordOnce(deps, plan, out);
    const key = incidentKey(plan.incident);
    const existing = (await deps.gh.listComments(plan.args.issue)).find(
      (c) =>
        isBot(deps.settings, c.author) &&
        readMarker(c.body, POSTMORTEM_MARKER, z.object({ key: z.string() }).passthrough())?.key ===
          key,
    );
    // 사후 분석을 못 했다고 1차 분석 기록을 지우지 않는다.
    if (existing && !analysis) return;
    if (existing) await deps.gh.editComment(existing.id, `${body}\n\n${marker}`);
    else await deps.gh.comment(plan.args.issue, `${body}\n\n${marker}`);
  },

  async crashed(deps, plan) {
    if (plan.args.dryRun || RECORDED.has(plan)) return;
    RECORDED.add(plan);
    await record(deps, {
      ...crashRecord("postmortem", { ...plan, issue: plan.args.issue }),
      incident: info(plan, null),
    });
  },
};

async function recordOnce(deps: StageDeps, plan: PostmortemPlan, out: PostmortemOutcome) {
  if (RECORDED.has(plan)) return;
  RECORDED.add(plan);
  const incident = info(plan, out.analysis);
  const ran = plan.skipAnalysis === null;
  const base: Omit<RunRecord, "ts"> = ran
    ? agentRecord(
        "postmortem",
        plan.engine,
        plan.model,
        clampResult(out.result, plan.budget, out.analysis !== null),
        plan.args.issue,
        null,
        0,
      )
    : {
        issue: plan.args.issue,
        pr: null,
        role: "postmortem",
        engine: null,
        model: null,
        ok: false,
        turns: 0,
        costUsd: null,
        durationMs: 0,
        failureReason: "budget",
        round: 0,
      };
  await record(deps, { ...base, incident });
}
