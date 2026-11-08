/** How a state or reason reads: ok = finished well, info = neutral, wait = in progress or waiting, attention = a person should look, fail = ended without a result. */
export type Tone = "ok" | "info" | "wait" | "attention" | "fail";

export interface Label {
  title: string;
  text: string;
}
export interface ReasonLabel extends Label {
  tone: Tone;
}

/** The run states. A test checks this table against the control plane's STATES. */
export const STATE_LABELS: Readonly<Record<string, Label>> = {
  queued: {
    title: "대기 중",
    text: "이슈를 받아 실행을 만들었고, 곧 작업을 시작합니다.",
  },
  cloning: {
    title: "저장소 내려받는 중",
    text: "격리된 샌드박스를 만들고 대상 저장소를 내려받고 있습니다.",
  },
  implementing: {
    title: "구현 중",
    text: "구현 에이전트가 샌드박스 안에서 이슈를 읽고 코드를 고치고 있습니다. 이 샌드박스에는 GitHub 토큰과 LLM 키가 없습니다.",
  },
  publishing: {
    title: "PR 만드는 중",
    text: "제어 평면이 에이전트가 만든 변경을 검사한 뒤 브랜치와 풀 리퀘스트(PR)로 올리고 있습니다.",
  },
  pr_opened: {
    title: "PR 열림",
    text: "PR이 열렸습니다. 리뷰를 시작하기 전에 위험 정책 파일과 바뀐 파일 목록을 확인합니다.",
  },
  reviewing: {
    title: "교차 리뷰 중",
    text: "구현과 다른 엔진이 새 샌드박스에서 변경을 읽기 전용으로 리뷰하고 있습니다.",
  },
  awaiting_engine: {
    title: "리뷰 엔진 대기",
    text: "예산이 남은 리뷰 엔진을 기다리고 있습니다. 한 계정의 예산이 소진되어 엔진이 하나만 남으면 위험 등급 T2·T3 변경은 다른 엔진을 쓸 수 있을 때까지 기다리고, 두 계정이 모두 소진되면 모든 변경이 기다립니다. 다음 청구 주기에 예산이 생기면 리뷰를 이어서 시작합니다.",
  },
  awaiting_checks: {
    title: "필수 체크 대기",
    text: "리뷰가 승인했습니다. 정책이 요구하는 필수 체크가 성공하기를 기다리고 있습니다.",
  },
  awaiting_approval: {
    title: "사람 승인 대기",
    text: "정책상 자동으로 병합할 수 없는 변경입니다. 운영자가 PR을 승인하면 프로그램이 다시 확인한 뒤 병합합니다.",
  },
  merged: {
    title: "병합됨",
    text: "프로그램이 판정 조건을 모두 확인하고 PR을 병합했습니다.",
  },
  needs_human: {
    title: "사람의 확인 필요",
    text: "자동으로 진행할 수 없어 멈췄습니다. 이유는 사유 설명에 있습니다.",
  },
  failed: {
    title: "실패",
    text: "PR이 만들어지기 전에 실행이 끝났습니다. 이유는 사유 설명에 있습니다.",
  },
};

export const EVENT_KIND_LABELS: Readonly<Record<string, Label>> = {
  created: {
    title: "실행 생성",
    text: "이슈를 받아 실행을 만들고 대기열에 올렸습니다.",
  },
  transition: {
    title: "상태 전환",
    text: "실행이 다음 단계로 넘어갔습니다.",
  },
  cleanup: {
    title: "샌드박스 정리",
    text: "더 필요 없는 샌드박스를 삭제했습니다.",
  },
};

