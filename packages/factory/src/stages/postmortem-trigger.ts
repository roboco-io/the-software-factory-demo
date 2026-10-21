import type { StageDeps } from "./deps";

export type PostmortemEvent = "detected" | "recovered";
export type IncidentKind = "smoke" | "deploy" | "error" | "stall";

// 닫힌 이슈 이벤트처럼 호출자가 종류를 모를 때 이슈 라벨로 정한다. 프로덕션 라벨이 없으면 정체다.
export function kindFromLabels(labels: string[]): IncidentKind {
  if (labels.includes("source:smoke")) return "smoke";
  if (labels.includes("source:deploy")) return "deploy";
  if (labels.includes("source:error")) return "error";
  return "stall";
}

// 장애·정체를 감지하거나 복구했을 때 factory-postmortem.yml을 dispatch한다.
// 필터링은 postmortem 단계의 prepare가 한다. 실패해도 장애 보고 자체를 막지 않도록 예외는 로그만 남긴다.
export async function requestPostmortem(
  deps: StageDeps,
  input: { issue: number; kind: IncidentKind; event: PostmortemEvent },
): Promise<void> {
  try {
    await deps.gh.dispatchWorkflow("factory-postmortem.yml", {
      issue: String(input.issue),
      kind: input.kind,
      event: input.event,
    });
  } catch (err) {
    deps.log(`postmortem: dispatch for #${input.issue} (${input.kind}) failed: ${String(err)}`);
  }
}
