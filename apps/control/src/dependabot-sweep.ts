import { requiredChecksState } from "./decision";
import {
  DEPENDABOT_USER_ID,
  judgeDependabotPr,
  type DependabotPr,
  type HumanCode,
  type OpenAlert,
  type PrCommit,
} from "./dependabot";
import { errorKind } from "./diagnostics";
import { parsePolicy } from "./policy";
import type { PullRequestPort } from "./pull-port";

export const LABEL_NEEDS_HUMAN = "factory:needs-human";

export interface DependabotGitHub {
  /** Open pull requests of the repository, whoever wrote them. */
  listOpenPrs(repo: string): Promise<DependabotPr[]>;
  listCommits(repo: string, prNumber: number): Promise<PrCommit[]>;
  /** Open Dependabot alerts. Null when the App may not read them. */
  listOpenAlerts(repo: string): Promise<OpenAlert[] | null>;
  addLabel(repo: string, prNumber: number, label: string): Promise<void>;
  comment(repo: string, prNumber: number, body: string): Promise<void>;
}

export interface SweepDeps {
  now(): number;
  /** How old the newest commit of a pull request must be before it merges. */
  minAgeMs: number;
  projects: readonly string[];
  github: DependabotGitHub;
  pulls: Pick<
    PullRequestPort,
    "getPullRequest" | "listFiles" | "readPolicy" | "listChecks" | "merge"
  >;
  log(event: string, fields?: Record<string, string | number>): void;
}

export type SweepResult =
  | { repo: string; pr: number; action: "merged" }
  | { repo: string; pr: number; action: "needs_human"; code: HumanCode }
  | { repo: string; pr: number; action: "wait"; code: string }
  | { repo: string; pr: number; action: "skipped"; code: string };

const REASONS: Record<HumanCode, string> = {
  not_single_update:
    "제목에서 패키지 하나의 버전 올림을 읽지 못했습니다. 여러 패키지를 묶은 업데이트는 자동으로 병합하지 않습니다.",
  foreign_commit:
    "Dependabot이 아닌 계정의 커밋이 있거나 커밋 목록을 읽지 못했습니다.",
  version_unreadable:
    "버전이 `major.minor.patch` 형식이 아니거나 올림이 아닙니다.",
  major_update:
    "메이저 버전 올림입니다(1.0 미만 패키지는 마이너 올림도 포함). 호환성을 사람이 확인해야 합니다.",
  not_security_update:
    "이 버전 올림으로 해결되는 열린 Dependabot 보안 경고를 찾지 못했습니다.",
  unexpected_files:
    "`package.json`과 `pnpm-lock.yaml` 밖의 파일이 바뀌었거나 파일 목록을 끝까지 읽지 못했습니다.",
  check_failed: "필수 체크가 실패했습니다.",
};

const humanComment = (code: HumanCode) =>
  [
    "팩토리가 이 Dependabot PR을 자동으로 병합하지 않았습니다. 사람의 확인이 필요합니다.",
    "",
    `- 이유(\`${code}\`): ${REASONS[code]}`,
    `- 팩토리는 \`${LABEL_NEEDS_HUMAN}\` 라벨이 있는 PR을 다시 판정하지 않습니다. 팩토리가 다시 보게 하려면 라벨을 떼세요.`,
  ].join("\n");

const mergedComment = (days: number) =>
  [
    "팩토리가 이 Dependabot PR을 자동으로 병합했습니다. 확인한 조건은 다음과 같습니다.",
    "",
    "- 작성자와 모든 커밋의 작성자가 Dependabot입니다.",
    "- 패키지 하나의 패치 또는 마이너 버전 올림이며, 열린 Dependabot 보안 경고를 해결합니다.",
    "- 바뀐 파일은 `package.json`과 `pnpm-lock.yaml`뿐입니다.",
    "- 기본 브랜치의 `.factory/policy.yml`이 정한 필수 체크가 모두 통과했습니다.",
    `- 마지막 커밋 뒤 ${days}일 이상 지났습니다.`,
  ].join("\n");

