import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { runStructured, runWithBudget } from "../agents/budget";
import { scrubEnv } from "../agents/env";
import { loadPrompt, renderPrompt, type PromptName } from "../agents/prompt";
import type { Budget, EngineName } from "../agents/types";
import { AssignmentError, assignEngines, resolveModel } from "../config/agents";
import { FINDING_CATEGORIES, ReviewSchema } from "../report/comments";
import { parsePrMeta } from "../report/pr";
import { cell, codeCell, readMarker } from "../report/text";
import { IMPROVE_MARKER } from "./collect";
import { blockedReason, failureText, isBot, runLink } from "./common";
import type { StageDeps } from "./deps";
import { buildImplementPrompt } from "./implement";
import type { PhasedStage } from "./phased";
import { truncateDiff } from "./review";

// spec 7.2.4의 수동 옵션. 개선 PR의 base 규칙과 head 규칙으로 증거 이슈 하나를 실제 에이전트로 다시
// 구현·리뷰해 목표 범주가 다시 지적되는지 비교한다. 런 기록은 남기지 않는다. 이 실행의 리뷰 지적이
// collect의 범주 집계에 섞이면 같은 범주가 인위적으로 늘어나기 때문이다. 커밋·푸시도 하지 않는다.

export interface EvalLiveArgs {
  pr: number;
  issue: number;
}

interface RoleRun {
  engine: EngineName;
  model: string;
  budget: Budget;
}

export interface EvalLivePlan {
  pr: number;
  issue: number;
  key: string;
  // prepare 시점의 origin/main 커밋. agent 단계에서 merge-base를 구하지 못할 때 base로 대체한다.
  baseSha: string;
  headSha: string;
  // 구현 프롬프트의 템플릿 변수. 사이드마다 그 트리의 factory/prompts/implement.md로 렌더한다.
  // 개선 PR이 프롬프트를 바꿨다면 head 사이드만 바뀐 프롬프트를 받는다.
  implementVars: Record<string, string>;
  issueTitle: string;
  acceptanceCriteria: string[];
  implement: RoleRun;
  review: RoleRun;
}

export interface SideResult {
  side: "base" | "head";
  implemented: boolean;
  // 리뷰 에이전트가 스키마를 만족하는 판정을 냈는가. false면 범주 목록은 비어 있고 재발 여부는 판정하지 않는다.
  reviewed: boolean;
  categories: string[];
  costUsd: number | null;
  note: string;
}

export interface EvalLiveOutcome {
  // agent 단계가 base 작업 트리에 실제로 쓴 커밋과, 그것이 PR head와 origin/main의 merge-base인지 여부.
  baseSha: string;
  baseIsMergeBase: boolean;
  sides: SideResult[];
}

const SIDES = ["base", "head"] as const;
const MAX_CATEGORIES = 100;
const MAX_NOTE = 300;
export const EVAL_LIVE_STEP_TIMEOUT_MS = 15 * 60_000;

// agent VM이 쓴 결과 파일은 신뢰할 수 없다. 형식·길이를 검증하고, 렌더할 때 문자열을 다시 무력화한다.
const SideSchema = z.object({
  side: z.enum(SIDES),
  implemented: z.boolean(),
  reviewed: z.boolean(),
  categories: z.array(z.enum(FINDING_CATEGORIES).catch("other")).max(MAX_CATEGORIES),
  costUsd: z.number().min(0).nullable(),
  note: z.string().max(MAX_NOTE),
});
const OutcomeSchema = z.object({
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  baseIsMergeBase: z.boolean(),
  sides: z
    .array(SideSchema)
    .length(2)
    .refine((s) => s[0]!.side === "base" && s[1]!.side === "head"),
});

const SHORT = (sha: string) => sha.slice(0, 7);

function usd(n: number | null): string {
  return n === null ? "추정 불가" : `$${n.toFixed(2)}`;
}

function categoryText(categories: string[]): string {
  if (categories.length === 0) return "없음";
  const counts = new Map<string, number>();
  for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].map(([c, n]) => `${codeCell(c)}×${n}`).join(", ");
}

