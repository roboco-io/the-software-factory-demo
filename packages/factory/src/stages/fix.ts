import { z } from "zod";
import { runWithBudget, type TimedResult } from "../agents/budget";
import { loadPrompt, renderPrompt } from "../agents/prompt";
import type { Budget, EngineName } from "../agents/types";
import { toBudget } from "../config/agents";
import { latestVerdict } from "../report/comments";
import { commitMessage } from "../report/commit";
import { extractHumanActions, parsePrMeta, replaceMeta } from "../report/pr";
import { canTransition } from "../state/machine";
import {
  MAX_ROUNDS,
  ROUND_PREFIX,
  TimedResultSchema,
  agentRecord,
  blockedReason,
  branchFor,
  crashRecord,
  failureText,
  moveTo,
  readState,
  record,
  roundFromLabels,
  runLink,
} from "./common";
import type { StageDeps } from "./deps";
import type { PhasedStage } from "./phased";
import { clampResult, fileList, importAndVerify } from "./protect";
import { checkWorkdir, commitType, inspectChanges } from "./worktree";

export interface FixArgs {
  pr: number;
  sha: string;
  reason: "review" | "ci";
}

export interface FixPlan {
  pr: number;
  issue: number;
  branch: string;
  sha: string;
  round: number;
  reason: "review" | "ci";
  engine: EngineName;
  model: string;
  budget: Budget;
  prompt: string;
  title: string;
  kind: "feat" | "fix" | "docs";
  // prepare 시점의 origin/main 커밋. 에이전트는 여기에 rebase하고, publish는 번들 head가 이 커밋의 후손인지 확인한다.
  baseSha: string;
}

// agent VM이 쓴 결과 파일은 신뢰할 수 없다. 변경 파일과 위험 등급은 담지 않는다(publish가 번들에서 다시 계산한다).
const OutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rebase-conflict") }),
  z.object({ kind: z.literal("agent-failed"), result: TimedResultSchema }),
  z.object({ kind: z.literal("no-changes"), result: TimedResultSchema }),
  z.object({
    kind: z.literal("forbidden-paths"),
    result: TimedResultSchema,
    files: z.array(z.string().max(500)).max(200),
  }),
  z.object({
    kind: z.literal("committed"),
    result: TimedResultSchema,
    checksOk: z.boolean(),
    sha: z.string().min(1).max(100),
  }),
]);

export type FixOutcome = z.infer<typeof OutcomeSchema>;

// 이미 실행 기록을 남긴 계획. publish 도중 예외가 나도 crashed()가 같은 런을 다시 세지 않게 한다.
const RECORDED = new WeakSet<FixPlan>();

async function recordOnce(
  deps: StageDeps,
  plan: FixPlan,
  result: TimedResult,
  ok: boolean,
): Promise<void> {
  if (RECORDED.has(plan)) return;
  RECORDED.add(plan);
  await record(
    deps,
    agentRecord(
      "fix",
      plan.engine,
      plan.model,
      clampResult(result, plan.budget, ok),
      plan.issue,
      plan.pr,
      plan.round,
    ),
  );
}

// 라운드 라벨은 publish가 관리한다. 시도가 끝나면(성공·실패·크래시) 이번 라운드를 소모한 것으로 센다.
async function spendRound(deps: StageDeps, plan: FixPlan): Promise<void> {
  const labels = (await deps.gh.getPull(plan.pr)).labels;
  const mine = `${ROUND_PREFIX}${plan.round}`;
  for (const l of labels) {
    if (l.startsWith(ROUND_PREFIX) && l !== mine) await deps.gh.removeLabel(plan.pr, l);
  }
  if (!labels.includes(mine)) await deps.gh.addLabels(plan.pr, [mine]);
}

