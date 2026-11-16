import { requiredChecksState } from "./decision";
import {
  DEPENDABOT_USER_ID,
  judgeDependabotPr,
  type DependabotPr,
  type HumanCode,
  type OpenAlert,
  parseBump,
  type PrCommit,
  type PrFile,
} from "./dependabot";
import { errorKind } from "./diagnostics";
import { parsePolicy } from "./policy";
import type { PullRequestPort } from "./pull-port";

export const LABEL_NEEDS_HUMAN = "factory:needs-human";

export interface DependabotGitHub {
  /** Open pull requests of the repository, whoever wrote them. */
  listOpenPrs(repo: string): Promise<DependabotPr[]>;
  /** The pull request as it is now. `open` is false once it is closed or merged. */
  getPr(
    repo: string,
    prNumber: number,
  ): Promise<DependabotPr & { open: boolean }>;
  /** Changed files with their diffs. `truncated` is true when the list may be incomplete. */
  listFiles(
    repo: string,
    prNumber: number,
  ): Promise<{ files: PrFile[]; truncated: boolean }>;
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
  pulls: Pick<PullRequestPort, "readPolicy" | "listChecks" | "merge">;
  /** The factory-wide stop, read again right before a merge. */
  paused(): Promise<boolean>;
  log(event: string, fields?: Record<string, string | number>): void;
}

export type SweepResult =
  | { repo: string; pr: number; action: "merged" }
  | { repo: string; pr: number; action: "needs_human"; code: HumanCode }
  | { repo: string; pr: number; action: "wait"; code: string }
  | { repo: string; pr: number; action: "skipped"; code: string };

const REASONS: Record<HumanCode, string> = {
  not_single_update:
    "커밋 메시지에서 패키지 하나의 버전 올림을 읽지 못했거나, PR 제목이 커밋 메시지와 다릅니다. 여러 패키지를 묶은 업데이트는 자동으로 병합하지 않습니다.",
  foreign_commit:
    "커밋이 Dependabot이 작성하고 GitHub이 서명한 커밋 하나가 아닙니다. 커밋이 여러 개이거나 커밋 목록을 읽지 못한 경우도 여기에 해당합니다.",
  version_unreadable:
    "버전이 `major.minor.patch` 형식이 아니거나 올림이 아닙니다.",
  major_update:
    "메이저 버전 올림입니다(1.0 미만 패키지는 마이너 올림도 포함). 호환성을 사람이 확인해야 합니다.",
  not_security_update:
    "이 버전 올림으로 해결되는 열린 Dependabot 보안 경고를 찾지 못했습니다.",
  unexpected_files:
    "`package.json`에서 해당 패키지의 버전 외의 내용이 바뀌었거나, `pnpm-lock.yaml`에 그 패키지의 새 버전이 없거나 레지스트리가 아닌 출처가 더해졌거나, 그 밖의 파일이 바뀌었습니다. 파일 목록이나 diff를 끝까지 읽지 못한 경우도 여기에 해당합니다.",
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
    "- 작성자가 Dependabot이고, 커밋은 Dependabot 작성, GitHub 서명(검증됨)인 커밋 하나입니다.",
    "- 서명된 커밋 메시지가 말하는 패키지 하나의 패치 또는 마이너 버전 올림이며, 열린 Dependabot 보안 경고를 해결합니다.",
    "- `package.json`에서는 그 패키지의 버전만 바뀌었고, `pnpm-lock.yaml`에 레지스트리가 아닌 출처가 더해지지 않았습니다.",
    "- 기본 브랜치의 `.factory/policy.yml`이 정한 필수 체크가 모두 통과했습니다.",
    `- 마지막 커밋 뒤 ${days}일 이상 지났습니다.`,
  ].join("\n");

async function sweepPr(
  repo: string,
  prNumber: number,
  alerts: readonly OpenAlert[],
  required: Parameters<typeof requiredChecksState>[0],
  deps: SweepDeps,
): Promise<SweepResult> {
  const base = { repo, pr: prNumber };
  // Judge what the pull request is now, not what the list said: the title, the base
  // branch and the labels can all change. The merge is pinned to the head read here.
  const pr = await deps.github.getPr(repo, prNumber);
  if (!pr.open) return { ...base, action: "skipped", code: "closed" };
  const held = pr.labels.includes(LABEL_NEEDS_HUMAN);

  const commits = await deps.github.listCommits(repo, prNumber);
  const listed = await deps.github.listFiles(repo, prNumber);
  const checks = await deps.pulls.listChecks(repo, pr.headSha);

  const judgement = judgeDependabotPr({
    pr,
    commits,
    files: listed.files,
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
      // The comment first: a label without a reason would hold the pull request silently.
      await deps.github.comment(repo, prNumber, humanComment(judgement.code));
      await deps.github.addLabel(repo, prNumber, LABEL_NEEDS_HUMAN);
    }
    return { ...base, action: "needs_human", code: judgement.code };
  }
  // A person was asked to look and has not released it: never merge over that.
  if (held) return { ...base, action: "skipped", code: "held" };
  if (judgement.action === "wait")
    return { ...base, action: "wait", code: judgement.code };

  const bump = parseBump(pr.title);
  if (bump === null) return { ...base, action: "skipped", code: "failed" };
  if (await deps.paused())
    return { ...base, action: "skipped", code: "factory_paused" };
  // Last look before the merge: a person may have put a hold on it meanwhile.
  const last = await deps.github.getPr(repo, prNumber);
  if (!last.open || last.headSha !== pr.headSha)
    return { ...base, action: "skipped", code: "head_moved" };
  if (last.labels.includes(LABEL_NEEDS_HUMAN))
    return { ...base, action: "skipped", code: "held" };
  const merged = await deps.pulls.merge(repo, prNumber, pr.headSha, {
    // Built from the parsed parts, not copied from the title.
    title: `chore(deps): bump ${bump.package} from ${bump.from} to ${bump.to} (#${prNumber})`,
    body: "Dependabot 보안 업데이트. 팩토리가 조건을 확인하고 자동으로 병합했다.",
  });
  if (merged !== "merged")
    return { ...base, action: "skipped", code: `merge_${merged}` };
  try {
    await deps.github.comment(
      repo,
      prNumber,
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
            await sweepPr(
              repo,
              pr.number,
              alerts,
              parsed.policy.requiredChecks,
              deps,
            ),
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
  // One line for each pull request that was judged, so a refused merge or a hold shows.
  for (const r of results)
    deps.log("dependabot_pr", {
      repo: r.repo,
      pr: r.pr,
      action: r.action,
      ...("code" in r ? { code: r.code } : {}),
    });
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