/** Reason codes. The control plane stores only these fixed codes, never free text. */
export const REASON_LABELS: Readonly<Record<string, ReasonLabel>> = {
  empty_change: {
    title: "변경 없음",
    text: "에이전트가 파일을 바꾸지 않았습니다. 올릴 변경이 없어 실행을 끝냈습니다.",
    tone: "fail",
  },
  too_many_files: {
    title: "파일이 너무 많음",
    text: "에이전트가 바꾼 파일 수가 한도를 넘어 게시하지 않았습니다.",
    tone: "fail",
  },
  total_too_large: {
    title: "변경 전체가 너무 큼",
    text: "바뀐 내용의 전체 크기가 한도를 넘어 게시하지 않았습니다.",
    tone: "fail",
  },
  file_too_large: {
    title: "파일 하나가 너무 큼",
    text: "바뀐 파일 하나의 크기가 한도를 넘어 게시하지 않았습니다.",
    tone: "fail",
  },
  forbidden_path: {
    title: "허용되지 않은 경로",
    text: "허용되지 않은 위치의 파일을 바꾸려 해서 게시하지 않았습니다.",
    tone: "fail",
  },
  absolute_path: {
    title: "절대 경로",
    text: "변경 목록에 절대 경로가 있어 게시하지 않았습니다. 저장소 밖을 건드리는 시도일 수 있습니다.",
    tone: "fail",
  },
  path_traversal: {
    title: "상위 경로 접근",
    text: "변경 목록에 상위 폴더로 벗어나는 경로가 있어 게시하지 않았습니다.",
    tone: "fail",
  },
  symlink: {
    title: "심볼릭 링크",
    text: "심볼릭 링크를 만들거나 바꾸려 해서 게시하지 않았습니다.",
    tone: "fail",
  },
  submodule: {
    title: "서브모듈",
    text: "서브모듈을 건드리는 변경이라 게시하지 않았습니다.",
    tone: "fail",
  },
  special_file: {
    title: "특수 파일",
    text: "일반 파일이 아닌 특수 파일이 있어 게시하지 않았습니다.",
    tone: "fail",
  },
  path_not_utf8: {
    title: "경로 인코딩 오류",
    text: "파일 경로가 올바른 문자 인코딩이 아니어서 게시하지 않았습니다.",
    tone: "fail",
  },
  path_control_char: {
    title: "경로에 제어 문자",
    text: "파일 경로에 제어 문자가 있어 게시하지 않았습니다.",
    tone: "fail",
  },
  malformed_output: {
    title: "변경 보고 형식 오류",
    text: "샌드박스가 돌려준 변경 목록의 형식이 올바르지 않아 믿지 않고 버렸습니다.",
    tone: "fail",
  },
  timeout: {
    title: "시간 초과",
    text: "정해진 시간 안에 이 단계가 끝나지 않아 실행을 멈췄습니다.",
    tone: "fail",
  },
  agent_failed: {
    title: "에이전트 실패",
    text: "에이전트가 오류로 종료했습니다. 자동으로 다시 시도하지 않습니다.",
    tone: "fail",
  },
  agent_timeout: {
    title: "에이전트 시간 초과",
    text: "에이전트가 제한 시간 안에 끝나지 않아 강제로 멈췄습니다.",
    tone: "fail",
  },
  sandbox_lost: {
    title: "샌드박스를 잃음",
    text: "에이전트가 돌던 샌드박스가 사라지거나 응답하지 않아 결과를 얻지 못했습니다.",
    tone: "fail",
  },
  clone_failed: {
    title: "저장소 내려받기 실패",
    text: "샌드박스가 대상 저장소를 내려받지 못했습니다.",
    tone: "fail",
  },
  publish_failed: {
    title: "PR 게시 실패",
    text: "GitHub에 브랜치와 PR을 만드는 데 반복해서 실패했습니다.",
    tone: "fail",
  },
  internal_error: {
    title: "내부 오류",
    text: "제어 평면에서 예상하지 못한 오류가 반복되어 실행을 멈췄습니다.",
    tone: "attention",
  },
  cleanup_failed: {
    title: "샌드박스 정리 실패",
    text: "샌드박스를 삭제하지 못했습니다. 실행 결과와는 별개로, 운영자가 남은 샌드박스를 확인해야 할 수 있습니다.",
    tone: "attention",
  },
  legacy_run: {
    title: "리뷰 기능 이전의 실행",
    text: `리뷰 기능이 생기기 전에 열린 PR이거나 필요한 정보가 없는 실행입니다.`,
    tone: "attention",
  },
  pr_closed: {
    title: "PR이 닫힘",
    text: "PR이 병합되지 않은 채 닫혔습니다. 팩토리는 닫힌 PR을 다시 열지 않습니다.",
    tone: "info",
  },
  merged_outside_factory: {
    title: "사람이 직접 병합함",
    text: "팩토리가 판정을 끝내기 전에 사람이 PR을 직접 병합했습니다. 변경은 이미 반영되었으므로 남은 조치는 필요 없습니다.",
    tone: "ok",
  },
  base_not_default: {
    title: "기본 브랜치가 아닌 PR",
    text: `PR의 대상 브랜치가 저장소의 기본 브랜치가 아니어서 정책을 적용할 수 없습니다.`,
    tone: "attention",
  },
  head_changed: {
    title: "PR 내용이 바뀜",
    text: `팩토리가 만든 커밋이 아닌 다른 커밋이 PR 끝에 올라왔습니다. 리뷰한 내용과 다를 수 있어 병합하지 않았습니다.`,
    tone: "attention",
  },
  policy_missing: {
    title: "정책 파일 없음",
    text: `대상 저장소의 기본 브랜치에 위험 정책 파일(.factory/policy.yml)이 없어 리뷰를 시작하지 않았습니다.`,
    tone: "attention",
  },
  policy_invalid: {
    title: "정책 파일 형식 오류",
    text: `위험 정책 파일의 형식이 올바르지 않아 리뷰를 시작하지 않았습니다.`,
    tone: "attention",
  },
  files_truncated: {
    title: "파일 목록이 잘렸을 수 있음",
    text: `PR의 바뀐 파일 목록을 끝까지 확인하지 못해 위험 등급을 정할 수 없었습니다.`,
    tone: "attention",
  },
  diff_too_large: {
    title: "변경이 너무 커서 리뷰 불가",
    text: `변경 내용이 리뷰어에게 전부 보여 줄 수 있는 크기를 넘었습니다.`,
    tone: "attention",
  },
  review_failed: {
    title: "리뷰어 실패",
    text: `리뷰 에이전트가 오류로 종료했습니다.`,
    tone: "attention",
  },
  review_invalid: {
    title: "리뷰 결과가 유효하지 않음",
    text: `리뷰 에이전트가 정해진 형식의 결과를 내지 않아 승인으로 치지 않았습니다.`,
    tone: "attention",
  },
  changes_requested: {
    title: "리뷰어가 변경을 요청함",
    text: `다른 엔진의 리뷰어가 고쳐야 할 점을 지적했습니다. 자동 수정 반복은 없습니다.`,
    tone: "attention",
  },
  check_failed: {
    title: "필수 체크 실패",
    text: `정책이 요구하는 체크가 성공하지 못해 병합하지 않았습니다.`,
    tone: "attention",
  },
  checks_timeout: {
    title: "체크 시간 초과",
    text: `필수 체크가 30분 안에 끝나지 않거나 나타나지 않았습니다.`,
    tone: "attention",
  },
  checks_permission_missing: {
    title: "체크 읽기 권한 없음",
    text: `GitHub App에 체크 읽기 권한이 없어 체크 결과를 확인할 수 없었습니다.`,
    tone: "attention",
  },
  operator_changes_requested: {
    title: "운영자가 변경을 요청함",
    text: `운영자가 PR에서 변경을 요청해 병합하지 않았습니다.`,
    tone: "attention",
  },
  approval_timeout: {
    title: "승인 대기 시간 초과",
    text: `7일 안에 운영자의 승인이 없어 기다림을 끝냈습니다.`,
    tone: "attention",
  },
  merge_refused: {
    title: "GitHub가 병합을 거부함",
    text: `병합 요청을 GitHub가 허용하지 않았습니다(예: 브랜치 보호 규칙). 팩토리는 규칙을 우회하지 않습니다.`,
    tone: "attention",
  },
  merge_conflict: {
    title: "병합 충돌",
    text: `병합 시점에 PR 내용이 달라졌거나 충돌이 있어 병합하지 못했습니다.`,
    tone: "attention",
  },
  stopped_by_operator: {
    title: "운영자가 중지함",
    text: "운영자가 포털에서 이 실행을 중지했습니다. 샌드박스는 정리되었고 이후 자동 진행은 없습니다. PR이 이미 있다면 그대로 남아 있습니다.",
    tone: "info",
  },
  budget_exceeded: {
    title: "예산 한도 도달",
    text: "실행 하나의 지출 상한이나 계정의 월 예산에 도달해 제어 평면이 모델 호출을 막았고, 에이전트가 작업을 끝내지 못했습니다. 지출은 기록된 토큰 수와 고정 단가로 계산한 추정치입니다.",
    tone: "fail",
  },
  engine_wait_timeout: {
    title: "리뷰 엔진 대기 시간 초과",
    text: "예산이 남은 리뷰 엔진을 청구 주기 하나보다 오래 기다렸습니다. 이 정도로 오래 기다리는 것은 정상이 아니므로 사람에게 넘겼습니다.",
    tone: "attention",
  },
};