async function feedbackFor(
  deps: StageDeps,
  pr: number,
  sha: string,
  reason: "review" | "ci",
): Promise<string> {
  if (reason === "review") {
    const verdict = latestVerdict(await deps.gh.listReviews(pr), deps.settings.botLogin, sha);
    return (
      verdict?.body ?? "리뷰 판정 본문을 찾지 못했다. PR의 최근 리뷰 코멘트를 기준으로 고친다."
    );
  }
  const failing = (await deps.gh.listCheckRuns(sha))
    .filter(
      (c) =>
        c.status === "completed" &&
        !["success", "skipped", "neutral", "cancelled"].includes(c.conclusion ?? ""),
    )
    .map((c) => c.name);
  const evidence = failing.includes("evidence")
    ? " evidence 체크는 버그 PR의 재현 테스트(Vitest)가 수정 전(base) 코드에서 실패하고 PR 코드에서 통과해야 통과한다. 테스트 파일 변경이 없거나, 테스트가 base에서도 통과하거나, 수정 전에 없는 모듈을 import해 수집 오류로 실패하거나, Playwright E2E만 바꿨으면 실패한다. 재현 테스트가 버그를 실제로 드러내는지 확인하고 고친다."
    : "";
  return `CI 필수 체크가 실패했다: ${failing.join(", ") || "(실패한 체크 이름을 찾지 못함)"}. 작업 디렉토리에서 같은 검사(pnpm typecheck, pnpm lint, pnpm test, RealWorld 스위트는 scripts/realworld-api.sh)를 실행해 원인을 찾고 고친다.${evidence}`;
}

// in-progress면 in-review로 옮긴다. 이미 in-review면(전이는 허용되지 않지만 목표 상태다) true.
// needs-human·merged 등 다른 상태면 false라서 호출한 쪽이 dispatch하지 않는다.
async function toReview(deps: StageDeps, plan: FixPlan, reason: string): Promise<boolean> {
  if (await moveTo(deps, plan.issue, "in-review", "fix", reason)) return true;
  return (await readState(deps.gh, plan.issue)).state === "in-review";
}

async function backToReview(deps: StageDeps, plan: FixPlan): Promise<void> {
  const moved = await toReview(
    deps,
    plan,
    `PR #${plan.pr}의 head가 수정 중에 바뀌었다. 새 head를 다시 리뷰한다.${runLink(deps.settings)}`,
  );
  if (moved) {
    await deps.gh.dispatchWorkflow("factory-review.yml", {
      pr: String(plan.pr),
      issue: String(plan.issue),
    });
  }
}

async function retryOrEscalate(deps: StageDeps, plan: FixPlan, why: string): Promise<void> {
  if (plan.round < MAX_ROUNDS) {
    const moved = await toReview(
      deps,
      plan,
      `${why} 수정 라운드 ${plan.round}/${MAX_ROUNDS}를 소모하고 다시 시도한다.${runLink(deps.settings)}`,
    );
    if (!moved) return;
    await deps.gh.dispatchWorkflow("factory-fix.yml", {
      pr: String(plan.pr),
      sha: plan.sha,
      reason: plan.reason,
      issue: String(plan.issue),
    });
    return;
  }
  await moveTo(
    deps,
    plan.issue,
    "needs-human",
    "fix",
    `${why} 수정 라운드 ${MAX_ROUNDS}회를 모두 썼다(PR #${plan.pr}). 사람이 확인한다.${runLink(deps.settings)}`,
  );
}

