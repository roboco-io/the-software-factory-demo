import { z } from "zod";
import { runWithBudget, type TimedResult } from "../agents/budget";
import { bugRuleFor, loadPrompt, renderPrompt } from "../agents/prompt";
import type { Budget, EngineName } from "../agents/types";
import { assignEngines, resolveModel } from "../config/agents";
import { CHECK_SCRIPTS, formatCheckFailures } from "../exec/checks";
import type { Issue } from "../github/port";
import { findTriage, renderThreatModel } from "../report/comments";
import { commitMessage } from "../report/commit";
import {
  extractHumanActions,
  extractRisks,
  renderPrBody,
  type PrMeta,
  type PrReport,
} from "../report/pr";
import { codeBlock, codeCell } from "../report/text";
import { canTransition, stateLabel } from "../state/machine";
import {
  ROUND_PREFIX,
  FailureReasonSchema,
  TimedResultSchema,
  agentRecord,
  blockedReason,
  branchFor,
  budgetText,
  crashRecord,
  failureText,
  isBot,
  isWriter,
  moveTo,
  readState,
  record,
  runLink,
} from "./common";
import type { StageDeps } from "./deps";
import type { PhasedStage } from "./phased";
import { clampResult, fileList, importAndVerify } from "./protect";
import { checkWorkdir, commitType, inspectChanges, previewText, sumRuns } from "./worktree";

export interface ImplementArgs {
  issue: number;
  sender?: string;
}

export interface ImplementPlan {
  issue: number;
  title: string;
  branch: string;
  kind: "feat" | "fix" | "docs";
  engine: EngineName;
  model: string;
  budget: Budget;
  fixBudget: Budget;
  prompt: string;
  acceptanceCriteria: string[];
  // prepare 시점의 origin/main 커밋. 에이전트는 여기서 분기하고, publish는 번들 head가 이 커밋의 후손인지 확인한다.
  baseSha: string;
}

export interface AgentRun {
  role: "implement" | "fix";
  result: TimedResult;
}

// 실행 기록은 일일 상한과 차단기의 입력이다. 첫 기록은 반드시 implement, 둘째는 fix여야 한다.
const RunsSchema = z
  .array(z.object({ role: z.enum(["implement", "fix"]), result: TimedResultSchema }))
  .min(1)
  .max(2)
  .refine((runs) => runs.every((r, i) => r.role === (i === 0 ? "implement" : "fix")));

// agent VM이 쓴 결과 파일은 신뢰할 수 없다. 위험 등급과 변경 파일은 담지 않는다(publish가 번들에서 다시 계산한다).
const OutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent-failed"),
    runs: RunsSchema,
    reason: FailureReasonSchema,
  }),
  z.object({
    kind: z.literal("no-changes"),
    runs: RunsSchema,
    // 에이전트가 변경 없이 끝난 이유. 신뢰할 수 없는 값이라 길이를 제한하고 게시할 때 무력화한다.
    summary: z
      .string()
      .transform((s) => s.slice(0, 2000))
      .optional(),
  }),
  z.object({
    kind: z.literal("forbidden-paths"),
    runs: RunsSchema,
    files: z.array(z.string().max(500)).max(200),
  }),
  z.object({
    kind: z.literal("committed"),
    runs: RunsSchema,
    checks: z
      .array(z.object({ name: z.string().max(50), ok: z.boolean(), output: z.string() }))
      .max(CHECK_SCRIPTS.length),
    summary: z.string(),
    sha: z.string().min(1).max(100),
  }),
]);

export type ImplementOutcome = z.infer<typeof OutcomeSchema>;

export interface ImplementPrompt {
  prompt: string;
  // 템플릿 변수. eval-live가 다른 규칙 트리의 템플릿으로 같은 프롬프트를 다시 렌더할 때 쓴다.
  vars: Record<string, string>;
  acceptanceCriteria: string[];
}