const STATE_TONE: Readonly<Record<string, Tone>> = {
  merged: "ok",
  needs_human: "attention",
  failed: "fail",
};

export interface Outcome {
  title: string;
  text: string;
  tone: Tone;
}

const FALLBACK: Label = {
  title: "알 수 없음",
  text: "이 포털이 알지 못하는 값입니다.",
};

/** The headline for a run: its reason when it has one, otherwise its state. */
export function describeOutcome(
  state: string,
  reasonCode: string | null,
): Outcome {
  const reason = reasonCode === null ? undefined : REASON_LABELS[reasonCode];
  if (reason !== undefined) {
    return { title: reason.title, text: reason.text, tone: reason.tone };
  }
  const label = STATE_LABELS[state] ?? FALLBACK;
  return { ...label, tone: STATE_TONE[state] ?? "wait" };
}

export const stateLabel = (state: string): Label =>
  STATE_LABELS[state] ?? FALLBACK;
export const reasonLabel = (code: string): ReasonLabel | undefined =>
  REASON_LABELS[code];

export interface NextStep {
  action: string;
  note?: string;
}

const MERGE_OR_CLOSE =
  "내용이 괜찮으면 PR을 직접 병합하고, 변경이 필요 없으면 PR과 이슈를 닫으세요.";

