/** Portal data model. Types mirror the control API JSON; nothing is imported from the control app. */

export interface Cost {
  status: "measured" | "not_measured" | "unknown";
  totalUsd: number | null;
  implementUsd: number | null;
  reviewUsd: number | null;
}

export interface RunSummary {
  id: string;
  repo: string;
  issueNumber: number;
  title: string | null;
  tier: string | null;
  state: string;
  reasonCode: string | null;
  prNumber: number | null;
  headSha: string | null;
  createdAt: number;
  updatedAt: number;
  bucket: "attention" | "active" | "done";
  cost: Cost;
}

export interface RunEvent {
  ts: number;
  kind: string;
  fromState: string | null;
  toState: string | null;
  reasonCode: string | null;
}

export interface RunDetail extends RunSummary {
  events: RunEvent[];
}

export interface Totals {
  attention: number;
  active: number;
  done: number;
  usd: number | null;
}

export interface SessionView {
  role: "anonymous" | "observer" | "operator";
  login: string | null;
  loginEnabled: boolean;
}

export const STAGE_NAMES = [
  "대기",
  "구현",
  "리뷰",
  "체크",
  "승인",
  "종료",
] as const;

const STAGES: Record<string, number> = {
  queued: 0,
  cloning: 1,
  implementing: 1,
  publishing: 1,
  pr_opened: 1,
  reviewing: 2,
  awaiting_checks: 3,
  awaiting_approval: 4,
  merged: 5,
  needs_human: 5,
  failed: 5,
};

export function stageOf(state: string): number {
  return STAGES[state] ?? 5;
}

/** A stopped run keeps the stage of its last transition when events are loaded, else 5. */
export function stageForRun(
  run: { state: string },
  events?: RunEvent[],
): number {
  if (run.state !== "needs_human" && run.state !== "failed")
    return stageOf(run.state);
  if (!events) return 5;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      e &&
      e.kind === "transition" &&
      e.fromState &&
      e.fromState !== run.state
    ) {
      return stageOf(e.fromState);
    }
  }
  return 5;
}

const WHY: Record<string, string> = {
  empty_change: "에이전트가 변경을 만들지 않아 PR을 열지 않았습니다.",
  too_many_files: "변경된 파일 수가 한도를 넘어 PR을 열지 않았습니다.",
  total_too_large: "변경 전체 크기가 한도를 넘어 PR을 열지 않았습니다.",
  file_too_large: "파일 하나가 크기 한도를 넘어 PR을 열지 않았습니다.",
  forbidden_path: "변경이 금지된 경로를 건드려 PR을 열지 않았습니다.",
  absolute_path: "절대 경로가 포함된 변경이라 거부했습니다.",
  path_traversal: "상위 디렉터리로 벗어나는 경로가 포함되어 거부했습니다.",
  symlink: "심볼릭 링크가 포함된 변경이라 거부했습니다.",
  submodule: "서브모듈이 포함된 변경이라 거부했습니다.",
  special_file: "일반 파일이 아닌 특수 파일이 포함되어 거부했습니다.",
  path_not_utf8: "UTF-8이 아닌 경로가 포함되어 거부했습니다.",
  path_control_char: "제어 문자가 섞인 경로가 포함되어 거부했습니다.",
  malformed_output:
    "에이전트 출력 형식이 올바르지 않아 변경을 읽지 못했습니다.",
  timeout: "실행 시간이 한도를 넘어 멈췄습니다.",
  agent_failed: "에이전트가 오류로 종료되어 실행이 멈췄습니다.",
  agent_timeout: "에이전트가 제한 시간 안에 끝나지 않아 멈췄습니다.",
  sandbox_lost: "샌드박스 연결을 잃어 실행을 이어 갈 수 없었습니다.",
  clone_failed: "저장소를 복제하지 못해 실행이 멈췄습니다.",
  publish_failed: "브랜치나 PR을 게시하지 못해 실행이 멈췄습니다.",
  internal_error: "제어 평면 내부 오류로 실행이 멈췄습니다.",
  cleanup_failed: "샌드박스 정리에 실패했습니다. 남은 자원을 확인해야 합니다.",
  legacy_run:
    "리뷰 기능 도입 전에 만들어진 실행이라 자동 판정 대상이 아닙니다.",
  pr_closed: "PR이 병합 없이 닫혀 자동 처리를 멈췄습니다.",
  base_not_default:
    "PR의 대상 브랜치가 기본 브랜치가 아니라 자동 처리를 멈췄습니다.",
  head_changed: "리뷰 이후 PR의 최신 커밋이 바뀌어 다시 확인이 필요합니다.",
  policy_missing: "저장소에 병합 정책 파일이 없어 자동 판정을 할 수 없습니다.",
  policy_invalid:
    "병합 정책 파일의 내용이 올바르지 않아 자동 판정을 할 수 없습니다.",
  files_truncated:
    "변경 파일 목록이 잘려 전체를 검토할 수 없어 사람의 확인이 필요합니다.",
  diff_too_large: "변경 diff가 너무 커서 교차 리뷰를 하지 못했습니다.",
  review_failed: "교차 리뷰 실행이 실패해 자동 처리를 멈췄습니다.",
  review_invalid: "교차 리뷰 응답 형식이 올바르지 않아 결과를 쓰지 못했습니다.",
  changes_requested: "교차 리뷰가 변경을 요청해 자동 처리를 멈췄습니다.",
  check_failed: "필수 체크가 실패해 병합하지 않았습니다.",
  checks_timeout: "체크가 제한 시간 안에 끝나지 않아 병합하지 않았습니다.",
  checks_permission_missing:
    "체크 결과를 읽을 권한이 없어 병합 여부를 판정하지 못했습니다.",
  operator_changes_requested: "운영자가 변경을 요청해 자동 처리를 멈췄습니다.",
  approval_timeout: "운영자 승인이 제한 시간 안에 오지 않아 멈췄습니다.",
  merge_refused: "GitHub가 병합을 거부해 PR이 열린 채 남았습니다.",
  merge_conflict: "기본 브랜치와 충돌해 병합하지 못했습니다.",
};

