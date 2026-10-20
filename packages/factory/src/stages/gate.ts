import { TooManyFilesError, type ChangedFile, type CheckRun, type Pull } from "../github/port";
import { classifyFiles } from "../policy/risk";
import { latestVerdict } from "../report/comments";
import { signatureTrailers } from "../report/commit";
import { parsePrMeta } from "../report/pr";
import { inline } from "../report/text";
import { addsSkipEntries } from "./risk";
import { moveTo, readState, record, runLink, stepRecord } from "./common";
import type { StageDeps } from "./deps";

export type CheckState = "pass" | "pending" | "fail";

// preview.yml의 job 이름. main 보호 규칙의 필수 체크는 아니지만 gate는 T0·T1 병합 전에 확인한다.
export const PREVIEW_CHECKS = ["deploy", "e2e-preview", "smoke-preview"];

export function checkState(run: CheckRun | undefined): CheckState {
  if (!run || run.status !== "completed") return "pending";
  if (run.conclusion === "success" || run.conclusion === "skipped" || run.conclusion === "neutral")
    return "pass";
  // ci.yml의 cancel-in-progress로 취소된 실행은 새 실행이 곧 결과를 낸다.
  if (run.conclusion === null || run.conclusion === "cancelled" || run.conclusion === "stale")
    return "pending";
  return "fail";
}

export function summarizeChecks(
  runs: CheckRun[],
  required: string[],
): { state: CheckState; failing: string[]; pending: string[] } {
  const failing: string[] = [];
  const pending: string[] = [];
  for (const name of required) {
    const s = checkState(runs.find((r) => r.name === name));
    if (s === "fail") failing.push(name);
    else if (s === "pending") pending.push(name);
  }
  return {
    state: failing.length > 0 ? "fail" : pending.length > 0 ? "pending" : "pass",
    failing,
    pending,
  };
}

export function flattenFiles(files: ChangedFile[]): string[] {
  return files.flatMap((f) =>
    f.previousFilename ? [f.filename, f.previousFilename] : [f.filename],
  );
}

export interface GateArgs {
  pr?: number;
  branch?: string;
}

export type GateDecision =
  "ignored" | "pending" | "fix-dispatched" | "merged" | "merge-failed" | "needs-human";

async function findPull(deps: StageDeps, args: GateArgs): Promise<Pull | null> {
  if (args.pr !== undefined) return deps.gh.getPull(args.pr);
  if (args.branch) return deps.gh.findOpenPullByHead(args.branch);
  return null;
}

