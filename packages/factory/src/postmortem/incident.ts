import type { RunRecord } from "../runs/store";
import type { StageDeps } from "../stages/deps";
import type { IncidentKind } from "../stages/postmortem-trigger";

export interface Incident {
  issue: number;
  kind: IncidentKind;
  episode: number;
  detectedAt: string;
  lastGoodAt: string | null;
  recoveredAt: string | null;
}

export function incidentKey(i: Incident): string {
  return `${i.issue}#${i.episode}`;
}

// 스모크 이슈는 복구 뒤에도 닫히지 않고 다음 실패가 같은 이슈에 붙는다. 그래서 복구 횟수로 회차를 센다.
// 마지막 스모크 기록이 복구이면 방금 복구된 회차를, 아니면 진행 중인 회차를 가리킨다.
function smokeEpisode(records: RunRecord[], now: string): Omit<Incident, "issue" | "kind"> {
  const smoke = records.filter((r) => r.role === "smoke");
  const goods = smoke.filter((r) => r.ok);
  const recovered = smoke.at(-1)?.ok === true;
  const episode = recovered ? goods.length : goods.length + 1;
  const previousGood = recovered ? goods.at(-2) : goods.at(-1);
  const lastGoodAt = previousGood?.ts ?? null;
  const first = smoke.find((r) => !r.ok && (lastGoodAt === null || r.ts > lastGoodAt));
  return {
    episode,
    detectedAt: first?.ts ?? now,
    lastGoodAt,
    recoveredAt: recovered ? (goods.at(-1)?.ts ?? null) : null,
  };
}

export async function resolveIncident(
  deps: StageDeps,
  issue: number,
  kind: IncidentKind,
): Promise<Incident> {
  const records = (await deps.runs.since(new Date(0))).filter((r) => r.issue === issue);
  const now = deps.now().toISOString();
  if (kind === "smoke") return { issue, kind, ...smokeEpisode(records, now) };
  // 배포 실패는 병합 뒤에 일어난다. 병합 전 리뷰·게이트 실패까지 첫 실패로 잡으면 요청 PR이 구간 밖이 된다.
  const first =
    kind === "deploy"
      ? records.findLast((r) => r.role === "deploy" && !r.ok)
      : records.find((r) => !r.ok);
  return {
    issue,
    kind,
    episode: 1,
    detectedAt: first?.ts ?? now,
    lastGoodAt: null,
    recoveredAt: null,
  };
}