// 이슈와 트리아지 수용 기준으로 구현 프롬프트를 만든다. implement와 eval-live가 같은 프롬프트를 쓴다.
export async function buildImplementPrompt(
  deps: StageDeps,
  issue: Pick<Issue, "number" | "title" | "body" | "labels">,
): Promise<ImplementPrompt> {
  const triage = findTriage(await deps.gh.listComments(issue.number), deps.settings.botLogin);
  const criteria = triage?.acceptanceCriteria ?? [];
  const vars = {
    issueNumber: String(issue.number),
    issueTitle: issue.title,
    issueBody: issue.body || "(본문 없음)",
    acceptanceCriteria: [
      criteria.length > 0
        ? criteria.map((c) => `- ${c}`).join("\n")
        : "(트리아지 수용 기준 없음. 이슈 본문을 기준으로 한다.)",
      // 트리아지가 예고한 보호 계약 변경. 에이전트가 고치지 않고 사람 조치로 보고하게 한다(PR #65).
      ...(triage?.contractChanges?.length
        ? [
            "",
            '보호 경로라 바꿀 수 없지만 이 변경으로 기대값이 깨질 것으로 예상되는 파일이다. 고치지 말고, 실제로 깨지면 출력에 "사람 조치 필요:"로 쓴다.',
            ...triage.contractChanges.map((c) => `- ${c}`),
          ]
        : []),
    ].join("\n"),
    threatModel: renderThreatModel(triage?.threatModel),
    bugRule: bugRuleFor(issue.labels),
  };
  return {
    prompt: renderPrompt(loadPrompt("implement"), vars),
    vars,
    acceptanceCriteria: criteria,
  };
}

// 이미 실행 기록을 남긴 계획. publish 도중 예외가 나도 crashed()가 같은 런을 다시 세지 않게 한다.
const RECORDED = new WeakSet<ImplementPlan>();

// 보고된 ok·턴·비용은 에이전트 VM이 쓴 값이다. ok는 검증된 결과로 정하고, 턴과 비용은 역할 예산으로 자른다.
async function recordRuns(
  deps: StageDeps,
  plan: ImplementPlan,
  out: ImplementOutcome,
  implementOk: boolean,
  fixOk: boolean,
): Promise<void> {
  if (RECORDED.has(plan)) return;
  RECORDED.add(plan);
  for (const [i, r] of out.runs.entries()) {
    const ok = i === 0 ? implementOk : fixOk;
    const budget = i === 0 ? plan.budget : plan.fixBudget;
    const result = clampResult(
      r.result,
      budget,
      ok,
      i === 0 && out.kind === "agent-failed" ? out.reason : undefined,
    );
    await record(
      deps,
      agentRecord(
        i === 0 ? "implement" : "fix",
        plan.engine,
        plan.model,
        result,
        plan.issue,
        null,
        0,
      ),
    );
  }
}