export async function runGate(deps: StageDeps, args: GateArgs): Promise<GateDecision> {
  const pull = await findPull(deps, args);
  if (!pull || pull.state !== "open" || pull.draft || pull.author !== deps.settings.botLogin)
    return "ignored";
  if (pull.baseRef !== "main") {
    deps.log(`gate ignored PR #${pull.number}: base is ${pull.baseRef}, not main`);
    return "ignored";
  }
  const meta = parsePrMeta(pull.body);
  if (!meta) return "ignored";
  if (meta.role === "improve") {
    deps.log(`gate: 개선 PR #${pull.number}은 사람이 병합한다`);
    return "ignored";
  }
  const { state } = await readState(deps.gh, meta.issue);
  if (state !== "in-review") return "ignored";
  // 에이전트가 스스로 끝낼 수 없다고 선언한 PR은 체크·리뷰 결과와 상관없이 병합하지 않는다.
  // PR #65는 스모크가 깨진다고 "남은 위험"에 적었지만 아무 단계도 읽지 않아 병합됐다.
  if (meta.humanActions?.length) {
    await moveTo(
      deps,
      meta.issue,
      "needs-human",
      "gate",
      [
        `PR #${pull.number}의 에이전트가 사람만 할 수 있는 조치를 선언했다. 조치가 끝나기 전에는 자동 병합하지 않는다.`,
        "",
        ...meta.humanActions.map((a) => `- ${inline(a)}`),
        runLink(deps.settings).trim(),
      ]
        .filter((l, i) => l !== "" || i === 1)
        .join("\n"),
    );
    await record(
      deps,
      stepRecord("gate", meta.issue, pull.number, false, "human_action", meta.round),
    );
    return "needs-human";
  }

  const runs = await deps.gh.listCheckRuns(pull.headSha);
  const checks = summarizeChecks(runs, deps.policy.requiredChecks);
  const verdict = latestVerdict(
    await deps.gh.listReviews(pull.number),
    deps.settings.botLogin,
    pull.headSha,
  );

  if (checks.state === "fail") {
    if (checks.failing.includes("risk-tier")) {
      await moveTo(
        deps,
        meta.issue,
        "needs-human",
        "gate",
        `PR #${pull.number}의 risk-tier 체크가 실패했다. 구현 역할 PR이 T3 경로를 바꿨거나 등급 판정이 실패했다.${runLink(deps.settings)}`,
      );
      await record(
        deps,
        stepRecord("gate", meta.issue, pull.number, false, "risk_tier", meta.round),
      );
      return "needs-human";
    }
    if (verdict?.verdict === "REQUEST_CHANGES") return "pending";
    await deps.gh.dispatchWorkflow("factory-fix.yml", {
      pr: String(pull.number),
      sha: pull.headSha,
      reason: "ci",
      issue: String(meta.issue),
    });
    return "fix-dispatched";
  }
  if (checks.state === "pending") return "pending";

  let files: ChangedFile[];
  try {
    files = await deps.gh.listPullFiles(pull.number);
  } catch (e) {
    if (!(e instanceof TooManyFilesError)) throw e;
    // 변경 파일 목록을 끝까지 얻지 못하면 등급을 알 수 없으므로 T3로 보고 사람에게 넘긴다.
    await moveTo(
      deps,
      meta.issue,
      "needs-human",
      "gate",
      `PR #${pull.number}의 변경 파일이 너무 많아 위험 등급을 판정할 수 없다. T3로 보고 자동 병합하지 않는다. 사람이 확인한다.${runLink(deps.settings)}`,
    );
    await record(
      deps,
      stepRecord("gate", meta.issue, pull.number, false, "too_many_files", meta.round),
    );
    return "needs-human";
  }
  const risk = classifyFiles(flattenFiles(files), deps.policy);
  // 방어선 이중화: risk-tier 체크가 통과했더라도 skip.txt 우회는 여기서도 막는다(F21).
  if (meta.role === "implement" && addsSkipEntries(files)) {
    await moveTo(
      deps,
      meta.issue,
      "needs-human",
      "gate",
      `PR #${pull.number}이 \`tests/realworld/skip.txt\`에 줄을 추가했거나 변경을 줄 단위로 확인할 수 없다. 자동 병합하지 않는다.${runLink(deps.settings)}`,
    );
    await record(deps, stepRecord("gate", meta.issue, pull.number, false, "skip_txt", meta.round));
    return "needs-human";
  }
  // T2는 교차 리뷰가 현재 head를 승인한 뒤에 사람에게 넘긴다. 그 전에 넘기면 리뷰의 변경 요청이
  // 수정 라운드를 거치지 않은 채 사람에게 간다(2026-10-18 PR #69). T3는 구현 역할이 바꿀 수 없는
  // 경로이므로 수정 라운드 없이 바로 넘긴다.
  if (risk.tier === "T2" && verdict?.verdict !== "APPROVE") return "pending";
  if (risk.tier === "T2" || risk.tier === "T3") {
    const deciding = risk.files
      .filter((f) => f.tier === risk.tier)
      .map((f) => `\`${f.file}\``)
      .join(", ");
    await moveTo(
      deps,
      meta.issue,
      "needs-human",
      "gate",
      `PR #${pull.number}은 위험 등급 ${risk.tier}이므로 자동 병합하지 않는다. CODEOWNERS(@serithemage)가 승인한 뒤 사람이 병합한다. 등급을 정한 파일: ${deciding}.`,
    );
    await record(
      deps,
      stepRecord(
        "gate",
        meta.issue,
        pull.number,
        false,
        `risk_${risk.tier.toLowerCase()}`,
        meta.round,
      ),
    );
    return "needs-human";
  }
  // T0·T1 PR은 프리뷰(preview.yml)까지 보고 병합한다. 필수 체크가 아니어서 PR #65는 프로덕션 스모크
  // 계약을 깬 채 병합됐다. T2·T3는 사람 승인 전에 프리뷰를 만들지 않으므로 여기에 오지 않는다.
  const preview = summarizeChecks(runs, PREVIEW_CHECKS);
  if (preview.failing.includes("deploy") || preview.failing.includes("smoke-preview")) {
    const deploy = preview.failing.includes("deploy");
    await moveTo(
      deps,
      meta.issue,
      "needs-human",
      "gate",
      deploy
        ? `PR #${pull.number}의 프리뷰 배포가 실패했다. 에이전트가 고칠 수 있는 실패가 아니므로 자동 병합하지 않는다. 사람이 확인한다.${runLink(deps.settings)}`
        : `PR #${pull.number}이 프리뷰에서 프로덕션 스모크(\`tests/smoke/\`, \`apps/web/e2e-smoke/\`)를 통과하지 못했다. 변경이 스모크 계약을 깼다. 스모크는 T3라 에이전트가 고칠 수 없으므로 자동 병합하지 않는다. 의도한 변경이면 사람이 스모크를 갱신한다.${runLink(deps.settings)}`,
    );
    await record(
      deps,
      stepRecord(
        "gate",
        meta.issue,
        pull.number,
        false,
        deploy ? "preview_deploy" : "smoke_contract",
        meta.round,
      ),
    );
    return "needs-human";
  }
  if (preview.state === "fail") {
    if (verdict?.verdict === "REQUEST_CHANGES") return "pending";
    await deps.gh.dispatchWorkflow("factory-fix.yml", {
      pr: String(pull.number),
      sha: pull.headSha,
      reason: "ci",
      issue: String(meta.issue),
    });
    return "fix-dispatched";
  }
  if (preview.state === "pending") return "pending";
  // 완료 정의: head에서 실행된 체크는 필수 여부와 상관없이 모두 통과해야 한다. 목록 밖 체크의 실패는
  // 에이전트가 고칠 대상인지 알 수 없으므로 사람에게 넘긴다.
  const known = new Set([...deps.policy.requiredChecks, ...PREVIEW_CHECKS]);
  const unlisted = runs
    .filter((r) => !known.has(r.name) && checkState(r) === "fail")
    .map((r) => r.name);
  if (unlisted.length > 0) {
    await moveTo(
      deps,
      meta.issue,
      "needs-human",
      "gate",
      `PR #${pull.number}의 체크가 실패했다: ${unlisted.map((n) => `\`${n}\``).join(", ")}. 필수 체크는 아니지만 실패한 체크가 있으면 자동 병합하지 않는다.${runLink(deps.settings)}`,
    );
    await record(
      deps,
      stepRecord("gate", meta.issue, pull.number, false, "unlisted_check", meta.round),
    );
    return "needs-human";
  }
  if (verdict?.verdict === "REQUEST_CHANGES") return "pending";
  if (risk.tier === "T1" && verdict?.verdict !== "APPROVE") return "pending";

  const merged = await deps.gh.mergePull(pull.number, {
    sha: pull.headSha,
    title: `${pull.title} (#${pull.number})`,
    message: `Refs #${meta.issue}\n\n${signatureTrailers(meta.implementEngine, meta.implementModel, meta.issue)}`,
  });
  if (!merged) {
    await moveTo(
      deps,
      meta.issue,
      "needs-human",
      "gate",
      `PR #${pull.number} 자동 병합을 GitHub가 거부했다(충돌 또는 보호 규칙). 사람이 확인한다.${runLink(deps.settings)}`,
    );
    await record(
      deps,
      stepRecord("gate", meta.issue, pull.number, false, "merge_refused", meta.round),
    );
    return "merge-failed";
  }
  await record(deps, stepRecord("gate", meta.issue, pull.number, true, null, meta.round));
  return "merged";
}

