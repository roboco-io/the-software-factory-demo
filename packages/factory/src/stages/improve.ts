import picomatch from "picomatch";
import { z } from "zod";
import { runStructured, type TimedResult } from "../agents/budget";
import { loadPrompt, renderPrompt } from "../agents/prompt";
import type { Budget, FailureReason } from "../agents/types";
import { resolveModel, toBudget } from "../config/agents";
import { formatCheckFailures } from "../exec/checks";
import { addedCaseSlugs, IMPROVE_PATHS, isImprovePath } from "../policy/improve-paths";
import { commitMessage } from "../report/commit";
import { replaceMeta } from "../report/pr";
import {
  codeBlock,
  codeCell,
  demote,
  inline,
  neutralizeRefs,
  readMarker,
  writeMarker,
} from "../report/text";
import { CandidateSchema, IMPROVE_MARKER, type Candidate } from "./collect";
import {
  TimedResultSchema,
  FailureReasonSchema,
  agentRecord,
  blockedReason,
  branchFor,
  crashRecord,
  failureText,
  isBot,
  record,
  runLink,
} from "./common";
import type { RunRecord } from "../runs/store";
import type { StageDeps } from "./deps";
import type { PhasedStage } from "./phased";
import { clampResult, fileList, importAndVerify } from "./protect";
import { checkWorkdir } from "./worktree";
import { latestReportMarker } from "./weekly-marker";

const REPORT_LABEL = "factory:report";
const POSTMORTEM_LABEL = "factory:postmortem";
// 포스트모템이 장애 이슈에 남기는 개선 후보 표식. 값은 CandidateSchema다.
export const POSTMORTEM_CANDIDATE_MARKER = "factory:postmortem-candidate";
const IMPROVE_LABELS = ["factory:improve", "risk:T3"];
const MAX_TITLE = 70;
const MAX_SUMMARY = 3000;
const MAX_OUTPUT = 3000;
const MAX_FILES = 200;
const MAX_REMOVED_LINES = 50;

export interface ImproveArgs {
  issue: number;
}

export interface ImprovePlan {
  issue: number;
  // 후보가 나온 곳. weekly는 주간 리포트 이슈, postmortem은 장애 이슈다.
  sourceKind: "weekly" | "postmortem";
  branch: string;
  candidate: Candidate;
  engine: "claude";
  model: string;
  budget: Budget;
  prompt: string;
  // prepare 시점의 origin/main 커밋. 에이전트는 여기서 분기하고, publish는 번들 head가 이 커밋의 후손인지 확인한다.
  baseSha: string;
}

export type ImproveOutcome =
  | { kind: "agent-failed"; result: TimedResult; reason: FailureReason }
  | { kind: "forbidden-paths"; result: TimedResult; files: string[] }
  | { kind: "no-eval-case"; result: TimedResult }
  | { kind: "checks-failed"; result: TimedResult; output: string }
  | {
      kind: "committed";
      result: TimedResult;
      sha: string;
      title: string;
      summary: string;
      rule: "lint" | "agents" | "prompt";
      files: string[];
    };

const RULES = ["lint", "agents", "prompt"] as const;

const ImproveOutputSchema = z.object({
  title: z.string().min(5).max(MAX_TITLE),
  summary: z.string().min(10).max(MAX_SUMMARY),
  rule: z.enum(RULES),
});

// agent VM이 쓴 결과 파일은 신뢰할 수 없다. 형식과 길이를 검증하고, 변경 파일은 publish가 번들에서 다시 구한다.
const Files = z.array(z.string().max(500)).max(MAX_FILES);
const OutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent-failed"),
    result: TimedResultSchema,
    reason: FailureReasonSchema,
  }),
  z.object({ kind: z.literal("forbidden-paths"), result: TimedResultSchema, files: Files }),
  z.object({ kind: z.literal("no-eval-case"), result: TimedResultSchema }),
  z.object({
    kind: z.literal("checks-failed"),
    result: TimedResultSchema,
    output: z.string().max(MAX_OUTPUT),
  }),
  z.object({
    kind: z.literal("committed"),
    result: TimedResultSchema,
    sha: z.string().min(1).max(100),
    title: z.string().min(5).max(MAX_TITLE),
    summary: z.string().min(10).max(MAX_SUMMARY),
    rule: z.enum(RULES),
    files: Files,
  }),
]);

// RunRecord.failureReason에 남길 값. agent-failed는 에이전트 실행 결과의 사유를 그대로 쓴다.
const FAILURE_REASON = {
  "forbidden-paths": "forbidden_paths",
  "no-eval-case": "no_eval_case",
  "checks-failed": "checks_failed",
} as const;