export function renderEvalLiveComment(plan: EvalLivePlan, o: EvalLiveOutcome): string {
  const target = plan.key.slice("review:".length);
  const rows = o.sides.map((s) => {
    const recurred = !s.reviewed ? "판정 불가" : s.categories.includes(target) ? "예" : "아니오";
    return `| ${s.side} | ${s.implemented ? "예" : "아니오"} | ${s.reviewed ? categoryText(s.categories) : "리뷰 없음"} | ${recurred} |`;
  });
  const notes = o.sides.filter((s) => s.note).map((s) => `- ${s.side}: ${cell(s.note)}`);
  const total = o.sides.every((s) => s.costUsd === null)
    ? null
    : o.sides.reduce((a, s) => a + (s.costUsd ?? 0), 0);
  return [
    `## eval-live: 개선 PR #${plan.pr} 규칙 비교`,
    "",
    `증거 이슈 #${plan.issue}를 base 규칙(\`${codeCell(SHORT(o.baseSha))}\`)과 이 PR의 head 규칙(\`${codeCell(SHORT(plan.headSha))}\`)으로 각각 다시 구현하고 리뷰했다. ` +
      `구현 엔진은 ${plan.implement.engine}/\`${codeCell(plan.implement.model)}\`, 리뷰 엔진은 ${plan.review.engine}/\`${codeCell(plan.review.model)}\`이다. ` +
      "커밋·푸시는 하지 않았다. 이 실행의 리뷰 지적이 주간 리포트의 범주 집계에 섞이지 않도록 런 기록도 남기지 않았다.",
    ...(o.baseIsMergeBase
      ? []
      : [
          "",
          "base 커밋을 PR head와 origin/main의 merge-base로 구하지 못해 현재 origin/main을 썼다. main이 PR 분기 이후 바뀌었다면 비교에 그 차이가 섞인다.",
        ]),
    "",
    `| 사이드 | 구현 완료 | 리뷰 범주 | 목표 범주(\`${codeCell(plan.key)}\`) 재발 |`,
    "|---|---|---|---|",
    ...rows,
    "",
    `비용: ${o.sides.map((s) => `${s.side} ${usd(s.costUsd)}`).join(", ")}, 합계 ${usd(total)}.`,
    ...(notes.length > 0 ? ["", "비고:", "", ...notes] : []),
    "",
    "에이전트 실행 결과는 매번 달라질 수 있다. 한 번의 비교는 참고 자료이고 병합 판정 기준이 아니다.",
  ].join("\n");
}

function renderSidePrompt(dir: string, name: PromptName, vars: Record<string, string>): string {
  return renderPrompt(loadPrompt(name, path.join(dir, "factory", "prompts")), vars);
}

async function runSide(
  deps: StageDeps,
  plan: EvalLivePlan,
  side: "base" | "head",
  sha: string,
): Promise<SideResult> {
  let cost: number | null = null;
  const addCost = (c: number | undefined) => {
    if (c !== undefined) cost = (cost ?? 0) + c;
  };
  const result = (
    implemented: boolean,
    note: string,
    review?: { categories: string[] },
  ): SideResult => ({
    side,
    implemented,
    reviewed: review !== undefined,
    categories: review?.categories.slice(0, MAX_CATEGORIES) ?? [],
    costUsd: cost,
    note: note.slice(0, MAX_NOTE),
  });
  const env = scrubEnv(deps.settings.env);
  const exec = async (cwd: string, cmd: string, args: string[]) => {
    try {
      return await deps.spawn(cmd, args, {
        cwd,
        env,
        signal: AbortSignal.timeout(EVAL_LIVE_STEP_TIMEOUT_MS),
      });
    } catch (e) {
      return { code: null, stdout: "", stderr: String(e) };
    }
  };
  const repo = deps.settings.workdir;
  const root = mkdtempSync(path.join(deps.settings.env.RUNNER_TEMP || tmpdir(), "eval-live-"));
  const dir = path.join(root, side);
  try {
    const add = await exec(repo, "git", ["worktree", "add", "--detach", "--", dir, sha]);
    if (add.code !== 0) return result(false, `커밋 ${SHORT(sha)}로 작업 트리를 만들지 못했다.`);
    const install = await exec(dir, "pnpm", ["install", "--frozen-lockfile"]);
    if (install.code !== 0) return result(false, "의존성 설치가 실패했다.");

    let implementPrompt: string;
    try {
      implementPrompt = renderSidePrompt(dir, "implement", plan.implementVars);
    } catch (e) {
      return result(false, `구현 프롬프트를 렌더하지 못했다: ${String(e)}`);
    }
    const impl = await runWithBudget(deps.adapterFor(plan.implement.engine, plan.implement.model), {
      role: "implement",
      prompt: implementPrompt,
      cwd: dir,
      readOnly: false,
      budget: plan.implement.budget,
    });
    addCost(impl.costUsd);
    if (!impl.ok)
      return result(false, `구현 에이전트가 실패했다(사유: ${failureText(impl.failureReason)}).`);

    // 에이전트가 커밋했어도 변경을 잡도록 인덱스를 시작 커밋과 비교한다. 이 작업 트리는 곧 지운다.
    await exec(dir, "git", ["add", "-A"]);
    const diff = await exec(dir, "git", ["diff", "--cached", "--no-color", sha, "--"]);
    if (diff.code !== 0) return result(false, "구현 결과의 diff를 구하지 못했다.");
    if (!diff.stdout.trim()) return result(false, "구현 에이전트가 파일을 바꾸지 않았다.");

    let reviewPrompt: string;
    try {
      reviewPrompt = renderSidePrompt(dir, "review", {
        authorEngine: plan.implement.engine,
        issueNumber: String(plan.issue),
        issueTitle: plan.issueTitle,
        acceptanceCriteria:
          plan.acceptanceCriteria.length > 0
            ? plan.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
            : "(트리아지 수용 기준 없음)",
        diff: truncateDiff(diff.stdout),
        // 비교 실행은 첫 라운드 리뷰만 재현한다.
        previousFindings: "(이전 리뷰의 미해결 지적 없음)",
      });
    } catch (e) {
      return result(true, `리뷰 프롬프트를 렌더하지 못했다: ${String(e)}`);
    }
    const rev = await runStructured(
      deps.adapterFor(plan.review.engine, plan.review.model),
      {
        role: "review",
        prompt: reviewPrompt,
        cwd: dir,
        readOnly: true,
        budget: plan.review.budget,
      },
      ReviewSchema,
    );
    addCost(rev.result.costUsd);
    if (!rev.value) {
      return result(
        true,
        `리뷰 에이전트가 판정을 내지 못했다(사유: ${failureText(rev.result.failureReason ?? "invalid_output")}).`,
      );
    }
    return result(true, "", { categories: rev.value.findings.map((f) => f.category) });
  } finally {
    await exec(repo, "git", ["worktree", "remove", "--force", "--", dir]);
    rmSync(root, { recursive: true, force: true });
  }
}