/** What a person does when a run has stopped with a pull request. */
const STOPPED_ACTIONS: Readonly<Record<string, string>> = {
  changes_requested: `PR의 리뷰 코멘트를 읽으세요. 지적이 맞으면 PR 브랜치를 고쳐서 직접 병합하고, 지적이 틀렸으면 그대로 직접 병합하세요. 변경이 필요 없으면 PR과 이슈를 닫으세요.`,
  operator_changes_requested: `PR에 남긴 변경 요청을 반영해 PR 브랜치를 고친 뒤 직접 병합하거나, PR과 이슈를 닫으세요.`,
  head_changed: `PR 끝에 올라온 커밋을 확인하세요. ${MERGE_OR_CLOSE}`,
  check_failed: `PR의 체크 기록에서 실패 원인을 확인하고 PR 브랜치를 고친 뒤 직접 병합하세요. 변경이 필요 없으면 PR과 이슈를 닫으세요.`,
  checks_timeout: `PR의 체크가 왜 끝나지 않았는지 확인하세요. 체크가 성공하면 PR을 직접 병합하고, 변경이 필요 없으면 PR과 이슈를 닫으세요.`,
  checks_permission_missing: `GitHub App 설정에서 Checks 읽기 권한을 켜세요. 이 권한은 다음 실행부터 적용됩니다. 이 PR은 체크 결과를 직접 확인한 뒤 병합하거나 닫으세요.`,
  policy_missing: `대상 저장소의 기본 브랜치에 .factory/policy.yml을 추가하세요. 이 파일은 다음 실행부터 적용됩니다. 이 PR은 직접 검토한 뒤 병합하거나 닫으세요.`,
  policy_invalid: `대상 저장소의 .factory/policy.yml 형식을 고치세요. 이 파일은 다음 실행부터 적용됩니다. 이 PR은 직접 검토한 뒤 병합하거나 닫으세요.`,
  base_not_default: `PR의 대상 브랜치가 의도한 브랜치인지 확인하세요. ${MERGE_OR_CLOSE}`,
  files_truncated: `바뀐 파일을 GitHub에서 직접 검토하세요. ${MERGE_OR_CLOSE} 변경이 너무 크면 이슈를 작게 나누세요.`,
  diff_too_large: `바뀐 파일을 GitHub에서 직접 검토하세요. ${MERGE_OR_CLOSE} 변경이 너무 크면 이슈를 작게 나누세요.`,
  review_failed: `자동 리뷰가 없으므로 PR을 직접 검토하세요. ${MERGE_OR_CLOSE}`,
  review_invalid: `자동 리뷰가 없으므로 PR을 직접 검토하세요. ${MERGE_OR_CLOSE}`,
  approval_timeout: `PR을 다시 검토하세요. ${MERGE_OR_CLOSE}`,
  merge_refused: `대상 저장소의 브랜치 보호 규칙을 확인하고, 규칙을 만족한 뒤 PR을 직접 병합하세요. 변경이 필요 없으면 PR과 이슈를 닫으세요.`,
  merge_conflict: `PR 브랜치의 충돌을 해결한 뒤 직접 병합하세요. 변경이 필요 없으면 PR과 이슈를 닫으세요.`,
  stopped_by_operator: `남아 있는 PR을 검토하세요. ${MERGE_OR_CLOSE}`,
  budget_exceeded: `자동 리뷰가 끝나지 않았으므로 PR을 직접 검토하세요. ${MERGE_OR_CLOSE}`,
  engine_wait_timeout: `예산 상태와 제어 평면 로그를 확인하세요. 자동 리뷰가 없으므로 PR을 직접 검토하세요. ${MERGE_OR_CLOSE}`,
  pr_closed: `남은 조치는 없습니다. 변경이 아직 필요하면 새 이슈를 만들어 factory:go 라벨을 붙이세요.`,
};