const FAILURE_MESSAGE = {
  "forbidden-paths": "허용 경로 밖의 파일을 바꿔 변경 전체를 버렸다",
  "no-eval-case": "평가 케이스(factory/evals/<slug>/case.yml)를 추가하지 않았다",
  "checks-failed": "로컬 검사(typecheck·lint·test)가 실패했다",
} as const;

// 이미 실행 기록을 남긴 계획. publish 도중 예외가 나도 crashed()가 같은 런을 다시 세지 않게 한다.
const RECORDED = new WeakSet<ImprovePlan>();

const isEslintConfig = picomatch("eslint.config.*", { dot: false });

// diff에서 eslint.config.* 파일 구간의 삭제 줄("-"로 시작하고 "---"가 아닌 줄). 사람이 규칙 삭제를 확인하도록 PR에 보인다.
export function removedEslintLines(diff: string): string[] {
  const out: string[] = [];
  let inEslint = false;
  for (const line of diff.split(/\r?\n/)) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (header) {
      inEslint = isEslintConfig(header[1]!) || isEslintConfig(header[2]!);
      continue;
    }
    if (inEslint && line.startsWith("-") && !line.startsWith("---")) {
      out.push(line);
      if (out.length >= MAX_REMOVED_LINES) break;
    }
  }
  return out;
}

export function renderImproveBody(a: {
  plan: ImprovePlan;
  title: string;
  summary: string;
  files: string[];
  removedEslintLines: string[];
  runUrl: string;
}): string {
  const { plan } = a;
  const c = plan.candidate;
  const body = [
    "## 요약",
    "",
    demote(a.summary.trim()) || "(에이전트 요약 없음)",
    "",
    "## 근거",
    "",
    plan.sourceKind === "postmortem"
      ? `포스트모템 #${plan.issue}의 개선 후보다.`
      : `주간 리포트 #${plan.issue}의 개선 후보다.`,
    "",
    `- 범주: \`${codeCell(c.key)}\``,
    `- 횟수: ${c.count}회(서로 다른 이슈 ${c.distinct}건)`,
    `- 근거 이슈: ${c.issues.map((n) => `#${n}`).join(", ") || "없음"}`,
    "",
    "대표 원문:",
    "",
    // codeBlock은 내용에 sanitize와 neutralizeRefs(멘션·닫기 키워드 무력화)를 적용한다.
    c.samples.length > 0 ? codeBlock(c.samples.join("\n---\n")) : "(원문 없음)",
    "",
    "## 변경 파일",
    "",
    fileList(a.files) || "없음",
    "",
    "## ESLint 설정에서 삭제된 줄",
    "",
    a.removedEslintLines.length > 0 ? codeBlock(a.removedEslintLines.join("\n")) : "없음",
    "",
    "## 확인할 것",
    "",
    "`eval` 체크가 새 평가 케이스의 base 미검출·head 검출을 확인한다. 이 PR은 T3이므로 사람이 승인해야 병합된다.",
    "",
    "## 실행 정보",
    "",
    `- 엔진: ${plan.engine}`,
    `- 모델: \`${codeCell(plan.model)}\``,
    `- 실행: ${a.runUrl ? inline(a.runUrl) : "없음"}`,
    "",
    writeMarker(IMPROVE_MARKER, { key: c.key }),
  ].join("\n");
  return replaceMeta(body, {
    issue: plan.issue,
    role: "improve",
    implementEngine: plan.engine,
    implementModel: plan.model,
    round: 0,
  });
}

async function fail(deps: StageDeps, plan: ImprovePlan, reason: string): Promise<void> {
  await deps.gh.comment(
    plan.issue,
    `개선 단계가 실패해 개선 PR을 열지 않았다. ${reason}${runLink(deps.settings)}`,
  );
}

// createPull은 라벨을 받지 못하므로 생성 뒤 붙인다. 실패하면 한 번 더 시도하고, 그래도 실패하면
// 리포트 이슈에 라벨 누락을 알린 뒤 원래 예외를 다시 던진다(호출자가 publish_failed를 한 번 기록한다).
async function labelPull(deps: StageDeps, plan: ImprovePlan, pr: number): Promise<void> {
  try {
    await deps.gh.addLabels(pr, IMPROVE_LABELS);
    return;
  } catch {
    // 한 번 재시도한다.
  }
  try {
    await deps.gh.addLabels(pr, IMPROVE_LABELS);
  } catch (err) {
    try {
      await deps.gh.comment(
        plan.issue,
        `개선 PR #${pr}을 열었지만 라벨(${IMPROVE_LABELS.join(", ")})을 붙이지 못했다. 사람이 라벨을 붙여야 한다.${runLink(deps.settings)}`,
      );
    } catch {
      // 알림 실패가 원래 오류를 가리지 않게 한다.
    }
    throw err;
  }
}