export async function runOnClosed(deps: StageDeps, { pr }: { pr: number }): Promise<boolean> {
  const pull = await deps.gh.getPull(pr);
  if (pull.author !== deps.settings.botLogin) return false;
  const meta = parsePrMeta(pull.body);
  if (!meta) return false;
  if (!pull.merged && pull.state !== "closed") return false;
  if (meta.role === "improve") {
    // 개선 PR의 meta.issue는 주간 리포트 이슈다. 상태 라벨을 바꾸지 않고 결과만 알린다.
    await deps.gh.comment(
      meta.issue,
      pull.merged ? `개선 PR #${pr}이 병합되었다.` : `개선 PR #${pr}이 병합 없이 닫혔다.`,
    );
    return false;
  }
  if (!pull.merged) {
    // 병합 없이 닫힌 봇 PR은 이슈가 in-review에 남지 않도록 사람에게 넘긴다.
    await moveTo(
      deps,
      meta.issue,
      "needs-human",
      "gate",
      `PR #${pr}이 병합 없이 닫혔다. 사람이 다시 진행할지 정한다.${runLink(deps.settings)}`,
    );
    return false;
  }
  return moveTo(
    deps,
    meta.issue,
    "merged",
    "github",
    `PR #${pr}이 병합되었다. 프로덕션 배포와 스모크 테스트를 기다린다.`,
  );
}