export const fixStage: PhasedStage<FixArgs, FixPlan, FixOutcome> = {
  name: "fix",
  async prepare(deps, args) {
    const pull = await deps.gh.getPull(args.pr);
    if (pull.author !== deps.settings.botLogin || pull.state !== "open") return null;
    if (pull.headSha !== args.sha) {
      deps.log(`fix: PR #${args.pr} head ${pull.headSha} != ${args.sha}, stale dispatch ignored`);
      return null;
    }
    const meta = parsePrMeta(pull.body);
    if (!meta || pull.headRef !== branchFor(meta.issue)) return null;
    const { issue, state } = await readState(deps.gh, meta.issue);
    if (!canTransition(state, "in-progress", "fix")) return null;
    const round = roundFromLabels(pull.labels) + 1;
    if (round > MAX_ROUNDS) {
      await moveTo(
        deps,
        meta.issue,
        "needs-human",
        "fix",
        `PR #${args.pr}의 수정 라운드가 ${MAX_ROUNDS}회를 넘었다. 사람이 확인한다.`,
      );
      return null;
    }
    const blocked = await blockedReason(deps);
    if (blocked) {
      await moveTo(
        deps,
        meta.issue,
        "needs-human",
        "fix",
        `PR #${args.pr} 수정을 시작하지 않았다. ${blocked}`,
      );
      return null;
    }
    const feedback = await feedbackFor(deps, args.pr, args.sha, args.reason);
    await deps.git.fetch("main");
    const baseSha = await deps.git.revParse("origin/main");
    // 위 검사 이후 라벨이 바뀌어 전이가 거부되면(경합) 에이전트를 돌리지 않는다.
    const started = await moveTo(
      deps,
      meta.issue,
      "in-progress",
      "fix",
      `PR #${args.pr} 수정 라운드 ${round}/${MAX_ROUNDS}를 시작했다(사유: ${args.reason === "review" ? "리뷰 변경 요청" : "CI 실패"}).${runLink(deps.settings)}`,
    );
    if (!started) return null;
    return {
      pr: args.pr,
      issue: meta.issue,
      branch: pull.headRef,
      sha: args.sha,
      round,
      reason: args.reason,
      engine: meta.implementEngine,
      model: meta.implementModel,
      budget: toBudget(deps.agents.roles.fix.budget),
      prompt: renderPrompt(loadPrompt("fix"), {
        target: `PR #${args.pr}(이슈 #${meta.issue})`,
        issueNumber: String(meta.issue),
        round: String(round),
        feedback,
      }),
      title: issue.title,
      kind: commitType(issue.labels),
      baseSha,
    };
  },

  async agent(deps, plan) {
    await deps.git.fetch("main");
    await deps.git.fetch(plan.branch);
    await deps.git.checkoutNewBranch(plan.branch, plan.sha);
    if (!(await deps.git.rebaseOnto(plan.baseSha))) return { kind: "rebase-conflict" };
    const result = await runWithBudget(deps.adapterFor(plan.engine, plan.model), {
      role: "fix",
      prompt: plan.prompt,
      cwd: deps.settings.workdir,
      readOnly: false,
      budget: plan.budget,
    });
    if (!result.ok) return { kind: "agent-failed", result };
    if ((await deps.git.changedFiles()).length === 0) return { kind: "no-changes", result };
    const changes = await inspectChanges(deps);
    if (changes.forbidden.length > 0) {
      return { kind: "forbidden-paths", result, files: changes.forbidden };
    }
    const checks = await checkWorkdir(deps);
    const sha = await deps.git.commitAll(
      commitMessage(
        `fix: 리뷰·CI 지적 반영 라운드 ${plan.round} (#${plan.issue})`,
        result.summary,
        { engine: plan.engine, model: plan.model },
        plan.issue,
      ),
    );
    // agent job과 publish job은 다른 VM이다. 커밋을 bundle 파일로 넘긴다.
    if (deps.settings.bundlePath) await deps.git.createBundle(deps.settings.bundlePath);
    return { kind: "committed", result, checksOk: checks.ok, sha };
  },

  parseOutcome(raw) {
    return OutcomeSchema.parse(raw);
  },

  async publish(deps, plan, out) {
    await spendRound(deps, plan);
    if (out.kind === "rebase-conflict") {
      // 에이전트를 돌리지 않았으므로 실행 기록(일일 상한·차단기 입력)을 남기지 않는다.
      await moveTo(
        deps,
        plan.issue,
        "needs-human",
        "fix",
        `PR #${plan.pr} 브랜치를 main 위로 rebase하다 충돌했다. 사람이 충돌을 해결한다.${runLink(deps.settings)}`,
      );
      return;
    }
    const { state } = await readState(deps.gh, plan.issue);
    const inProgress = state === "in-progress";
    // 에이전트 단계 동안 사람이 상태를 바꿨으면(예: @factory stop) push도 재시도도 하지 않는다.
    const skip = async (ok: boolean): Promise<boolean> => {
      await recordOnce(deps, plan, out.result, ok);
      if (inProgress) return false;
      deps.log(`fix: #${plan.issue} is ${state}; skipping publish`);
      return true;
    };
    if (out.kind === "agent-failed") {
      if (await skip(false)) return;
      await retryOrEscalate(
        deps,
        plan,
        `수정 에이전트가 실패했다(사유: ${failureText(out.result.failureReason)}).`,
      );
      return;
    }
    if (out.kind === "no-changes") {
      if (await skip(false)) return;
      await retryOrEscalate(deps, plan, "수정 에이전트가 파일을 바꾸지 않았다.");
      return;
    }
    if (out.kind === "forbidden-paths") {
      if (await skip(false)) return;
      await moveTo(
        deps,
        plan.issue,
        "needs-human",
        "fix",
        `수정 역할이 수정할 수 없는 T3 경로를 바꿔 변경을 버렸다: ${fileList(out.files)}.${runLink(deps.settings)}`,
      );
      return;
    }
    if (!inProgress) {
      await skip(true);
      return;
    }
    const rejected = async (reason: string) => {
      await recordOnce(deps, plan, out.result, false);
      await moveTo(deps, plan.issue, "needs-human", "fix", `${reason}${runLink(deps.settings)}`);
    };
    const token = deps.settings.token;
    if (!token) throw new Error("fix publish requires FACTORY_TOKEN");

    // 결과 파일은 에이전트가 고칠 수 있었다. 번들(저장소 상태)에서 믿을 값을 다시 구한다.
    const check = await importAndVerify(deps, {
      branch: plan.branch,
      baseSha: plan.baseSha,
      sha: out.sha,
    });
    if (!check.ok) {
      await rejected(check.reason);
      return;
    }
    // push는 force push다. 에이전트가 도는 동안 다른 커밋이 올라갔다면 덮어쓰지 않는다.
    const pull = await deps.gh.getPull(plan.pr);
    if (pull.headSha !== plan.sha || pull.state !== "open") {
      await recordOnce(deps, plan, out.result, out.checksOk);
      deps.log(`fix: PR #${plan.pr} head moved to ${pull.headSha}; push skipped`);
      // 새 head에는 아직 판정이 없다. in-review로 돌리고 리뷰를 다시 시작해 이슈가 in-progress에 남지 않게 한다.
      await backToReview(deps, plan);
      return;
    }
    await recordOnce(deps, plan, out.result, out.checksOk);
    // 에이전트가 만든 커밋(작성자·메시지)은 믿지 않는다. 검증을 통과한 변경을 신뢰하는 메시지·봇 신원으로 다시 커밋한다.
    await deps.git.resetSoft(plan.baseSha);
    await deps.git.commitAll(
      commitMessage(
        `${plan.kind}: ${plan.title} (#${plan.issue})`,
        `수정 라운드 ${plan.round}: ${out.result.summary}`,
        { engine: plan.engine, model: plan.model },
        plan.issue,
      ),
    );
    await deps.git.push(plan.branch, token, plan.sha);
    const meta = parsePrMeta(pull.body);
    if (meta) {
      // 사람 조치 항목은 사람만 지운다. 수정 라운드가 새로 선언한 항목을 앞선 항목에 더한다.
      const humanActions = [
        ...new Set([...(meta.humanActions ?? []), ...extractHumanActions(out.result.summary)]),
      ].slice(0, 20);
      await deps.gh.updatePullBody(
        plan.pr,
        replaceMeta(pull.body, {
          ...meta,
          round: plan.round,
          ...(humanActions.length > 0 ? { humanActions } : {}),
        }),
      );
    }
    const moved = await moveTo(
      deps,
      plan.issue,
      "in-review",
      "fix",
      `PR #${plan.pr}에 수정 라운드 ${plan.round} 커밋을 push했다.${out.checksOk ? "" : " 로컬 검사가 아직 실패하므로 CI 결과에 따라 다음 라운드가 시작될 수 있다."} 리뷰를 다시 받는다.`,
    );
    // 리뷰는 PR 이벤트가 아니라 상태 전이 뒤의 dispatch로 시작한다(implement와 같은 이유).
    if (moved) {
      await deps.gh.dispatchWorkflow("factory-review.yml", {
        pr: String(plan.pr),
        issue: String(plan.issue),
      });
    }
  },

  async crashed(deps, plan) {
    await spendRound(deps, plan);
    if (!RECORDED.has(plan)) {
      RECORDED.add(plan);
      await record(deps, crashRecord("fix", plan));
    }
    // push 뒤(예: 라벨·코멘트 단계)에 죽었다면 head가 이미 바뀌었다. 같은 sha로 fix를 다시 보내면 낡은 dispatch이므로 리뷰로 보낸다.
    if ((await deps.gh.getPull(plan.pr)).headSha !== plan.sha) {
      await backToReview(deps, plan);
      return;
    }
    await retryOrEscalate(deps, plan, "수정 단계가 비정상 종료했다.");
  },
};