async function publishCommitted(
  deps: StageDeps,
  plan: ImprovePlan,
  out: Extract<ImproveOutcome, { kind: "committed" }>,
  run: Omit<RunRecord, "ts">,
): Promise<void> {
  const token = deps.settings.token;
  if (!token) throw new Error("improve publish requires FACTORY_TOKEN");

  // 결과 파일은 에이전트가 고칠 수 있었다. 번들(저장소 상태)에서 변경 파일을 다시 구하고 허용 경로만 받는다.
  const check = await importAndVerify(deps, {
    branch: plan.branch,
    baseSha: plan.baseSha,
    sha: out.sha,
    allowed: isImprovePath,
  });
  if (!check.ok) {
    RECORDED.add(plan);
    await record(deps, { ...run, ok: false, failureReason: "bundle_rejected" });
    await fail(deps, plan, check.reason);
    return;
  }
  // 에이전트가 만든 커밋은 믿지 않는다. 검증을 통과한 변경을 신뢰하는 메시지·봇 신원으로 다시 커밋한다.
  await deps.git.resetSoft(plan.baseSha);
  await deps.git.commitAll(
    commitMessage(
      out.title,
      neutralizeRefs(out.summary),
      { engine: plan.engine, model: plan.model },
      plan.issue,
    ),
  );
  await deps.git.push(plan.branch, token);
  const removed = removedEslintLines(await deps.git.diffAgainst(plan.baseSha));
  const pr = await deps.gh.createPull({
    title: inline(out.title),
    body: renderImproveBody({
      plan,
      title: out.title,
      summary: out.summary,
      files: check.verified.files,
      removedEslintLines: removed,
      runUrl: deps.settings.runUrl,
    }),
    head: plan.branch,
    base: "main",
    draft: false,
  });
  await labelPull(deps, plan, pr);
  RECORDED.add(plan);
  await record(deps, run);
  await deps.gh.comment(plan.issue, `개선 PR #${pr}을 열었다. 사람 승인 후 병합된다.`);
}