export const implementStage: PhasedStage<ImplementArgs, ImplementPlan, ImplementOutcome> = {
  name: "implement",
  async prepare(deps, args) {
    const { issue, state } = await readState(deps.gh, args.issue);
    if (
      issue.isPullRequest ||
      issue.state !== "open" ||
      !canTransition(state, "in-progress", "implement")
    ) {
      return null;
    }
    if (
      args.sender &&
      !isBot(deps.settings, args.sender) &&
      !(await isWriter(deps.gh, args.sender))
    ) {
      await deps.gh.removeLabel(args.issue, stateLabel("approved"));
      await deps.gh.comment(
        args.issue,
        `@${args.sender} 님이 붙인 \`factory:approved\` 라벨을 제거했다. 구현 착수는 리포 권한 write 이상인 사용자만 할 수 있다.`,
      );
      return null;
    }
    const blocked = await blockedReason(deps);
    if (blocked) {
      await deps.gh.comment(args.issue, `구현을 시작하지 않았다. ${blocked}`);
      return null;
    }
    const assignment = assignEngines(deps.agents, issue.labels);
    const engine = assignment.implement.engine;
    const model = resolveModel(deps.agents, engine, deps.settings.env);
    const { prompt, acceptanceCriteria: criteria } = await buildImplementPrompt(deps, issue);
    const branch = branchFor(args.issue);
    await deps.git.fetch("main");
    const baseSha = await deps.git.revParse("origin/main");
    // 위 검사 이후 라벨이 바뀌어 전이가 거부되면(경합) 에이전트를 돌리지 않는다.
    const started = await moveTo(
      deps,
      args.issue,
      "in-progress",
      "implement",
      `구현을 시작했다. 엔진 ${engine}/${model}, 브랜치 \`${branch}\`, 예산 ${budgetText(assignment.implement.budget)}.${runLink(deps.settings)}`,
    );
    if (!started) return null;
    return {
      issue: args.issue,
      title: issue.title,
      branch,
      kind: commitType(issue.labels),
      engine,
      model,
      budget: assignment.implement.budget,
      fixBudget: assignment.fix.budget,
      prompt,
      acceptanceCriteria: criteria,
      baseSha,
    };
  },

  async agent(deps, plan) {
    const runs: AgentRun[] = [];
    const cwd = deps.settings.workdir;
    await deps.git.fetch("main");
    await deps.git.checkoutNewBranch(plan.branch, plan.baseSha);
    const adapter = deps.adapterFor(plan.engine, plan.model);
    const first = await runWithBudget(adapter, {
      role: "implement",
      prompt: plan.prompt,
      cwd,
      readOnly: false,
      budget: plan.budget,
    });
    runs.push({ role: "implement", result: first });
    if (!first.ok)
      return { kind: "agent-failed", runs, reason: first.failureReason ?? "engine_error" };

    let changes = await inspectChanges(deps, plan.baseSha);
    if (changes.files.length === 0)
      return { kind: "no-changes", runs, summary: first.summary.trim().slice(0, 2000) };
    if (changes.forbidden.length > 0)
      return { kind: "forbidden-paths", runs, files: changes.forbidden };

    let checks = await checkWorkdir(deps);
    let summary = first.summary;
    if (!checks.ok) {
      const prompt = renderPrompt(loadPrompt("fix"), {
        target: `이슈 #${plan.issue} 구현(PR 생성 전)`,
        issueNumber: String(plan.issue),
        round: "0",
        feedback: formatCheckFailures(checks.results),
      });
      const fix = await runWithBudget(adapter, {
        role: "fix",
        prompt,
        cwd,
        readOnly: false,
        budget: plan.fixBudget,
      });
      runs.push({ role: "fix", result: fix });
      if (fix.ok && fix.summary.trim())
        summary = `${summary}\n\n로컬 검사 실패 후 수정: ${fix.summary}`;
      changes = await inspectChanges(deps, plan.baseSha);
      if (changes.forbidden.length > 0)
        return { kind: "forbidden-paths", runs, files: changes.forbidden };
      checks = await checkWorkdir(deps);
    }
    const sha = await deps.git.commitAll(
      commitMessage(
        `${plan.kind}: ${plan.title} (#${plan.issue})`,
        summary,
        { engine: plan.engine, model: plan.model },
        plan.issue,
      ),
    );
    // agent job과 publish job은 다른 VM이다. 커밋을 bundle 파일로 넘긴다.
    if (deps.settings.bundlePath) await deps.git.createBundle(deps.settings.bundlePath);
    return { kind: "committed", runs, checks: checks.results, summary, sha };
  },

  parseOutcome(raw) {
    return OutcomeSchema.parse(raw);
  },

  async publish(deps, plan, out) {
    const { state } = await readState(deps.gh, plan.issue);
    const inProgress = state === "in-progress";
    const toHuman = (reason: string) =>
      moveTo(deps, plan.issue, "needs-human", "implement", `${reason}${runLink(deps.settings)}`);
    // 에이전트 단계 동안 사람이 상태를 바꿨으면(예: @factory stop) push도 PR도 만들지 않는다.
    const skip = async (implementOk: boolean, fixOk: boolean): Promise<boolean> => {
      await recordRuns(deps, plan, out, implementOk, fixOk);
      if (inProgress) return false;
      deps.log(`implement: #${plan.issue} is ${state}; skipping publish`);
      return true;
    };
    if (out.kind === "agent-failed") {
      if (await skip(false, false)) return;
      await toHuman(
        `구현 에이전트가 실패했다(사유: ${failureText(out.reason)}, 예산 ${budgetText(plan.budget)}). 사람이 확인한 뒤 \`@factory retry\`로 다시 시작할 수 있다.`,
      );
      return;
    }
    if (out.kind === "no-changes") {
      if (await skip(true, true)) return;
      const fixed =
        "구현 에이전트가 파일을 바꾸지 않았다. 이슈가 구현 가능한 요청인지 사람이 확인한다.";
      const why = out.summary?.trim();
      await toHuman(why ? `${fixed}\n\n에이전트가 남긴 설명:\n\n${codeBlock(why)}` : fixed);
      return;
    }
    if (out.kind === "forbidden-paths") {
      if (await skip(false, false)) return;
      await toHuman(
        `구현 역할이 수정할 수 없는 T3 경로를 바꿔 변경 전체를 버렸다: ${fileList(out.files)}. 팩토리 규칙·워크플로 변경은 사람이 직접 한다.`,
      );
      return;
    }
    // 검사 결과는 에이전트 VM이 보고한 값이다. 세 검사가 모두 있고 통과했을 때만 통과로 본다.
    // 실제 병합 게이트는 CI 필수 체크가 맡는다.
    const checksOk = CHECK_SCRIPTS.every((name) => out.checks.some((c) => c.name === name && c.ok));
    if (!inProgress) {
      await skip(true, checksOk);
      return;
    }
    const rejected = async (reason: string) => {
      await recordRuns(deps, plan, out, false, false);
      await toHuman(reason);
    };
    const token = deps.settings.token;
    if (!token) throw new Error("implement publish requires FACTORY_TOKEN");

    // 결과 파일은 에이전트가 고칠 수 있었다. 번들(저장소 상태)에서 믿을 값을 모두 다시 구한다.
    const check = await importAndVerify(deps, {
      branch: plan.branch,
      baseSha: plan.baseSha,
      sha: out.sha,
    });
    if (!check.ok) {
      await rejected(check.reason);
      return;
    }
    const verified = check.verified;
    // 에이전트가 만든 커밋(작성자·메시지)은 믿지 않는다. 검증을 통과한 변경을 신뢰하는 메시지·봇 신원으로 다시 커밋한다.
    await recordRuns(deps, plan, out, true, checksOk);
    await deps.git.resetSoft(plan.baseSha);
    await deps.git.commitAll(
      commitMessage(
        `${plan.kind}: ${plan.title} (#${plan.issue})`,
        out.summary,
        { engine: plan.engine, model: plan.model },
        plan.issue,
      ),
    );
    await deps.git.push(plan.branch, token);
    const meta: PrMeta = {
      issue: plan.issue,
      role: "implement",
      implementEngine: plan.engine,
      implementModel: plan.model,
      round: 0,
    };
    const humanActions = extractHumanActions(out.summary);
    if (humanActions.length > 0) meta.humanActions = humanActions;
    const report = (preview: string): PrReport => ({
      meta,
      summary: out.summary,
      issueTitle: plan.title,
      acceptanceCriteria: plan.acceptanceCriteria,
      checks: out.checks.map((c) => ({ name: `pnpm ${c.name}`, ok: c.ok })),
      preview,
      risks: extractRisks(out.summary),
      risk: verified.risk,
      run: { engine: plan.engine, model: plan.model, ...sumRuns(out.runs.map((r) => r.result)) },
    });
    const existing = await deps.gh.findOpenPullByHead(plan.branch);
    const pr =
      existing?.number ??
      (await deps.gh.createPull({
        title: `${plan.kind}: ${plan.title} (#${plan.issue})`,
        body: renderPrBody(report("PR 번호가 정해진 뒤 갱신한다.")),
        head: plan.branch,
        base: "main",
        draft: !checksOk,
      }));
    await deps.gh.updatePullBody(
      pr,
      renderPrBody(report(previewText(deps.settings, pr, verified.risk.tier))),
    );
    const riskLabel = `risk:${verified.risk.tier}`;
    if (existing) {
      // 재시도로 기존 PR을 다시 쓴다. 이전 수정 라운드와 이전 위험 등급 라벨을 지운다(F5).
      for (const l of existing.labels) {
        if (l.startsWith(ROUND_PREFIX) || (l.startsWith("risk:") && l !== riskLabel)) {
          await deps.gh.removeLabel(pr, l);
        }
      }
    }
    await deps.gh.addLabels(pr, [riskLabel]);
    if (checksOk) {
      // 이전 시도가 검사 실패로 draft로 남았다면 review·gate가 무시하므로 ready로 바꾼다(F5).
      if (existing?.draft) await deps.gh.markReady(pr);
      const moved = await moveTo(
        deps,
        plan.issue,
        "in-review",
        "implement",
        `PR #${pr}을 열었다. 위험 등급 ${verified.risk.tier}. 교차 리뷰를 기다린다.`,
      );
      // 리뷰는 PR 이벤트가 아니라 상태 전이 뒤의 dispatch로 시작한다. 전이 전에 리뷰가 먼저 돌아 건너뛰는 경합을 막는다.
      if (moved) {
        await deps.gh.dispatchWorkflow("factory-review.yml", {
          pr: String(pr),
          issue: String(plan.issue),
        });
      }
      return;
    }
    const failed = out.checks
      .filter((c) => !c.ok)
      .map((c) => `\`pnpm ${codeCell(c.name)}\``)
      .join(", ");
    await toHuman(
      `로컬 검사(${failed || "결과 없음"})가 같은 런 안의 수정 1회 후에도 실패해 draft PR #${pr}로 남겼다.`,
    );
  },

  async crashed(deps, plan) {
    // publish가 이미 이 런의 실행 기록을 남겼다면 실패 기록을 또 남기지 않는다.
    if (!RECORDED.has(plan)) await record(deps, crashRecord("implement", plan));
    await moveTo(
      deps,
      plan.issue,
      "needs-human",
      "implement",
      `구현 단계가 비정상 종료했다(에이전트 크래시 또는 러너 오류).${runLink(deps.settings)}`,
    );
  },
};