const STOPPED_ACTION_DEFAULT = `PR과 이 실행의 기록을 검토하세요. ${MERGE_OR_CLOSE}`;

const STOPPED_NOTE =
  "이 실행은 이미 끝났습니다. PR을 승인해도 팩토리는 병합하지 않고, 같은 이슈에 factory:go 라벨을 다시 붙여도 새 실행이 시작되지 않습니다. 팩토리에 다시 맡기려면 새 이슈를 만들어 라벨을 붙이세요. PR이 이미 병합되었거나 닫혔다면 더 할 일이 없습니다.";

/** What to change before a run that ended without a pull request starts again. */
const BEFORE_RETRY: Readonly<Record<string, string>> = {
  empty_change: "이슈에 바꿀 내용을 더 구체적으로 적으세요.",
  too_many_files: "이슈의 범위를 줄이세요.",
  total_too_large: "이슈의 범위를 줄이세요.",
  file_too_large: "이슈의 범위를 줄이세요.",
  budget_exceeded:
    "이슈의 범위를 줄이거나, 포털 상단의 예산 안내를 보고 다음 청구 주기를 기다리세요.",
};

const UNSAFE_CHANGE_REASONS: ReadonlySet<string> = new Set([
  "forbidden_path",
  "absolute_path",
  "path_traversal",
  "symlink",
  "submodule",
  "special_file",
  "path_not_utf8",
  "path_control_char",
  "malformed_output",
]);

const UNSAFE_CHECK =
  "이슈 내용을 읽고 에이전트에게 위험한 지시를 하지 않았는지 확인하세요. 위험한 지시가 있으면 다시 실행하지 마세요.";

const ownValue = (
  table: Readonly<Record<string, string>>,
  key: string | null,
): string | undefined =>
  key !== null && Object.hasOwn(table, key) ? table[key] : undefined;

/**
 * The action a run's page asks of an operator, or null when nothing is left to do.
 * The control plane refuses a new run for an issue whose run is `needs_human`
 * and accepts one after `failed`, so the two states give different advice.
 */
export function describeNextStep(
  state: string,
  reasonCode: string | null,
): NextStep | null {
  if (state === "needs_human") {
    if (reasonCode === "merged_outside_factory") return null;
    if (reasonCode === "pr_closed") {
      return { action: STOPPED_ACTIONS["pr_closed"]! };
    }
    return {
      action: ownValue(STOPPED_ACTIONS, reasonCode) ?? STOPPED_ACTION_DEFAULT,
      note: STOPPED_NOTE,
    };
  }
  if (state === "failed") {
    const first =
      reasonCode !== null && UNSAFE_CHANGE_REASONS.has(reasonCode)
        ? UNSAFE_CHECK
        : ownValue(BEFORE_RETRY, reasonCode);
    const retry =
      first === undefined
        ? "변경이 아직 필요하면 이슈에서 factory:go 라벨을 뗐다가 다시 붙이세요."
        : `${first} 그다음 이슈에서 factory:go 라벨을 뗐다가 다시 붙이세요.`;
    return {
      action: retry,
      note: "라벨을 다시 붙이면 새 실행이 시작됩니다. 운영자가 붙인 라벨만 실행을 시작합니다.",
    };
  }
  return null;
}