export const improveStage: PhasedStage<ImproveArgs, ImprovePlan, ImproveOutcome> = {
  name: "improve",
  async prepare(deps, args) {
    const issue = await deps.gh.getIssue(args.issue);
    // 리포트가 아닌 이슈에는 차단 사유 코멘트도 남기지 않도록 리포트 여부를 먼저 본다.
    // 포스트모템 이슈는 사람이 연 요청일 수 있으므로 작성자 대신 봇이 쓴 후보 표식을 믿는다.
    const sourceKind = issue.labels.includes(POSTMORTEM_LABEL) ? "postmortem" : "weekly";
    if (
      issue.isPullRequest ||
      issue.state !== "open" ||
      (sourceKind === "weekly" &&
        (!isBot(deps.settings, issue.author) || !issue.labels.includes(REPORT_LABEL)))
    ) {
      deps.log(`improve: #${args.issue} is not an open factory report; skipping`);
      return null;
    }
    const blocked = await blockedReason(deps);
    if (blocked) {
      await deps.gh.comment(args.issue, `개선을 시작하지 않았다. ${blocked}`);
      return null;
    }
    const issueComments = await deps.gh.listComments(args.issue);
    let candidate: Candidate | null | undefined;
    if (sourceKind === "postmortem") {
      for (const c of issueComments.filter((c) => c.author === deps.settings.botLogin).reverse()) {
        candidate = readMarker(c.body, POSTMORTEM_CANDIDATE_MARKER, CandidateSchema);
        if (candidate) break;
      }
    } else {
      candidate = latestReportMarker(issue, issueComments, deps.settings.botLogin)?.candidates[0];
    }
    if (!candidate) {
      deps.log(`improve: report #${args.issue} has no candidate`);
      return null;
    }
    const branch = branchFor(args.issue);
    // 같은 리포트로 개선 PR을 두 번 열지 않는다.
    if (await deps.gh.findOpenPullByHead(branch)) {
      deps.log(`improve: an improvement PR for report #${args.issue} is already open`);
      return null;
    }
    const engine = "claude" as const;
    const model = resolveModel(deps.agents, engine, deps.settings.env);
    const prompt = renderPrompt(loadPrompt("improve"), {
      category: candidate.key,
      count: String(candidate.count),
      distinct: String(candidate.distinct),
      issues: candidate.issues.map((n) => `#${n}`).join(", ") || "(없음)",
      failures: candidate.samples.join("\n---\n") || "(원문 없음)",
      allowedPaths: IMPROVE_PATHS.join(", "),
    });
    await deps.git.fetch("main");
    const baseSha = await deps.git.revParse("origin/main");
    return {
      issue: args.issue,
      sourceKind,
      branch,
      candidate,
      engine,
      model,
      budget: toBudget(deps.agents.roles.improve.budget),
      prompt,
      baseSha,
    };
  },

  async agent(deps, plan) {
    await deps.git.fetch("main");
    await deps.git.checkoutNewBranch(plan.branch, plan.baseSha);
    const { result, value } = await runStructured(
      deps.adapterFor(plan.engine, plan.model),
      {
        role: "improve",
        prompt: plan.prompt,
        cwd: deps.settings.workdir,
        readOnly: false,
        budget: plan.budget,
      },
      ImproveOutputSchema,
    );
    if (!value)
      return { kind: "agent-failed", result, reason: result.failureReason ?? "engine_error" };
    const files = await deps.git.filesAgainst(plan.baseSha);
    const outside = files.filter((f) => !isImprovePath(f));
    if (outside.length > 0)
      return { kind: "forbidden-paths", result, files: outside.slice(0, MAX_FILES) };
    if (addedCaseSlugs(files).length === 0) return { kind: "no-eval-case", result };
    const checks = await checkWorkdir(deps);
    if (!checks.ok) {
      return {
        kind: "checks-failed",
        result,
        output: formatCheckFailures(checks.results).slice(-MAX_OUTPUT),
      };
    }
    // 검사가 파일을 만들거나 바꿨을 수 있다. 커밋될 최종 목록에 허용 경로와 새 케이스 조건을 다시 적용한다.
    const finalFiles = await deps.git.filesAgainst(plan.baseSha);
    const finalOutside = finalFiles.filter((f) => !isImprovePath(f));
    if (finalOutside.length > 0)
      return { kind: "forbidden-paths", result, files: finalOutside.slice(0, MAX_FILES) };
    if (addedCaseSlugs(finalFiles).length === 0) return { kind: "no-eval-case", result };
    const sha = await deps.git.commitAll(value.title);
    // agent job과 publish job은 다른 VM이다. 커밋을 bundle 파일로 넘긴다.
    if (deps.settings.bundlePath) await deps.git.createBundle(deps.settings.bundlePath);
    return {
      kind: "committed",
      result,
      sha,
      title: value.title,
      summary: value.summary,
      rule: value.rule,
      files: finalFiles.slice(0, MAX_FILES),
    };
  },

  parseOutcome(raw) {
    return OutcomeSchema.parse(raw) as ImproveOutcome;
  },

  async publish(deps, plan, out) {
    const ok = out.kind === "committed";
    const reported = clampResult(
      out.result,
      plan.budget,
      ok,
      out.kind === "agent-failed" ? out.reason : undefined,
    );
    const run = agentRecord("improve", plan.engine, plan.model, reported, plan.issue, null, 0);
    if (out.kind !== "committed" && out.kind !== "agent-failed")
      run.failureReason = FAILURE_REASON[out.kind];
    // committed는 번들 검증과 PR 생성이 끝난 뒤에 실제 결과로 기록한다. 나머지는 지금 기록한다.
    if (out.kind !== "committed") {
      RECORDED.add(plan);
      await record(deps, run);
    }

    if (out.kind === "agent-failed") {
      await fail(deps, plan, `개선 에이전트가 실패했다(사유: ${failureText(out.reason)}).`);
      return;
    }
    if (out.kind === "forbidden-paths") {
      await fail(deps, plan, `${FAILURE_MESSAGE[out.kind]}: ${fileList(out.files)}.`);
      return;
    }
    if (out.kind !== "committed") {
      await fail(deps, plan, `${FAILURE_MESSAGE[out.kind]}.`);
      return;
    }
    try {
      await publishCommitted(deps, plan, out, run);
    } catch (err) {
      // 검증 뒤 push·PR 생성이 실패하면 성공으로 기록하지 않고 실패 런을 한 번만 남긴다.
      if (!RECORDED.has(plan)) {
        RECORDED.add(plan);
        await record(deps, { ...run, ok: false, failureReason: "publish_failed" });
      }
      throw err;
    }
  },

  async crashed(deps, plan) {
    // publish가 이미 이 런의 실행 기록을 남겼다면 실패 기록을 또 남기지 않는다.
    if (!RECORDED.has(plan)) await record(deps, crashRecord("improve", plan));
    await fail(deps, plan, "개선 단계가 비정상 종료했다(에이전트 크래시 또는 러너 오류).");
  },
};