async function sweepPr(
  repo: string,
  pr: DependabotPr,
  alerts: readonly OpenAlert[],
  required: Parameters<typeof requiredChecksState>[0],
  deps: SweepDeps,
): Promise<SweepResult> {
  const base = { repo, pr: pr.number };
  const held = pr.labels.includes(LABEL_NEEDS_HUMAN);

  // Read the pull request again: the list may be seconds old, and the file count is not in it.
  const live = await deps.pulls.getPullRequest(repo, pr.number);
  if (live.state !== "open" || live.merged)
    return { ...base, action: "skipped", code: "closed" };
  if (live.headSha !== pr.headSha)
    return { ...base, action: "skipped", code: "head_moved" };

  const commits = await deps.github.listCommits(repo, pr.number);
  const listed = await deps.pulls.listFiles(repo, pr.number, live.changedFiles);
  const checks = await deps.pulls.listChecks(repo, pr.headSha);

  const judgement = judgeDependabotPr({
    pr,
    commits,
    files: listed.files.flatMap((f) =>
      f.previousFilename === undefined
        ? [f.filename]
        : [f.filename, f.previousFilename],
    ),
    filesTruncated: listed.truncated,
    alerts,
    checks: requiredChecksState(required, checks),
    now: deps.now(),
    minAgeMs: deps.minAgeMs,
  });

  if (judgement.action === "skip")
    return { ...base, action: "skipped", code: "not_dependabot" };
  if (judgement.action === "needs_human") {
    if (!held) {
      await deps.github.addLabel(repo, pr.number, LABEL_NEEDS_HUMAN);
      await deps.github.comment(repo, pr.number, humanComment(judgement.code));
    }
    return { ...base, action: "needs_human", code: judgement.code };
  }
  // A person was asked to look and has not released it: never merge over that.
  if (held) return { ...base, action: "skipped", code: "held" };
  if (judgement.action === "wait")
    return { ...base, action: "wait", code: judgement.code };

  const merged = await deps.pulls.merge(repo, pr.number, pr.headSha, {
    title: `${pr.title} (#${pr.number})`,
    body: "Dependabot 보안 업데이트. 팩토리가 조건을 확인하고 자동으로 병합했다.",
  });
  if (merged !== "merged")
    return { ...base, action: "skipped", code: `merge_${merged}` };
  try {
    await deps.github.comment(
      repo,
      pr.number,
      mergedComment(Math.floor(deps.minAgeMs / 86_400_000)),
    );
  } catch (error) {
    deps.log("dependabot_comment_failed", { repo, error: errorKind(error) });
  }
  return { ...base, action: "merged" };
}

/**
 * One pass over the Dependabot pull requests of the given repositories. A failure in one
 * repository or one pull request is logged and does not stop the others.
 */
export async function runDependabotSweep(
  deps: SweepDeps,
): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  for (const repo of deps.projects) {
    try {
      const prs = (await deps.github.listOpenPrs(repo)).filter(
        (pr) => pr.author.id === DEPENDABOT_USER_ID,
      );
      if (prs.length === 0) continue;

      const alerts = await deps.github.listOpenAlerts(repo);
      if (alerts === null) {
        deps.log("dependabot_alerts_unavailable", { repo });
        continue;
      }
      // Required checks come from the default branch, never from the pull request.
      const file = await deps.pulls.readPolicy(
        repo,
        (prs[0] as DependabotPr).defaultBranch,
      );
      const parsed = file.kind === "ok" ? parsePolicy(file.text) : null;
      if (
        parsed === null ||
        !parsed.ok ||
        parsed.policy.requiredChecks.length === 0
      ) {
        deps.log("dependabot_policy_invalid", { repo });
        continue;
      }

      for (const pr of prs) {
        try {
          results.push(
            await sweepPr(repo, pr, alerts, parsed.policy.requiredChecks, deps),
          );
        } catch (error) {
          deps.log("dependabot_pr_failed", {
            repo,
            pr: pr.number,
            error: errorKind(error),
          });
          results.push({
            repo,
            pr: pr.number,
            action: "skipped",
            code: "failed",
          });
        }
      }
    } catch (error) {
      deps.log("dependabot_repo_failed", { repo, error: errorKind(error) });
    }
  }
  const count = (action: SweepResult["action"]) =>
    results.filter((r) => r.action === action).length;
  deps.log("dependabot_sweep", {
    repos: deps.projects.length,
    merged: count("merged"),
    needs_human: count("needs_human"),
    wait: count("wait"),
    skipped: count("skipped"),
  });
  return results;
}
