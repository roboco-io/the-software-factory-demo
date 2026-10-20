import { z } from "zod";
import { runStructured, type TimedResult } from "../agents/budget";
import { loadPrompt, renderPrompt } from "../agents/prompt";
import type { Budget, EngineName } from "../agents/types";
import { resolveModel, toBudget } from "../config/agents";
import {
  PostmortemAnalysisSchema,
  decideRevert,
  type PostmortemAnalysis,
  type RevertRefusal,
} from "../postmortem/analysis";
import { resolveIncident, incidentKey, type Incident } from "../postmortem/incident";
import { POSTMORTEM_MARKER, renderPostmortem } from "../postmortem/report";
import { collectTimeline, type Timeline } from "../postmortem/timeline";
import { REVERT_TRAILER } from "../report/commit";
import type { PrMeta } from "../report/pr";
import { codeBlock, inline, readMarker, writeMarker } from "../report/text";
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

function info(
  plan: PostmortemPlan,
  analysis: PostmortemAnalysis | null,
  reverted = false,
): IncidentInfo {
  return {
    key: incidentKey(plan.incident),
    kind: plan.incident.kind,
    phase: plan.phase,
    detectedAt: plan.incident.detectedAt,
    recoveredAt: plan.incident.recoveredAt,
    causePr: analysis?.causePr ?? null,
    reverted,
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
    // 되돌리기는 1차 분석에서만 한다. 재생(dryRun)은 판정만 보여 주고 아무것도 만들지 않는다.
    const revert =
      analysis && plan.phase === "initial"
        ? plan.args.dryRun
          ? dryRunText(plan, analysis, deps)
          : await tryRevert(deps, plan, analysis)
        : null;
    const action = analysis
      ? (revert?.action ?? "진단을 기록했다. 사후 분석은 복구 뒤에 같은 기록을 갱신한다.")
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
    await recordOnce(deps, plan, out, revert?.reverted ?? false);
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

async function recordOnce(
  deps: StageDeps,
  plan: PostmortemPlan,
  out: PostmortemOutcome,
  reverted: boolean,
) {
  if (RECORDED.has(plan)) return;
  RECORDED.add(plan);
  const incident = info(plan, out.analysis, reverted);
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

const REFUSAL_TEXT: Record<RevertRefusal, string> = {
  disabled: "정책이 자동 되돌리기를 끄고 있어 되돌리지 않았다",
  not_production_breakage: "배포 실패·정체는 되돌리지 않고 진단만 남긴다",
  not_regression: "분류가 PR 회귀가 아니어서 되돌리지 않았다",
  no_cause: "원인 PR을 하나로 지목하지 못해 되돌리지 않았다",
  unknown_cause: "지목한 PR이 장애 구간의 후보에 없어 되돌리지 않았다",
  no_excerpt: "실패 원문이 없어 되돌리지 않았다",
  quote_not_in_excerpt: "분석의 인용이 실패 원문에 없어 되돌리지 않았다",
  no_overlap: "실패 원문과 원인 PR의 변경 파일이 겹치지 않아 되돌리지 않았다",
  already_reverted: "원인 PR은 이미 되돌려졌다. 되돌리지 않았다",
};

const MIGRATIONS = "apps/api/migrations/";

function dryRunText(
  plan: PostmortemPlan,
  analysis: PostmortemAnalysis,
  deps: StageDeps,
): { action: string; reverted: boolean } {
  const d = decideRevert(plan.timeline, analysis, deps.postmortem);
  const verdict = d.revert ? `PR #${d.pr.number}을 되돌릴 수 있다` : REFUSAL_TEXT[d.reason];
  return { action: `재생이라 되돌리지 않았다. 판정: ${verdict}`, reverted: false };
}

// 되돌리기 판정(spec 4.4)과 PR 생성. 충돌(조건 5)은 git 결과로 판정한다.
async function tryRevert(
  deps: StageDeps,
  plan: PostmortemPlan,
  analysis: PostmortemAnalysis,
): Promise<{ action: string; reverted: boolean }> {
  const no = (action: string) => ({ action, reverted: false });
  const d = decideRevert(plan.timeline, analysis, deps.postmortem);
  if (!d.revert) return no(REFUSAL_TEXT[d.reason]);
  const { pr: cause } = d;
  const issue = plan.args.issue;
  const branch = `factory/revert-issue-${issue}`;
  const open = await deps.gh.findOpenPullByHead(branch);
  if (open) return no(`열린 되돌리기 PR #${open.number}이 이미 있어 새로 만들지 않았다`);
  if (!cause.mergeSha) return no(`PR #${cause.number}의 병합 커밋을 알 수 없어 되돌리지 않았다`);
  const token = deps.settings.token;
  if (!token) throw new Error("postmortem publish requires FACTORY_TOKEN");
  const title = `revert: #${cause.number} ${inline(cause.title)} (장애 #${issue})`;
  const trailer = `${REVERT_TRAILER}: #${issue}`;
  await deps.git.fetch("main");
  await deps.git.checkoutNewBranch(branch, "origin/main");
  const sha = await deps.git.revert(cause.mergeSha, `${title}\n\n${trailer}`);
  if (sha === null) {
    return no(
      `되돌리기 충돌: PR #${cause.number} 이후의 커밋과 충돌해 자동으로 되돌리지 못했다. 사람이 확인한다`,
    );
  }
  // 마이그레이션은 이미 프로덕션 D1에 적용됐을 수 있어 되돌리지 않는다.
  const migrations = cause.files.filter((f) => f.path.startsWith(MIGRATIONS)).map((f) => f.path);
  if (migrations.length > 0) {
    await deps.git.restorePaths(migrations, cause.mergeSha);
    await deps.git.commitAll(
      `revert: 마이그레이션 파일은 되돌리지 않는다 (장애 #${issue})\n\n${trailer}`,
    );
  }
  await deps.git.push(branch, token);
  const meta: PrMeta = {
    issue,
    role: "revert",
    implementEngine: plan.engine,
    implementModel: plan.model,
    round: 0,
  };
  const body = [
    `장애 #${issue}의 원인으로 판정한 PR #${cause.number}을 되돌린다. 포스트모템 기록은 장애 이슈 #${issue}의 코멘트에 있다.`,
    "",
    `요약: ${inline(analysis.summary)}`,
    "",
    "근거인 실패 원문 인용:",
    "",
    codeBlock(analysis.excerptQuote ?? ""),
    ...(migrations.length > 0
      ? [
          "",
          `마이그레이션 파일(${migrations.map((m) => `\`${inline(m).replace(/`/g, "'")}\``).join(", ")})은 되돌리지 않았다.`,
        ]
      : []),
    "",
    writeMarker("factory:meta", meta),
  ].join("\n");
  const pr = await deps.gh.createPull({ title, body, head: branch, base: "main", draft: false });
  return {
    action: `되돌리기 PR #${pr}을 열었다(원인 PR #${cause.number}). 병합은 위험 등급에 따라 gate가 처리한다`,
    reverted: true,
  };
}
