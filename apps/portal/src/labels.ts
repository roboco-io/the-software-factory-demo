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

const NEED_PERSON = "사람이 PR과 이 실행의 기록을 보고 이어서 처리해야 합니다.";

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
    text: `리뷰 기능이 생기기 전에 열린 PR이거나 필요한 정보가 없는 실행입니다. ${NEED_PERSON}`,
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
    text: `PR의 대상 브랜치가 저장소의 기본 브랜치가 아니어서 정책을 적용할 수 없습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  head_changed: {
    title: "PR 내용이 바뀜",
    text: `팩토리가 만든 커밋이 아닌 다른 커밋이 PR 끝에 올라왔습니다. 리뷰한 내용과 다를 수 있어 병합하지 않았습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  policy_missing: {
    title: "정책 파일 없음",
    text: `대상 저장소의 기본 브랜치에 위험 정책 파일(.factory/policy.yml)이 없어 리뷰를 시작하지 않았습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  policy_invalid: {
    title: "정책 파일 형식 오류",
    text: `위험 정책 파일의 형식이 올바르지 않아 리뷰를 시작하지 않았습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  files_truncated: {
    title: "파일 목록이 잘렸을 수 있음",
    text: `PR의 바뀐 파일 목록을 끝까지 확인하지 못해 위험 등급을 정할 수 없었습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  diff_too_large: {
    title: "변경이 너무 커서 리뷰 불가",
    text: `변경 내용이 리뷰어에게 전부 보여 줄 수 있는 크기를 넘었습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  review_failed: {
    title: "리뷰어 실패",
    text: `리뷰 에이전트가 오류로 종료했습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  review_invalid: {
    title: "리뷰 결과가 유효하지 않음",
    text: `리뷰 에이전트가 정해진 형식의 결과를 내지 않아 승인으로 치지 않았습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  changes_requested: {
    title: "리뷰어가 변경을 요청함",
    text: `다른 엔진의 리뷰어가 고쳐야 할 점을 지적했습니다. 자동 수정 반복은 없습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  check_failed: {
    title: "필수 체크 실패",
    text: `정책이 요구하는 체크가 성공하지 못해 병합하지 않았습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  checks_timeout: {
    title: "체크 시간 초과",
    text: `필수 체크가 30분 안에 끝나지 않거나 나타나지 않았습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  checks_permission_missing: {
    title: "체크 읽기 권한 없음",
    text: `GitHub App에 체크 읽기 권한이 없어 체크 결과를 확인할 수 없었습니다. 운영자가 App 권한을 바꾸고 승인해야 합니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  operator_changes_requested: {
    title: "운영자가 변경을 요청함",
    text: `운영자가 PR에서 변경을 요청해 병합하지 않았습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  approval_timeout: {
    title: "승인 대기 시간 초과",
    text: `7일 안에 운영자의 승인이 없어 기다림을 끝냈습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  merge_refused: {
    title: "GitHub가 병합을 거부함",
    text: `병합 요청을 GitHub가 허용하지 않았습니다(예: 브랜치 보호 규칙). 팩토리는 규칙을 우회하지 않습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  merge_conflict: {
    title: "병합 충돌",
    text: `병합 시점에 PR 내용이 달라졌거나 충돌이 있어 병합하지 못했습니다. ${NEED_PERSON}`,
    tone: "attention",
  },
  stopped_by_operator: {
    title: "운영자가 중지함",
    text: "운영자가 포털에서 이 실행을 중지했습니다. 샌드박스는 정리되었고 이후 자동 진행은 없습니다. PR이 이미 있다면 그대로 남아 있습니다.",
    tone: "info",
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