export function explain(run: {
  state: string;
  reasonCode: string | null;
  tier: string | null;
}): string {
  const { state, reasonCode } = run;
  if (reasonCode && WHY[reasonCode]) return WHY[reasonCode];
  if (state === "failed") {
    return reasonCode
      ? `실행이 실패했습니다. 사유 코드: ${reasonCode}`
      : "실행이 실패했습니다.";
  }
  if (state === "needs_human") {
    return reasonCode
      ? `사람의 확인이 필요합니다. 사유 코드: ${reasonCode}`
      : "자동 처리를 멈추고 사람의 확인을 기다립니다.";
  }
  switch (state) {
    case "queued":
      return "실행 차례를 기다리고 있습니다.";
    case "cloning":
      return "저장소를 샌드박스로 복제하고 있습니다.";
    case "implementing":
      return "에이전트가 이슈를 구현하고 있습니다.";
    case "publishing":
      return "변경을 브랜치로 게시하고 있습니다.";
    case "pr_opened":
      return "PR을 열었고 리뷰를 시작할 차례입니다.";
    case "reviewing":
      return "다른 모델이 변경을 교차 리뷰하고 있습니다.";
    case "awaiting_checks":
      return "필수 체크가 끝나기를 기다리고 있습니다.";
    case "awaiting_approval":
      return "위험 등급상 운영자 승인이 필요합니다.";
    case "merged":
      return "병합을 마쳤습니다.";
    default:
      return `상태: ${state}`;
  }
}

export function money(cost: {
  status: string;
  totalUsd: number | null;
}): string {
  if (cost.status === "measured" && cost.totalUsd !== null)
    return `$${cost.totalUsd.toFixed(2)}`;
  if (cost.status === "not_measured") return "측정 전";
  return "계산 불가";
}

/** Relative time in Korean. Both arguments are epoch milliseconds. */
export function ago(ts: number, now: number): string {
  const min = Math.floor(Math.max(0, now - ts) / 60_000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

async function getJson<T>(fetchFn: typeof fetch, url: string): Promise<T> {
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchConsole(
  fetchFn: typeof fetch,
): Promise<{ runs: RunSummary[]; totals: Totals; session: SessionView }> {
  const [list, session] = await Promise.all([
    getJson<{ runs: RunSummary[]; totals: Totals }>(fetchFn, "/api/runs"),
    getJson<SessionView>(fetchFn, "/api/session"),
  ]);
  return { runs: list.runs, totals: list.totals, session };
}

export async function fetchRun(
  fetchFn: typeof fetch,
  id: string,
): Promise<RunDetail | null> {
  const url = `/api/runs/${encodeURIComponent(id)}`;
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as RunDetail;
}

export type ReviewResult =
  { ok: true; redirect?: string } | { ok: false; error: string };

export async function sendReview(
  fetchFn: typeof fetch,
  id: string,
  action: "approve" | "request_changes",
  headSha: string,
): Promise<ReviewResult> {
  const res = await fetchFn(`/api/runs/${encodeURIComponent(id)}/review`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ action, headSha }),
  });
  let body: { error?: string; redirect?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // non-JSON body
  }
  if (!res.ok) return { ok: false, error: body.error ?? `http_${res.status}` };
  return body.redirect ? { ok: true, redirect: body.redirect } : { ok: true };
}
