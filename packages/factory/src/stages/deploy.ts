import { parseFactoryIssues } from "../report/commit";
import { moveTo, record, runLink, stepRecord } from "./common";
import type { StageDeps } from "./deps";
import { requestPostmortem } from "./postmortem-trigger";

export const SUPERSEDED_SCAN = { days: 14, maxCommits: 50 } as const;

// 배포 SHA보다 앞선 main 커밋의 이슈. deploy 동시성 그룹은 대기 중인 실행을 더 새 실행으로
// 대체(취소)하므로, 취소된 실행의 이슈는 다음 배포에 포함되지만 그 커밋 메시지에는 없다.
// main은 squash 병합만 하므로 목록에서 sha 뒤의 커밋은 모두 sha의 조상이다.
async function supersededIssues(deps: StageDeps, sha: string): Promise<number[]> {
  const since = new Date(deps.now().getTime() - SUPERSEDED_SCAN.days * 24 * 60 * 60 * 1000);
  const commits = await deps.gh.listCommits(since);
  const at = commits.findIndex((c) => c.sha === sha);
  if (at < 0) return [];
  return commits
    .slice(at + 1, at + 1 + SUPERSEDED_SCAN.maxCommits)
    .flatMap((c) => parseFactoryIssues(c.message));
}

export async function runDeployed(deps: StageDeps, { sha }: { sha: string }): Promise<number[]> {
  const done: number[] = [];
  const own = parseFactoryIssues(await deps.gh.getCommitMessage(sha));
  const earlier = (await supersededIssues(deps, sha)).filter((i) => !own.includes(i));
  for (const issue of [...own, ...new Set(earlier)]) {
    // 이전 실행이 라벨만 바꾸고 닫기 전에 끝났다면 다시 실행할 때 닫는다.
    const current = await deps.gh.getIssue(issue);
    const isOwn = own.includes(issue);
    if (current.labels.includes("factory:deployed") && current.state === "open") {
      await deps.gh.closeIssue(issue);
      continue;
    }
    // 앞선 커밋의 이슈는 아직 merged 상태로 열려 있는 것만 옮긴다.
    if (!isOwn && !(current.state === "open" && current.labels.includes("factory:merged")))
      continue;
    const moved = await moveTo(
      deps,
      issue,
      "deployed",
      "deploy",
      `프로덕션 배포와 스모크 테스트가 통과했다(커밋 \`${sha.slice(0, 7)}\`). 이슈를 닫는다.${runLink(deps.settings)}`,
    );
    if (!moved) continue;
    await deps.gh.closeIssue(issue);
    await record(deps, stepRecord("deploy", issue, null, true));
    done.push(issue);
  }
  return done;
}

export async function runDeployFailed(
  deps: StageDeps,
  { sha }: { sha: string },
): Promise<number[]> {
  const done: number[] = [];
  for (const issue of parseFactoryIssues(await deps.gh.getCommitMessage(sha))) {
    const moved = await moveTo(
      deps,
      issue,
      "needs-human",
      "deploy",
      `프로덕션 배포 또는 스모크 테스트가 실패했다(커밋 \`${sha.slice(0, 7)}\`). 프로덕션 API가 이전 버전으로 남았을 수 있다. 롤백 절차는 [개발자·운영자 안내](https://github.com/${deps.settings.owner}/${deps.settings.repo}/blob/main/docs/operations.md#배포-롤백)를 따른다.${runLink(deps.settings)}`,
    );
    if (!moved) continue;
    await deps.gh.addLabels(issue, ["source:deploy"]);
    await record(deps, stepRecord("deploy", issue, null, false, "deploy_failed"));
    await requestPostmortem(deps, { issue, kind: "deploy", event: "detected" });
    done.push(issue);
  }
  return done;
}