export const evalLiveStage: PhasedStage<EvalLiveArgs, EvalLivePlan, EvalLiveOutcome> = {
  name: "eval-live",
  async prepare(deps, args) {
    const pull = await deps.gh.getPull(args.pr);
    const skip = async (reason: string) => {
      await deps.gh.comment(
        args.pr,
        `eval-live를 실행하지 않았다. ${reason}${runLink(deps.settings)}`,
      );
      return null;
    };
    const blocked = await blockedReason(deps);
    if (blocked) return skip(blocked);
    if (pull.state !== "open") return skip("PR이 열려 있지 않다.");
    // 팩토리 봇이 연 PR만 본문 표식을 신뢰한다.
    if (!isBot(deps.settings, pull.author)) return skip("팩토리 봇이 연 PR이 아니다.");
    if (parsePrMeta(pull.body)?.role !== "improve") return skip("개선 PR이 아니다.");
    const key = readMarker(pull.body, IMPROVE_MARKER, z.object({ key: z.string() }))?.key;
    if (!key?.startsWith("review:")) {
      return skip(
        `개선 범주(${key ? `\`${codeCell(key)}\`` : "없음"})가 리뷰 범주(review:*)가 아니다. 리뷰 지적 재발로 비교할 수 없다.`,
      );
    }
    const issue = await deps.gh.getIssue(args.issue);
    if (issue.isPullRequest) return skip(`#${args.issue}은 이슈가 아니다.`);
    let implement: RoleRun;
    let review: RoleRun;
    try {
      const assignment = assignEngines(deps.agents, issue.labels);
      const model = (e: EngineName) => resolveModel(deps.agents, e, deps.settings.env);
      implement = { ...assignment.implement, model: model(assignment.implement.engine) };
      review = { ...assignment.review, model: model(assignment.review.engine) };
    } catch (err) {
      if (!(err instanceof AssignmentError)) throw err;
      return skip(`엔진을 정하지 못했다: ${err.message}`);
    }
    const prompt = await buildImplementPrompt(deps, issue);
    await deps.git.fetch("main");
    // prepare는 얕은 main 체크아웃에서 돌아 PR head 커밋이 없다. merge-base는 agent 단계(work 체크아웃)에서 구하고,
    // 여기서는 대체용 origin/main 커밋만 기록한다.
    const baseSha = await deps.git.revParse("origin/main");
    return {
      pr: args.pr,
      issue: args.issue,
      key,
      baseSha,
      headSha: pull.headSha,
      implementVars: prompt.vars,
      issueTitle: issue.title,
      acceptanceCriteria: prompt.acceptanceCriteria,
      implement,
      review,
    };
  },

  async agent(deps, plan) {
    // 비교가 main의 그 사이 변화와 섞이지 않도록 PR head와 origin/main의 merge-base를 base로 쓴다.
    // 구하지 못하면 prepare가 기록한 origin/main 커밋으로 대체하고 코멘트에 밝힌다.
    const mb = await deps
      .spawn("git", ["merge-base", "origin/main", plan.headSha], {
        cwd: deps.settings.workdir,
        env: scrubEnv(deps.settings.env),
      })
      .catch(() => null);
    const mbSha = mb?.code === 0 ? mb.stdout.trim() : "";
    const baseIsMergeBase = /^[0-9a-f]{40}$/.test(mbSha);
    const baseSha = baseIsMergeBase ? mbSha : plan.baseSha;
    const sides: SideResult[] = [];
    for (const side of SIDES) {
      sides.push(await runSide(deps, plan, side, side === "base" ? baseSha : plan.headSha));
    }
    return { baseSha, baseIsMergeBase, sides };
  },

  parseOutcome(raw) {
    return OutcomeSchema.parse(raw);
  },

  async publish(deps, plan, out) {
    await deps.gh.comment(plan.pr, renderEvalLiveComment(plan, out) + runLink(deps.settings));
  },

  async crashed(deps, plan) {
    await deps.gh.comment(
      plan.pr,
      `eval-live가 비정상 종료해 비교 결과가 없다(에이전트 크래시 또는 러너 오류).${runLink(deps.settings)}`,
    );
  },
};
