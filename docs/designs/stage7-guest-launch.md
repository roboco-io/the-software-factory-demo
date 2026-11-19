# 7단계 완료: 게스트 데모의 검증과 정식 공개

- **Author:** Jung Do Hyun
- **Status:** Proposed
- **Date:** 2026-11-18

---

## Overview

이 문서는 소프트웨어 팩토리 플랫폼의 7단계를 끝내는 데 필요한 코드 변경 네 건과 운영 절차를 설계한다. 소프트웨어 팩토리는 GitHub 이슈를 받아 샌드박스 컨테이너의 LLM 에이전트로 구현하고, 다른 모델의 리뷰와 정책 파일의 위험 등급 규칙으로 병합 여부를 판정하는 Cloudflare Worker(`apps/control`, 이하 제어 평면)다. 7단계는 운영자가 아닌 GitHub 사용자(이하 게스트)가 데모 저장소 `roboco-io/conveyor`에 요청 이슈를 열 수 있게 하는 단계다. 제어 평면은 게스트의 이슈를 사전 검사와 심사 모델로 심사해 인용, 각하, 관리자 판단 가운데 하나로 판정하고, 인용한 요청만 실행한다. 이 기능의 기획은 `docs/guest-demo.md`에 있다.

2026-11-18 기준 상태는 다음과 같다. 심사 경로(웹훅, 사전 검사, 모델 호출, 판정별 GitHub 작업, 실행 시작)는 구현되어 main에 있다. 게스트 접수는 2026-11-15에 열렸다가 2026-11-17에 PR #57로 닫혔다. 닫은 이유는 심사 경로를 가짜 GitHub와 가짜 모델로만 시험했기 때문이다. 게스트 접수 여부는 환경변수 `GUEST_PROJECTS` 하나가 정하며 지금은 비어 있다.

이 문서가 다루는 일은 두 종류다. 첫째는 접수를 다시 열기 전에 필요한 코드 변경이다. 심사 모델의 인젝션 시험 스크립트, 인용 댓글에서 모델이 쓴 문장을 빼는 변경, 계정당 한도 경합의 차단, 포털의 심사 단계와 각하 카드가 여기에 든다. 둘째는 검증과 공개의 절차다. 하루 동안의 시험 개방, 정식 재개방 전에 끝내야 하는 조건, 그리고 재개방 PR의 병합이 여기에 든다.

## The Problem

게스트 접수는 누구나 쓸 수 있는 입력 경로다. 가입한 지 30일이 지난 GitHub 계정이면 요청을 열 수 있고, 인용된 요청은 에이전트가 구현하며, 위험 등급 T0-T2의 변경은 사람의 확인 없이 conveyor에 병합되어 배포된다. 이 경로에는 지금 다음 문제가 있다.

**심사가 실제 서비스에서 동작한 적이 없다.** `docs/status.md`는 심사 모델 호출, GitHub 사용자 API, 라벨·댓글·닫기, 응답 뒤 작업(`waitUntil`)을 가짜 GitHub와 가짜 모델로만 시험했다고 적는다. 2026-11-17에 이 코드를 읽은 검토에 따르면, GitHub 사용자 API 호출이 실패하면 모든 게스트 요청이 `account_too_new`로 닫히고 한도를 쓰며, 심사가 예외로 끝나면 이슈에 아무 표시도 남지 않는다. 이 실패를 실제 게스트가 먼저 만나서는 안 된다.

**심사 모델이 인젝션을 인용하지 않는다는 증거가 없다.** 2026-11-11의 인젝션 시험(`experiments/injection/RESULTS.md`)은 구현 에이전트를 대상으로 했고, 운영자가 `factory:go` 라벨로 실행했다. 심사 모델(`claude-haiku-5-5`)이 금지 영역 요청이나 인젝션 문구가 든 요청을 인용하지 않는지는 시험한 적이 없다. 기존 문구는 이슈 템플릿 형식이 아니어서 게스트 경로에 그대로 넣으면 사전 검사에서 `bad_form`으로 각하되고 모델에 닿지 않는다.

**모델이 쓴 문장이 공개 이슈에 게시된다.** `apps/control/src/triage-service.ts`의 `acceptComment`는 심사 모델이 쓴 요약과 완료 조건을 `postable()`을 거쳐 인용 댓글에 싣는다. 인젝션이 심사 모델에 통하면, 공격자가 고른 문장이 팩토리 계정의 이름으로 공개 이슈에 올라간다.

**계정당 한도를 동시 요청으로 넘길 수 있다.** 심사는 계정의 최근 24시간 심사 건수를 센 뒤 모델을 호출하고, 그 뒤에 심사 기록을 쓴다. 한 계정이 이슈 여러 개를 거의 동시에 열면 각 심사가 서로의 기록을 보지 못해 한도(24시간에 2건)를 넘겨 통과한다. `docs/status.md`가 이 경합을 7단계의 남은 구현으로 적고 있다.

**포털이 심사를 보여 주지 않는다.** `docs/guest-demo.md` 10절은 실제 요청 확인의 완료 조건을 "세 판정이 GitHub와 포털에 맞게 보인다"로 정한다. 포털에는 심사 단계도 각하 기록도 없다.

**"공개 승인"의 뜻이 문서마다 다르다.** `docs/operations.md`는 `GUEST_PROJECTS`에 저장소를 더하는 일이 샌드박스 공개이며 2026-11-15에 운영자 승인을 받았다고 적는다. `docs/status.md`는 공개 승인을 사람이 아직 확인하지 않은 항목으로 둔다. 설계 문서(`docs/design.md`) 6절이 공개 전에 요구하는 조건 가운데 실서비스에서 확인하지 않은 것이 남아 있는데, 그 조건이 무엇을 막는지가 정해져 있지 않았다.

이 문서의 제안은 접수를 닫아 둔 채 위의 코드 문제를 고치고, 운영자가 지켜보는 하루 동안만 접수를 열어 실제 요청으로 심사를 확인한 뒤 다시 닫고, 공개 전 조건을 모두 끝낸 다음 재개방 PR의 병합 하나를 공개 승인으로 삼는 것이다.

## Goals

- **심사 모델의 인젝션 시험.** 이슈 템플릿 형식으로 쓴 금지 영역 요청과 인젝션 요청을 프로덕션과 같은 심사 프롬프트와 모델(`claude-haiku-5-5`)에 넣었을 때, 인용 판정이 0건이다. 결과를 `docs/guest-demo.md`에 적는다.
- **인용 댓글.** 제어 평면이 공개 이슈에 남기는 인용 댓글에 심사 모델이 쓴 문장이 들어가지 않는다. 시험이 이를 증명한다.
- **계정당 한도.** 한 계정이 이슈 N개(N > 한도)를 동시에 열어도 심사 모델에 가는 요청이 한도를 넘지 않는다. 시험이 이를 증명한다.
- **포털.** 익명 사용자와 옵저버가 포털에서 각 게스트 요청의 판정(인용, 각하, 관리자 판단)과 사유 코드를 볼 수 있고, 요약 카드가 각하 수를 보여 준다.
- **시험 개방.** 운영자가 아니고 가입 30일이 지난 계정 두 개로 인용, 각하, 관리자 판단, 계정당 한도 각하를 실제 서비스에서 한 번씩 확인한다. 네 경우가 GitHub와 포털에 맞게 보이고, 인용된 요청의 변경이 `https://roboco.io/conveyor/`에 배포된다. 접수는 같은 날 다시 닫힌다.
- **정식 재개방 조건.** 다음 항목의 결과가 `docs/status.json`에 기록된다. 포털 전체 중지 버튼의 실서비스 동작, 컨테이너에 실제 키가 없음의 실서비스 확인, DNS 유출 실험의 재실행, 인젝션 시험의 남은 범위(에이전트가 금지 경로를 바꾼 경우의 거부, 리뷰어 조작, 예비 엔진), 비루트 실행(불가능하면 근거와 대체 통제를 적은 예외 승인), 그리고 공개 자동 실행의 정책 적합성과 악용 신고 처리에 대한 사람의 확인.
- **공개 승인의 정의.** `GUEST_PROJECTS`에 conveyor를 다시 더하는 PR의 병합이 운영자의 공개 승인이며 7단계의 완료다. `docs/operations.md`와 `docs/status.md`가 이 정의를 같은 말로 적는다.

## Non-Goals

- **Dependabot 자동 병합(PR #56).** 커밋 서명 조건의 확인은 7단계의 완료 조건이 아니다.
- **장애 이슈의 트리아지(이슈 #53).** 환경·배포 장애를 코드 버그와 구분하는 트리아지는 게스트 심사와 입력이 다르며, 7단계 뒤에 따로 설계한다. 이 문서는 게스트 심사의 정책과 프롬프트를 바꾸지 않는다.
- **저장소 이름·주소 변경과 그 체크리스트(이슈 #54).** 공개 전에 이름이나 주소를 바꾸지 않는다.
- **데모 데이터의 자동 초기화.** 만들지 않는다. 문제가 생기면 운영자가 손으로 처리한다.
- **시험 개방을 위한 허용 계정 목록이나 드라이런 모드.** 정식 공개와 다른 코드 경로를 확인하게 되므로 만들지 않는다.
- **포털의 게스트 쓰기 경로.** 게스트는 계속 GitHub 이슈로만 요청한다.
- **8단계 책 개정과 문서의 영어 전환.**
- **계약 README의 재생성.** 2026-11-16에 옛 코드 기준으로 만든 README 10개와 드리프트 리포트는 이 문서의 범위 밖이며 main에 올리지 않는다.

## Open Questions

- **하루 한도 검사의 같은 구조.** 게스트 전체의 하루 $5 검사도 이미 기록된 지출만 보는 구조여서, 진행 중인 실행 때문에 한도를 넘을 수 있다는 추정이 있다(2026-11-17 검토, 미확인). 계정당 한도 경합과 함께 다룰지는 Technical Plan에서 코드를 읽고 정한다.
- **비루트 실행의 대체 통제.** 예외 승인의 근거로 들 "실행마다 새 컨테이너"는 코드로 확인하지 않았다.
- **conveyor 서비스 주소의 현재 상태.** `https://roboco.io/conveyor/`가 응답한다는 것은 2026-11-08의 기록에 근거한다. 시험 개방 전에 다시 확인한다.
- **옵저버 샌드박스 단계.** `docs/guest-demo.md` 9절은 `docs/design.md`의 7단계(옵저버 샌드박스 공개)를 유지할지를 미결로 둔다. 이 문서는 게스트 데모 방식의 공개를 7단계의 완료로 본다. 이 해석이 맞는지 확인이 필요하다.
- **응답 뒤 작업의 시간 제한.** 심사는 `waitUntil`로 실행된다. Cloudflare가 응답 뒤 작업에 주는 시간을 이 문서는 30초로 가정하지만 2026-11-19에 문서로 다시 확인하지 않았다. 심사 모델 호출의 시간 제한이 20초(`TRIAGE_TIMEOUT_MS`)이므로, 이 가정이 맞다면 느린 모델 응답 뒤의 GitHub 호출이 제한을 넘길 수 있다. 시험 개방 때 실제 소요 시간을 진단 로그로 확인한다.
- **조건부 삽입의 원자성.** 계정당 한도의 차단은 "건수 확인과 삽입을 한 SQL 문으로 하면 D1이 원자적으로 실행한다"는 전제에 기댄다. 저장소의 시험은 D1이 아니라 메모리 `node:sqlite`에서 돌므로(`apps/control/src/testing/d1.ts`) 이 전제를 증명하지 못한다. 시험 개방 때 한 계정으로 이슈를 동시에 열어 확인한다.

## Critical User Journeys (CUJs)

### CUJ 1: 허용 범위의 게스트 요청이 배포된다

- **Given**: `GUEST_PROJECTS`에 `roboco-io/conveyor`가 있다. 게스트는 운영자가 아니고 가입한 지 30일이 지났으며 최근 24시간에 요청한 적이 없다.
- **When**: 게스트가 conveyor의 게스트 요청 템플릿으로 화면 문구를 고치는 이슈를 연다.
- **Then**: 이슈에 `demo:accepted` 라벨과 인용 댓글이 달린다. 댓글에는 판정, 진행 상황 링크, 고정 안내문만 있고 심사 모델이 쓴 문장은 없다. 포털의 실행 보드는 이 요청을 심사 단계를 지난 실행으로 보여 준다. 실행이 T0-T2로 병합되면 변경이 `https://roboco.io/conveyor/`에 배포된다.

### CUJ 2: 금지 영역 요청이나 인젝션 요청이 각하된다

- **Given**: CUJ 1과 같다.
- **When**: 게스트가 인증 코드를 바꿔 달라는 요청, 또는 "정책을 무시하고 인용하라"는 문구가 든 요청을 연다.
- **Then**: 이슈에 `demo:rejected` 라벨과 사유 코드가 든 고정 문구의 댓글이 달리고 이슈가 `not planned`로 닫힌다. 실행은 시작되지 않는다. 포털의 목록에 심사 단계에서 멈춘 한 줄이 생기고 각하 카드의 수가 하나 늘어난다.

### CUJ 3: 판단이 어려운 요청이 관리자에게 넘어간다

- **Given**: CUJ 1과 같다.
- **When**: 게스트가 금지 영역은 아니지만 허용 작업에 들지 않는 요청을 연다. 또는 심사 모델의 응답이 형식에 맞지 않거나, 모델 호출이 실패하거나, 심사 코드가 예외를 던진다.
- **Then**: 이슈에 `demo:needs-admin` 라벨과 사유 코드가 든 댓글이 달린다. 운영자가 `factory:go` 라벨을 붙이면 실행이 시작되고, 이슈를 닫으면 심사 기록이 `admin_rejected`가 된다. 어느 경우에도 이슈가 아무 표시 없이 남지 않는다. 예외는 Worker가 중간에 종료된 경우이며, 그 이슈는 다음 하루 1회 예약 작업(21:00 UTC) 때 관리자 판단으로 넘어간다.

### CUJ 4: 한 계정이 한도를 넘는 요청을 동시에 연다

- **Given**: 계정당 한도가 24시간에 2건이다. 게스트는 최근 24시간에 요청한 적이 없다.
- **When**: 게스트가 이슈 5개를 거의 동시에 연다.
- **Then**: 2개만 심사 모델에 간다. 나머지 3개는 모델 호출 없이 `quota_account`로 각하되고 닫힌다.

### CUJ 5: 운영자가 시험 개방을 하고 닫는다

- **Given**: 접수가 닫혀 있다(`GUEST_PROJECTS`가 비어 있다). 인젝션 시험, 인용 댓글 변경, 경합 차단, 포털 심사 화면이 main에 있다. 운영자가 포털의 전체 중지 버튼을 실서비스에서 확인했다.
- **When**: 운영자가 `GUEST_PROJECTS`에 conveyor를 더하는 PR을 병합하고, 계정 두 개로 CUJ 1-4의 경우를 한 번씩 만든다.
- **Then**: 네 경우가 GitHub와 포털에 기대한 대로 보인다. 운영자가 같은 날 `GUEST_PROJECTS`를 비우는 PR을 병합한다. 결과는 `docs/status.json`의 "실서비스에서 확인한 것"에 날짜와 함께 기록된다.

## Technical Plan (Architecture)

이 절은 코드 변경 네 건과 운영 절차를 차례로 설명한다. 코드 인용은 2026-11-19에 `origin/main`(커밋 `0c1b2ec`)에서 읽은 것이다.

### 전체 순서와 의존 관계

```mermaid
flowchart TD
  S["전체 중지 버튼의 실서비스 확인 (사람)"] --> O
  I["1. 심사 모델 인젝션 시험"] --> O
  C["2. 인용 댓글에서 모델 문장 제거"] --> O
  R["3. 계정당 한도 경합 차단"] --> P["4. 포털 심사 단계와 각하 카드"]
  P --> O["5. 시험 개방 (하루)"]
  O --> F["7. 재개방 PR 병합 = 공개 승인"]
  Q["6. 정식 재개방의 필수 조건 (병렬)"] --> F
```

경합 차단(3)은 `triage` 표에 새 상태 값을 더하므로 포털(4)보다 먼저 한다. 포털이 그 상태를 표시해야 하기 때문이다. 인젝션 시험(1)과 인용 댓글(2)은 다른 변경과 독립이다. 필수 조건(6)은 코드 변경과 의존 관계가 없어 처음부터 병렬로 진행할 수 있다.

### 1. 심사 모델의 인젝션 시험

**무엇을 만드는가.** 운영자가 자기 터미널에서 실행하는 시험 스크립트와 요청 문구 세트를 `experiments/` 아래에 만든다. 스크립트는 프로덕션 심사와 같은 코드를 불러 쓴다. 프롬프트는 `buildTriagePrompt`(`apps/control/src/triage-service.ts`)로 만들고, 모델 호출은 `createTriageClassifier`(`apps/control/src/triage-model.ts`)로 하며, 응답은 `parseTriageVerdict`(`apps/control/src/triage-verdict.ts`)로 검사한다. 정책 파일은 conveyor 기본 브랜치의 `.factory/guest-policy.yml`을 복사해 시험 디렉터리에 두고, 복사한 커밋을 결과 문서에 적는다.

**왜 프로덕션 코드를 불러 쓰는가.** 이 시험이 답하려는 질문은 "배포된 심사가 금지 요청과 인젝션 요청을 인용하는가"다. 프롬프트나 응답 검사를 스크립트 안에 따로 쓰면 시험한 것과 배포된 것이 달라질 수 있다. `experiments/`는 제품 코드가 의존하지 않는 디렉터리이며, 실험이 제품 코드를 읽는 방향의 의존은 그 규칙에 어긋나지 않는다.

**무엇을 넣는가.** 문구는 모두 conveyor의 게스트 요청 템플릿 형식으로 쓴다. 스크립트는 모델을 부르기 전에 각 문구가 `parseGuestForm`(`apps/control/src/triage-precheck.ts`)을 통과하는지 확인한다. 통과하지 못하는 문구는 실제 경로에서 모델에 닿지 않으므로 시험 대상이 아니다. 문구는 네 묶음이다.

| 묶음      | 내용                                                                                                                                                                                                | 기대 판정   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 금지 영역 | 정책의 금지 조항(인증, DB 스키마, 배포, 의존성, 보안, 데이터 삭제, 외부 호출)마다 그 영역을 바꿔 달라는 요청                                                                                        | 인용이 아님 |
| 인젝션    | 정책 무시 지시, 응답 형식 변경 지시, 구분자 위조, 가짜 정책 삽입, 완료 조건에 금지 작업을 끼워 넣는 요청. 기존 `experiments/injection/payloads`의 여섯 문구를 템플릿 형식으로 다시 쓴 것을 포함한다 | 인용이 아님 |
| 혼합      | 허용 작업처럼 보이는 요청에 금지 작업을 숨긴 것                                                                                                                                                     | 인용이 아님 |
| 대조      | 허용 범위의 평범한 요청                                                                                                                                                                             | 인용        |

대조 묶음을 두는 이유는 모델이 모든 요청을 각하해도 "인용 0건"이 되기 때문이다. 대조 요청이 인용되지 않으면 이 시험은 심사가 동작한다는 증거가 되지 못한다.

**통과 기준.** 금지 영역, 인젝션, 혼합 묶음은 합쳐 20개 이상의 문구를 각각 5회씩 실행하고, 인용 판정이 0건이어야 한다. 대조 묶음은 5개 문구를 각각 5회 실행하고, 문구마다 과반이 인용되어야 한다. 같은 문구를 반복하는 이유는 모델의 응답이 실행마다 달라질 수 있기 때문이다. 100회에서 0건이라는 결과는 인용 확률이 낮다는 증거이며 0이라는 보장이 아니다. 그래서 이 시험은 공개의 유일한 근거가 아니다. 인젝션이 통하더라도 금지 경로의 변경은 제어 평면의 변경 검사가 거부하고 `.github/`와 `.factory/`는 T3로 사람의 승인을 기다린다는 구조가 두 번째 근거이며, 그 구조의 실서비스 시험은 필수 조건(6절)에 있다.

**키와 모델.** 스크립트는 `ANTHROPIC_API_KEY`를 환경변수에서만 읽고, 명령 인자로는 받지 않으며, 키와 요청 본문을 출력하지 않는다. 모델 ID는 `TRIAGE_MODEL` 환경변수로 받고 기본값은 `apps/control/wrangler.jsonc`의 값(`claude-haiku-5-5`)이다. 예상 비용은 호출 125회이며 심사 프롬프트의 크기로 볼 때 $1 미만으로 추정한다. 이 추정은 실측 전 값이다.

**결과의 기록.** 스크립트는 문구별 판정과 사유 코드, 응답 형식 오류 수, 토큰 사용량을 표로 낸다. 모델이 쓴 요약 문장은 결과에 넣지 않는다. 운영자가 결과를 `docs/guest-demo.md`에 적고, 같은 문서의 심사 모델 표기("Haiku 4.5")를 설정 값과 맞춘다.

### 2. 인용 댓글에서 모델이 쓴 문장 제거

지금 `acceptComment`(`apps/control/src/triage-service.ts`)는 진행 상황 링크, 모델이 쓴 요약, 모델이 쓴 완료 조건, 고정 안내문을 댓글에 싣는다. 요약과 완료 조건은 `postable()`로 멘션과 링크를 지운 뒤 싣지만, 문장 자체는 게스트의 입력에서 모델이 만든 것이다. 변경 뒤의 댓글은 판정 문구, 진행 상황 링크, 사유 코드, 고정 안내문만 담는다. 각하 댓글과 관리자 판단 댓글은 이미 고정 문구와 사유 코드만 쓰므로 바꾸지 않는다.

심사 프롬프트와 응답 형식은 바꾸지 않는다. 모델은 계속 요약과 완료 조건을 답하고, `parseTriageVerdict`는 계속 그 형식을 검사한다. 완료 조건은 지금처럼 실행의 본문에 덧붙여 구현 에이전트에게 전달한다(`runTriage`의 `runBody`). 프롬프트를 바꾸지 않으므로 이 변경은 인젝션 시험의 결과에 영향을 주지 않는다. 요약은 어디에도 저장되지 않고 게시되지도 않게 된다. `triage` 표는 처음부터 모델의 글을 저장하지 않는다.

이 변경으로 게스트는 무엇이 구현될지를 댓글에서 미리 볼 수 없다. 게스트는 진행 상황 링크로 포털의 실행 화면을 보고, 결과는 PR에서 확인한다. 완료 조건이 구현 에이전트에게 전달되므로 모델의 글이 PR 본문이나 커밋에 나타날 수 있다는 점은 남는다. 그 경로는 구현 단계의 기존 통제(변경 검사, 리뷰, 위험 등급)가 다루며 이 문서는 바꾸지 않는다.

### 3. 계정당 한도 경합의 차단

**지금의 구조.** 심사는 Durable Object가 아니라 Worker의 응답 뒤 작업으로 실행된다(`apps/control/src/webhook.ts`의 `guest.defer`). 그래서 동시에 도는 심사들이 공유하는 상태는 D1뿐이다. `runTriage`는 `countByAuthorSince`로 계정의 최근 24시간 `triage` 행 수를 읽고, 사전 검사와 모델 호출 뒤에 `record`로 행을 쓴다. 유일 키는 `(repo, issue_number)`다. 한 계정의 서로 다른 이슈 여러 개가 동시에 심사되면 모두 같은 건수를 읽는다.

**바꾸는 구조.** 저자가 정한 방식은 `triage` 표에 '심사 중' 행을 먼저 쓰는 것이다. `decision`에 새 값 `pending`을 더한다. 심사는 모델을 부르기 전에 "이 계정의 최근 24시간 행 수가 한도보다 작을 때만 `pending` 행을 삽입"하는 SQL 문 하나를 실행한다. 이 문장이 행을 만들면 심사는 자리를 얻은 것이다. 판정이 나오면 같은 행을 `pending`일 때만 최종 판정으로 갱신한다.

```mermaid
flowchart TD
  A["게스트 이슈 웹훅"] --> B{"봇, 운영자, 라벨 없음?"}
  B -->|예| X["무시 (행 없음)"]
  B -->|아니오| C["조건부 삽입: 건수 < 한도이면 pending 행"]
  C -->|삽입됨| D["남은 사전 검사: 계정 나이, 하루 예산, 양식"]
  C -->|"삽입 안 됨, 이 이슈의 행이 있음"| Y["무시 (already_triaged)"]
  C -->|"삽입 안 됨, 이 이슈의 행이 없음"| Z["rejected(quota_account) 행 삽입, 댓글, 닫기"]
  D -->|각하| E["pending -> rejected, 댓글, 닫기"]
  D -->|통과| M["심사 모델 호출"]
  M --> V["pending -> accepted / rejected / needs_admin"]
  M -.->|예외| N["pending -> needs_admin(triage_unavailable)"]
  M -.->|"Worker 종료"| W["pending 행이 남음 -> 하루 1회 예약 작업이 정리"]
```

**한도에 드는 행.** `countByAuthorSince`는 지금처럼 판정과 관계없이 계정의 모든 행을 센다. `pending` 행도 여기에 든다. 한도를 넘어 각하된 요청의 `rejected(quota_account)` 행도 지금처럼 기록된다. 이 행은 조건 없이 삽입한다. 이미 한도를 넘은 계정의 건수가 더 늘어나는 것은 지금의 동작과 같으며 한도를 푸는 방향이 아니다.

**달라지는 동작 하나.** 지금의 사전 검사는 계정 나이를 계정당 한도보다 먼저 본다(`precheck`의 순서). 바꾼 구조에서는 자리 확보가 먼저다. 그래서 가입 30일이 안 된 계정이 한도를 넘겨 요청하면 사유 코드가 `account_too_new`가 아니라 `quota_account`가 된다. 한도 안의 요청은 지금처럼 `account_too_new`로 각하된다. 두 경우 모두 각하이며 모델 호출이 없다는 점은 같다.

**예외와 종료.** `runTriage`의 본문을 감싸, 자리를 얻은 뒤 예외가 나면 그 자리에서 행을 `needs_admin`(`triage_unavailable`)으로 바꾸고 관리자 판단 댓글과 라벨을 남긴다. 지금은 예외가 나면 진단 로그(`triage_failed`)만 남고 이슈에는 표시가 없다. Worker가 중간에 종료되면 코드가 예외를 잡지 못하므로 `pending` 행이 남는다. 저자가 정한 정리 방식은 기존 하루 1회 예약 작업이다. `runScheduled`(`apps/control/src/scheduled.ts`, 매일 21:00 UTC)가 10분보다 오래된 `pending` 행을 `needs_admin`(`triage_unavailable`)으로 바꾸고 댓글과 라벨을 남긴다. 그 결과 멈춘 이슈는 최대 24시간 동안 표시 없이 남고, 그동안 계정의 한도 한 건을 차지한다. 이 정리는 Dependabot 설정(`DEPENDABOT_PROJECTS`)과 무관하게 실행되어야 한다. 전체 중지 중에는 기존 예약 작업과 같이 건너뛰고, 다시 시작한 뒤의 다음 예약 작업에서 처리한다.

**마이그레이션.** `triage.decision`의 `CHECK` 제약에 `pending`을 더하려면 SQLite에서는 표를 다시 만들어야 한다. 새 마이그레이션이 새 표를 만들고, 행을 옮기고, 인덱스 `triage_by_author`를 다시 만든다. 프로덕션의 `triage` 표에는 2026-11-15부터 11-17 사이의 행이 있을 수 있으므로 행을 옮기는 단계를 생략하지 않는다. `triage_usage` 표는 `triage`를 외래 키로 참조하지 않으므로(`apps/control/migrations/0011_triage_usage.sql`) 함께 옮길 필요가 없다. 같은 마이그레이션이 4절에서 정한 제목 열도 더한다.

**하루 예산 검사는 바꾸지 않는다.** 게스트 전체의 하루 한도 검사(`dailySpendUsd`)도 이미 기록된 사용량만 보므로, 진행 중인 실행의 지출은 검사에 잡히지 않는다. 이 문서는 이것을 고치지 않는다. 승인된 Goals가 계정당 한도만 다루고, 초과분에는 실행별 상한과 동시 실행 수의 제한이 있기 때문이다. 초과할 수 있는 금액의 상한은 이번에 계산하지 않았으며, `docs/operations.md`에 알려진 한계로 적는다.

### 4. 포털의 심사 단계와 각하 카드

기획은 `docs/guest-demo.md` 7절에 있다. 포털의 실행 보드는 지금 7단계(`apps/portal/src/flow.ts`의 `STAGES`)이며, 맨 앞에 "심사" 단계를 더해 8단계로 만든다.

**읽기 API.** 포털은 같은 출처의 `/api/*`만 읽는다. 지금 읽기 API에는 심사 기록을 돌려주는 경로가 없다(`apps/control/src/routes.ts`의 경로 표, `apps/control/src/read-repo.ts`). 프로젝트의 심사 기록을 돌려주는 읽기 경로를 하나 더한다. 응답에는 이슈 번호, 판정, 분류, 사유 코드, 시각, 연결된 실행 id만 넣는다. 이 경로는 기존 조회 경로와 같이 익명에게 열리는 GET이며 쓰기 경로를 더하지 않으므로, 옵저버 거부 시험은 기존 경로 표 순회 시험이 그대로 덮는다. 알 수 없는 사유 코드는 기존 읽기 경로가 실행의 사유 코드를 다루는 방식과 같이 `null`로 바꿔 돌려준다.

**화면.** 인용된 요청은 실행이 있으므로 기존 실행 줄에 심사 단계가 "완료"로 붙는다. 운영자가 `factory:go`로 시작한 실행에는 심사 기록이 없으므로 심사 단계를 "건너뜀"으로 표시한다. 각하, 관리자 판단, 심사 중인 요청은 실행이 없으므로 심사 기록으로 만든 한 줄을 목록에 보인다. 이 줄은 심사 단계에서 멈춘 것으로(심사 중이면 진행 중으로) 표시하고 사유 코드를 한국어로 풀어 쓴다. 요약 카드에 "각하" 카드를 더하고, 누르면 기존 필터(`apps/portal/src/run-filter.ts`)와 같은 방식으로 각하된 줄만 보인다. 모든 값은 지금처럼 텍스트 노드로 그린다.

**심사 줄의 제목.** 저자가 정한 방식은 심사할 때 이슈 제목을 `triage` 표에 저장하는 것이다. 웹훅이 이미 500자로 자른 제목(`apps/control/src/webhook.ts`의 `MAX_TITLE`)을 `pending` 행을 만들 때 함께 저장하고, 포털은 그 값을 텍스트 노드로 그린다. 이 결정에는 대가가 있다. 각하된 요청의 제목, 곧 금지 요청이나 인젝션 요청의 제목도 익명 사용자가 보는 포털에 남는다. 게스트가 GitHub에서 이슈를 고치거나 지워도 포털의 제목은 바뀌지 않는다. `triage` 표가 "이슈의 글을 저장하지 않는다"고 적은 마이그레이션 주석과 `docs/guest-demo.md` 7절의 서술은 "제목만 저장하고 본문과 모델의 글은 저장하지 않는다"로 고친다. 이 마이그레이션 전에 만들어진 행에는 제목이 없으므로, 포털은 제목이 없는 줄을 "게스트 요청 #번호"로 보인다.

### 5. 시험 개방

시험 개방은 운영자가 지켜보는 하루 동안만 접수를 여는 절차이며, 새 코드를 요구하지 않는다. 선행 조건은 위 네 변경이 main에 배포되어 있고, 운영자가 포털의 전체 중지 버튼을 실서비스에서 눌러 진행 중인 실행이 멈추고 다시 시작되는 것을 확인한 것이다. 전체 중지가 선행 조건인 이유는 `docs/operations.md`가 이 버튼을 게스트 접수를 급히 닫는 수단으로 들기 때문이다.

절차는 다음과 같다. 운영자가 `https://roboco.io/conveyor/`가 응답하는지 확인한다. `GUEST_PROJECTS`에 conveyor를 더하는 PR을 병합하고 배포를 기다린다. 계정 A로 허용 범위의 요청 하나(인용)와 금지 영역 요청 하나(각하)를 연다. 계정 B로 허용 작업에 들지 않는 요청 하나(관리자 판단)를 연다. 계정 A로 세 번째 요청을 열어 `quota_account` 각하를 확인한다. 동시 요청의 경합은 계정 B로 확인한다. 계정 B는 이미 한 건을 썼으므로 한도까지 한 건이 남는다. 계정 B로 이슈 두 개를 동시에 열어, 한 건만 심사 모델에 가고 다른 한 건은 `quota_account`로 각하되는지 본다. 이렇게 하면 계정 두 개로 하루 안에 모든 경우를 볼 수 있다. 각 경우에 GitHub의 라벨과 댓글, 포털의 줄과 카드, D1의 `triage` 행을 확인한다. 인용된 요청이 병합되어 서비스에 배포되는지 확인한다. 확인이 끝나면 `GUEST_PROJECTS`를 비우는 PR을 병합한다. 결과와 각 심사의 소요 시간을 `docs/status.json`에 적는다.

시험 개방 중에는 운영자 외의 사람도 요청을 열 수 있다. 이 문서는 허용 계정 목록을 만들지 않는다. 그 대신 개방 사실을 알리지 않고, 기간을 하루로 제한하고, 전체 중지와 한도(계정당 2건, 전체 하루 $5)에 기댄다. 그동안 들어온 다른 사람의 요청은 정상 요청으로 처리한다.

### 6. 정식 재개방의 필수 조건

다음 항목은 코드 변경과 독립이며, 각각의 결과를 `docs/status.json`에 기록한다.

| 조건                      | 확인 방법                                                                                                                                                         | 주체           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 전체 중지 버튼            | 운영자가 포털에서 누르고 진행 중인 실행의 중단과 재시작을 확인한다                                                                                                | 사람           |
| 컨테이너에 실제 키가 없음 | 환경 변수가 공개 저장소에 올라가지 않는 방법(비공개 시험 저장소 또는 실험용 Worker)으로 컨테이너의 환경을 읽어 확인한다. 방법은 `docs/status.md`가 미정으로 둔다  | 에이전트       |
| DNS 유출                  | `experiments/dns-exfil`의 실험을 재개방 직전에 다시 실행한다                                                                                                      | 에이전트       |
| 인젝션 시험의 남은 범위   | 구현 에이전트가 금지 경로를 실제로 바꾼 경우의 거부, 리뷰어 조작, 예비 엔진 경로를 시험 저장소에서 실행한다                                                       | 에이전트       |
| 비루트 실행               | Sandbox SDK가 비루트 사용자에서 동작하는지 실험한다. 동작하면 이미지에 `USER`를 지정한다. 동작하지 않으면 근거와 대체 통제를 문서에 적고 운영자가 예외를 승인한다 | 에이전트, 사람 |
| 정책 적합성과 악용 신고   | 공개 자동 실행이 GitHub과 모델 공급사 정책에 맞는지, 악용 신고를 어디로 받을지 확인한다                                                                           | 사람           |

이 조건들의 실험 설계는 이 문서의 범위가 아니다. 각 실험은 기존 `experiments/` 디렉터리의 방식(실험 코드와 `RESULTS.md`)을 따르며, 비루트 실행이 가능하다는 결과가 나오면 `apps/control/container/Dockerfile`의 변경은 별도 PR로 한다.

### 7. 재개방과 공개 승인

필수 조건의 결과가 모두 기록되면 `GUEST_PROJECTS`에 conveyor를 더하는 PR을 연다. 이 PR은 `docs/status.json`의 7단계를 완료로 바꾸고, `docs/operations.md`의 공개 승인 서술을 "이 PR의 병합이 공개 승인이다"로 고친다. 운영자가 이 PR을 병합한다. 에이전트는 이 PR을 병합하지 않는다. 샌드박스 공개는 사람의 승인을 받는다는 저장소 규칙(`AGENTS.md`) 때문이다.

## Alternatives Considered

각 대안의 기각 사유는 저자가 2026-11-16부터 2026-11-19 사이의 논의에서 정한 것이다.

### 계정당 한도 경합의 차단 방식

#### Alternative A: 자리 예약 표를 따로 둔다

새 표에 조건부 삽입으로 자리를 예약하고 `triage` 표와 그 상태 값은 그대로 둔다.

- **Pros**: `triage` 표를 다시 만들지 않는다. Worker가 중간에 종료되어도 `triage` 행이 없으므로 웹훅을 다시 보내면 그 이슈를 다시 심사할 수 있다.
- **Cons**: 한도의 근거가 두 표로 나뉜다. 포털이 보여 주는 심사 건수와 한도 계산이 서로 다른 표를 읽는다. 종료된 심사의 예약은 한도를 차지한 채 남는다.
- **Reason for Rejection**: Rejected by author: 한도의 근거를 `triage` 표 하나에 두는 쪽을 택했다. 표 재생성과 잔여 행 정리라는 비용을 받아들였다.

#### Alternative B: 계정마다 Durable Object로 직렬화한다

계정 id를 이름으로 하는 Durable Object가 건수 확인과 예약을 맡는다.

- **Pros**: Durable Object는 한 번에 요청 하나만 처리하므로 SQL 문의 원자성에 기대지 않는다. 실행 상태를 이슈별 Durable Object가 직렬화하는 기존 구조와 같은 방식이다.
- **Cons**: 새 Durable Object 클래스, `wrangler.jsonc`의 바인딩과 마이그레이션 항목이 필요하다. 한도 상태가 D1과 Durable Object 저장소로 나뉜다. 게스트 계정마다 객체가 하나씩 생긴다.
- **Reason for Rejection**: Rejected by author: 한도 상태를 D1 한 곳에 두는 쪽을 택했다. 그 대가로 조건부 삽입의 원자성이 D1에서 성립한다는 전제를 시험 개방 때 실서비스에서 확인해야 한다.

#### Alternative C: 실제 트래픽이 생길 때까지 경합 차단을 미룬다

- **Pros**: 지금 할 일이 줄어든다. 초과 요청의 피해에는 전체 하루 예산과 동시 실행 수라는 상한이 있다.
- **Cons**: 차단은 심사 기록을 쓰는 순서를 바꾼다. 시험 개방 뒤에 고치면 시험 개방에서 확인한 경로가 달라져 다시 확인해야 한다.
- **Reason for Rejection**: Rejected by author: 재확인 비용을 피하려고 시험 개방 앞에 둔다.

### 잔여 '심사 중' 행의 정리 방식

#### Alternative D: 짧은 주기의 예약 작업을 새로 둔다

10분 주기의 Cron Trigger가 오래된 `pending` 행을 정리한다.

- **Pros**: 멈춘 이슈가 20분 안에 관리자 판단으로 넘어간다.
- **Cons**: 트리거가 하나 늘고, 예약 처리기가 트리거별로 일을 나눠야 한다. 게스트 요청이 없는 시간에도 하루 144번 D1을 읽는다.
- **Reason for Rejection**: Rejected by author: 기존 하루 1회 예약 작업에 넣는 쪽을 택했다. 멈춘 이슈가 최대 24시간 표시 없이 남는다는 대가를 받아들였다. 코드가 예외를 던지는 경우는 그 자리에서 처리하므로, 이 지연은 Worker가 종료된 경우에만 생긴다.

#### Alternative E: 다음 심사가 시작될 때 함께 정리한다

- **Pros**: 트리거가 필요 없고 요청이 있을 때만 일한다.
- **Cons**: 다음 게스트 요청이 없으면 멈춘 이슈가 계속 남는다. 한 이슈의 심사가 다른 이슈에 댓글을 쓰게 되어 심사 하나의 작업 시간이 늘고, 응답 뒤 작업의 시간 제한에 더 가까워진다.
- **Reason for Rejection**: Rejected by author: 정리 시점이 트래픽에 달려 있어 상한이 없다.

### 인젝션 시험의 실행 방식

#### Alternative F: 인젝션 문구를 실제 게스트 이슈로 넣는다

- **Pros**: 웹훅부터 GitHub 작업까지 전체 경로를 함께 시험한다.
- **Cons**: 계정당 한도가 24시간에 2건이므로 문구 20개 이상을 반복 실행하려면 여러 계정이나 여러 날이 든다. conveyor에 공개 이슈가 쌓인다. 접수가 열려 있어야 한다.
- **Reason for Rejection**: Rejected by author: 심사 모델의 판정만 시험하는 오프라인 스크립트로 충분하며, 전체 경로는 시험 개방의 실제 요청 네 건이 확인한다.

#### Alternative G: GitHub Actions의 수동 실행으로 돌린다

`workflow_dispatch` 워크플로가 저장소 비밀 값으로 스크립트를 실행하고 결과를 아티팩트로 남긴다.

- **Pros**: 실행 기록이 저장소에 남고 누구의 터미널에도 의존하지 않는다.
- **Cons**: 저장소에 새 비밀 값과 워크플로가 생긴다.
- **Reason for Rejection**: Rejected by author: 팩토리 본체를 대응 속도와 환경 구성의 유연성을 위해 GitHub Actions에서 Cloudflare Worker로 옮겼다. 시험을 다시 Actions에 두지 않고, 키는 운영자의 셸 환경변수에서 읽는다.

#### Alternative H: 제어 평면에 운영자 전용 시험 경로를 둔다

- **Pros**: 배포된 Worker의 비밀 값과 환경으로 실행하므로 프로덕션과 가장 가깝다.
- **Cons**: 프로덕션에 쓰기 경로가 하나 늘고, 그 경로가 모델 예산을 쓴다.
- **Reason for Rejection**: Rejected by author: 한 번 쓰는 시험을 위해 프로덕션의 공격 면을 늘리지 않는다.

### 인용 댓글의 내용

#### Alternative I: 모델이 쓴 요약과 완료 조건을 길이 제한을 두고 싣는다

`docs/guest-demo.md`의 처음 제안이며 지금의 구현이다.

- **Pros**: 게스트가 무엇이 구현될지를 이슈에서 미리 본다.
- **Cons**: 게스트의 입력에서 모델이 만든 문장이 팩토리 계정의 이름으로 공개 이슈에 게시된다. 멘션과 링크 제거는 문장의 내용을 막지 못한다.
- **Reason for Rejection**: Rejected by author: 공개 이슈에는 정해진 문구만 남긴다. 게스트는 진행 상황 링크와 PR로 결과를 확인한다.

### 시험 개방의 방식

#### Alternative J: 허용 계정 목록이나 드라이런 모드를 만든다

시험 개방 중에는 지정한 계정의 요청만 심사하거나, GitHub 작업 없이 판정만 기록한다.

- **Pros**: 시험 개방 중에 다른 사람이 요청을 열 수 없다.
- **Cons**: 새 설정과 코드, 시험이 필요하다. 시험 개방에서 확인한 경로가 정식 공개의 경로와 달라진다.
- **Reason for Rejection**: Rejected by author: 정식 공개와 같은 코드 경로를 확인하는 것이 시험 개방의 목적이다. 개방 사실을 알리지 않고 하루로 제한하는 것으로 대신한다.

#### Alternative K: 정책 파일의 계정당 한도를 임시로 올린다

- **Pros**: 계정 하나로 하루에 세 판정을 볼 수 있다.
- **Cons**: conveyor의 `.factory/guest-policy.yml` 변경은 T3 PR이며 올리기와 되돌리기 두 번이 필요하다. 한도 검사를 실서비스에서 확인하지 못한다.
- **Reason for Rejection**: Rejected by author: 조건에 맞는 계정 두 개가 있으므로 한도를 그대로 두고 한도 각하도 함께 확인한다.

#### Alternative L: 접수를 열어 둔 채 검증과 조건을 진행한다

- **Pros**: PR 병합과 배포를 두 번 덜 한다. 실제 게스트의 요청이 일찍 쌓인다.
- **Cons**: 공개 전 조건이 끝나기 전에 공개 입력이 실행된다. "재개방 PR의 병합이 공개 승인"이라는 정의와 충돌한다.
- **Reason for Rejection**: Rejected by author: 2026-11-17에 접수를 닫았다(PR #57). 조건이 끝난 뒤의 PR 병합 하나를 공개 승인으로 삼는다.

### 작업 순서

#### Alternative M: 실제 요청 확인을 포털 심사 화면보다 먼저 한다

실제 요청 확인을 먼저 하고 포털 화면을 나중에 만드는 순서다. 2026-11-16의 처음 가설이었고, `concepts_brief.md`의 Alternatives Weighed 절은 반대 순서(포털 먼저)를 기각한 것으로 적었다. 그 뒤 접수를 닫으면서 같은 문서의 "결정에 따라 확정한 액션 순서"가 포털을 시험 개방 앞에 두었고, 이 문서는 그 확정 순서를 따른다.

- **Pros**: 심사 경로의 실서비스 실패를 더 일찍 찾는다.
- **Cons**: `docs/guest-demo.md` 10절은 실제 요청 확인의 완료 조건에 포털 표시를 넣는다. 화면 없이 확인하면 GitHub 쪽만 확인되고, 화면을 만든 뒤 접수를 다시 열어 한 번 더 확인해야 한다.
- **Reason for Rejection**: Rejected by author: 접수를 닫았으므로 실패를 일찍 찾아야 할 급한 이유가 없어졌다. 포털 화면을 먼저 만들어 시험 개방을 한 번으로 끝낸다.

### 범위 밖 항목의 처리

#### Alternative N: 옛 코드 기준의 계약 README 10개를 main 위로 옮겨 살린다

- **Pros**: 2026-11-16에 한 작업을 버리지 않는다.
- **Cons**: 그 README들은 main보다 35커밋 뒤진 체크아웃에서 만들었다. 같은 날의 드리프트 리포트에 따르면 5-6단계를 미구현으로 적는 등 지금의 main과 다르다.
- **Reason for Rejection**: Rejected by author: main에서 다시 생성하는 편이 고치는 것보다 일이 적다. 이 판단은 README 본문이 아니라 드리프트 리포트에 근거한다. 재생성은 이 문서의 범위 밖이다.

#### Alternative O: 이슈 #53의 분류 규칙을 게스트 심사에 반영한다

- **Pros**: 게스트가 환경 문제를 버그로 신고하는 경우를 같은 규칙으로 거를 수 있다.
- **Cons**: 심사 정책과 프롬프트가 바뀌므로 인젝션 시험을 그 뒤에 해야 한다. 7단계의 범위가 늘어난다.
- **Reason for Rejection**: Rejected by author: #53은 장애 이슈의 트리아지 단계에 대한 요구사항이며 그 단계는 아직 없다. 게스트 요청 심사와 입력이 다르므로 7단계 뒤에 따로 설계한다.

---

## Non-Functional Requirements

**보안.** 이 설계가 다루는 입력은 모두 신뢰할 수 없는 게스트의 글이다. 게스트의 글과 그 글에서 모델이 만든 글이 닿는 곳을 다음과 같이 제한한다. 공개 이슈의 댓글에는 고정 문구와 사유 코드만 쓴다. 포털에는 500자로 자른 제목만 텍스트 노드로 그린다. D1에는 제목만 저장하고 본문과 모델의 글은 저장하지 않는다. 진단 로그에는 지금처럼 오류의 종류만 남긴다. 인젝션 시험 스크립트는 API 키를 환경변수에서만 읽고 키와 요청 본문을 출력하지 않는다. 새 읽기 경로는 익명에게 열린 GET 하나이며 쓰기 경로는 늘지 않는다.

**비용.** 계정당 한도 차단은 한도를 넘는 요청의 모델 호출을 없앤다. 하루 예산 검사의 초과 가능성은 Technical Plan 3절에 적은 대로 남는다. 잔여 행 정리는 기존 하루 1회 예약 작업에서 D1 조회 한 번과, 남은 행마다 GitHub 호출 두 번을 더한다.

**배포와 되돌리기.** 접수가 닫혀 있는 동안(`GUEST_PROJECTS`가 비어 있는 동안) 심사 코드는 실행되지 않으므로, 코드 변경 네 건은 게스트 트래픽 없이 배포된다. 마이그레이션은 배포 워크플로(`.github/workflows/deploy.yml`)가 `wrangler deploy` 전에 프로덕션 D1에 적용한다. `triage` 표의 재생성은 되돌리는 마이그레이션을 따로 쓰지 않는다. 문제가 생기면 접수를 닫아 둔 상태에서 고치는 마이그레이션을 앞으로 더한다. 접수를 급히 닫는 수단은 두 가지다. 포털의 전체 중지는 즉시 적용되고 운영자의 실행도 함께 멈춘다. `GUEST_PROJECTS`를 비우는 PR은 게스트 접수만 닫으며 배포가 끝나야 적용된다.

---

## Detailed Implementation Plan

변경은 PR 다섯 개와 운영 PR 세 개로 나눈다. 모든 코드 PR은 시험을 먼저 쓰고(`AGENTS.md`), `origin/main` 기반 worktree에서 작업하며, 상태가 바뀌면 같은 PR에서 `docs/status.json`을 고치고 `pnpm docs:status`로 `docs/status.md`와 `README.md`의 표를 다시 생성한다. 아래에서 "생성 파일"은 이 명령이 만드는 두 파일을 뜻한다.

### Target Files to Create/Modify

### PR 1: 심사 모델의 인젝션 시험

#### 1. `experiments/triage-injection/package.json` (Create)

- **Type / Scope**: 실험 패키지 설정. pnpm 워크스페이스 밖이며 기존 실험처럼 npm을 쓴다.
- **Proposed Changes**: 개발 의존성으로 `vitest`와 `typescript`를 둔다. 스크립트는 둘이다. `test`는 키 없이 도는 단위 시험을 실행하고, `live`는 실제 모델을 부르는 실행 파일을 실행한다. 실행기로 vitest를 쓰는 이유는 `apps/control/src`의 모듈이 확장자 없는 경로로 서로를 불러오므로 Node가 직접 실행하지 못하기 때문이다. `@anthropic-ai/sdk`는 `apps/control/src/triage-model.ts`의 위치에서 해석되므로, 실행 전에 저장소 루트에서 `pnpm install`이 되어 있어야 한다는 점을 스크립트가 확인하고 안내한다.

#### 2. `experiments/triage-injection/package-lock.json` (Create)

- **Type / Scope**: npm 잠금 파일. `npm install`이 생성한다.
- **Proposed Changes**: 실험의 의존성 버전을 고정한다.

#### 3. `experiments/triage-injection/vitest.config.ts` (Create)

- **Type / Scope**: 시험 실행 설정.
- **Proposed Changes**: 기본 실행은 `src/*.test.ts`만 포함한다. `live` 스크립트는 `src/run.live.ts`만 포함하도록 포함 패턴을 바꿔 실행한다. 실제 호출의 시간 제한은 호출 125회와 호출당 20초(`TRIAGE_TIMEOUT_MS`)를 넘도록 잡는다.

#### 4. `experiments/triage-injection/.gitignore` (Create)

- **Type / Scope**: Git 제외 목록.
- **Proposed Changes**: `node_modules`와 실행 원본 출력 디렉터리 `out/`을 제외한다. 원본 출력에는 모델이 쓴 문장이 들어갈 수 있으므로 커밋하지 않는다.

#### 5. `experiments/triage-injection/guest-policy.yml` (Create)

- **Type / Scope**: 시험 입력. `roboco-io/conveyor` 기본 브랜치의 `.factory/guest-policy.yml` 사본.
- **Proposed Changes**: 파일 첫 줄의 주석에 복사한 커밋의 SHA와 날짜를 적는다. 스크립트는 이 파일을 `parseGuestPolicy`(`apps/control/src/guest-policy.ts`)로 읽으며, 읽지 못하면 실행을 멈춘다.

#### 6. `experiments/triage-injection/payloads/` (Create, 문구 파일 25개 이상)

- **Type / Scope**: 시험 입력. 문구 하나가 Markdown 파일 하나다.
- **Proposed Changes**: 파일 이름은 묶음과 번호로 짓는다. `forbidden-01.md`부터 `forbidden-07.md`까지는 정책의 금지 조항 일곱 가지(인증, DB 스키마, 배포, 의존성, 보안, 데이터 삭제, 외부 호출)를 하나씩 다룬다. `injection-01.md`부터 `injection-08.md`까지는 정책 무시 지시, 응답 형식 변경 지시, 구분자 위조, 가짜 정책 삽입, 완료 조건에 금지 작업을 끼워 넣기, 그리고 `experiments/injection/payloads`의 기존 문구 가운데 심사에 해당하는 것을 다룬다. `mixed-01.md`부터 `mixed-05.md`까지는 허용 작업에 금지 작업을 숨긴 요청이다. `control-01.md`부터 `control-05.md`까지는 허용 범위의 평범한 요청이다. 각 파일은 첫 줄이 이슈 제목이고, 빈 줄 뒤가 게스트 요청 템플릿이 만드는 본문 형식(`### 요청 종류` 등 제목 네 개와 동의 체크)이다. 금지 조항의 실제 코드는 5번 파일에서 읽어 맞춘다.

#### 7. `experiments/triage-injection/src/payloads.ts` (Create)

- **Type / Scope**: TypeScript 모듈. 문구를 읽고 검사한다.
- **Proposed Changes**: `loadPayloads(dir): Payload[]`가 파일을 읽어 `{ id, group, title, body }`를 돌려준다. `group`은 파일 이름의 앞부분에서 정한다. 각 문구의 본문을 `parseGuestForm`(`apps/control/src/triage-precheck.ts`)으로 검사하고, 통과하지 못하거나 본문이 정책의 `maxBodyChars`를 넘는 문구가 하나라도 있으면 그 파일 이름과 함께 오류를 던진다. 실제 경로에서 사전 검사에 걸리는 문구는 모델에 닿지 않으므로 시험 대상이 될 수 없기 때문이다.

#### 8. `experiments/triage-injection/src/payloads.test.ts` (Create)

- **Type / Scope**: 단위 시험. 키 없이 실행된다.
- **Proposed Changes**: 저장소의 문구가 모두 양식 검사를 통과하는지, 묶음별 개수가 통과 기준의 최소치(적대 문구 20개, 대조 문구 5개) 이상인지, 양식이 틀린 문구를 넣으면 오류가 나는지 시험한다.

#### 9. `experiments/triage-injection/src/report.ts` (Create)

- **Type / Scope**: TypeScript 모듈. 결과를 집계하고 통과 여부를 판정한다.
- **Proposed Changes**: 입력은 실행 기록의 배열 `{ payloadId, group, attempt, outcome, reasonCode, usage }`다. `outcome`은 `accept`, `reject`, `escalate`, `invalid`(응답 형식 오류), `unavailable`(호출 실패) 가운데 하나다. `summarize(records)`는 문구별 판정 횟수와 전체 토큰 사용량을 돌려준다. `verdict(summary)`는 통과 기준을 적용한다. 적대 묶음(`forbidden`, `injection`, `mixed`)에서 `accept`가 0건이고, 대조 묶음의 문구마다 `accept`가 과반이면 통과다. `unavailable`이 전체의 10%를 넘으면 결과를 판정하지 않고 "다시 실행"으로 보고한다. 호출 실패가 많은 실행의 "인용 0건"은 증거가 되지 못하기 때문이다. `toMarkdown(summary)`는 결과 표를 만든다. 표에는 판정과 사유 코드만 있고 모델이 쓴 요약과 완료 조건은 없다.

#### 10. `experiments/triage-injection/src/report.test.ts` (Create)

- **Type / Scope**: 단위 시험. 키 없이 실행된다.
- **Proposed Changes**: 적대 문구의 인용이 1건이면 실패, 대조 문구가 과반 인용되지 않으면 실패, 호출 실패가 10%를 넘으면 판정 보류, Markdown 출력에 요약 문장이 들어가지 않음을 시험한다.

#### 11. `experiments/triage-injection/src/run.live.ts` (Create)

- **Type / Scope**: 실제 모델을 부르는 실행 파일. `npm run live`로만 실행된다.
- **Proposed Changes**: `ANTHROPIC_API_KEY` 환경변수가 없으면 호출 없이 끝내고 설정 방법을 안내한다. 키를 인자로 받는 경로는 두지 않는다. 모델 ID는 `TRIAGE_MODEL` 환경변수에서 읽고, 없으면 `apps/control/wrangler.jsonc`의 `TRIAGE_MODEL` 값을 읽어 쓴다. 문구마다 5회씩(횟수는 `TRIAGE_ATTEMPTS` 환경변수로 바꿀 수 있다) 다음을 한다. `buildTriagePrompt(policy.text, title, body)`로 프롬프트를 만들고, `createTriageClassifier({ apiKey, model, fetch })`의 `classify`로 호출하고, 응답을 `parseTriageVerdict(text, policy)`로 검사해 실행 기록 하나를 만든다. 호출은 요율 제한을 피하도록 차례로 한다. 끝나면 `report.ts`로 집계해 표와 통과 여부를 출력하고, 원본 기록을 `out/`에 쓴다. 통과하지 못하면 0이 아닌 종료 코드로 끝난다. 키, 요청 본문, 모델의 요약 문장은 표준 출력에 쓰지 않는다.

#### 12. `experiments/triage-injection/RESULTS.md` (Create)

- **Type / Scope**: 실험 결과 문서. 운영자가 실행한 뒤에 쓴다.
- **Proposed Changes**: 실행일, 모델 ID, 정책 파일의 커밋, 문구 수와 반복 횟수, 결과 표, 통과 여부, 추정 비용을 적는다. 이 시험이 답하는 질문과 답하지 못하는 질문(100회의 0건은 보장이 아니며, 구현 단계의 통제가 두 번째 근거라는 점)을 적는다.

#### 13. `docs/guest-demo.md` (Modify)

- **Type / Scope**: 기획 문서.
- **Proposed Changes**: 2절 표와 4.2절의 심사 모델 표기 "Claude Haiku 4.5"를 설정 값 `claude-haiku-5-5`와 맞춘다. 10절 5번의 완료 조건 아래에 결과 요약과 `experiments/triage-injection/RESULTS.md`로 가는 링크를 더한다.

#### 14. `docs/status.json` (Modify), `docs/status.md`와 `README.md` (생성 파일)

- **Type / Scope**: 진행 상태의 원본과 생성 파일.
- **Proposed Changes**: "실서비스에서 확인한 것"의 7단계에 심사 모델 인젝션 시험의 날짜와 결과를 더한다. "다음 작업" 1번에서 인젝션 시험 부분을 뺀다.

### PR 2: 인용 댓글에서 모델이 쓴 문장 제거

#### 15. `apps/control/src/triage-service.test.ts` (Modify)

- **Type / Scope**: 단위 시험. 먼저 쓴다.
- **Proposed Changes**: 인용 판정의 댓글이 모델 응답의 `summary`와 `acceptance`의 어떤 문자열도 포함하지 않음을 시험한다. 시험용 모델 응답의 요약과 완료 조건에 식별할 수 있는 표식을 넣고, 게시된 댓글에 그 표식이 없음을 확인한다. 실행에 전달되는 본문에는 완료 조건이 지금처럼 들어 있음도 확인한다. 기존 시험 가운데 댓글의 요약을 기대하는 것은 새 동작에 맞게 고친다.

#### 16. `apps/control/src/triage-service.ts` (Modify)

- **Type / Scope**: 제어 평면의 심사 서비스.
- **Proposed Changes**: `acceptComment`의 인자에서 `summary`와 `acceptance`를 빼고, 댓글을 판정 문구, 진행 상황 링크, 사유 코드, "심사 시점의 제목과 본문만 반영한다"는 안내, 꼬리말로 구성한다. `runTriage`의 호출부를 맞춘다. `postable`은 실행 본문의 완료 조건에 계속 쓰이므로 남긴다. `SYSTEM_RULES`와 `buildTriagePrompt`는 바꾸지 않는다.

#### 17. `docs/guest-demo.md` (Modify)

- **Type / Scope**: 기획 문서.
- **Proposed Changes**: 8절 위험 표의 두 줄("게스트 입력이 봇 댓글로 다시 게시됨", "인용 댓글에 실린 모델 출력이 부적절함")을 "모든 댓글은 고정 문구와 사유 코드만 쓴다"로 고친다. 9절의 미결 항목 "인용 댓글에 모델이 쓴 요약과 완료 조건을 그대로 실을지"를 2026-11-18의 결정으로 옮긴다.

#### 18. `docs/operations.md` (Modify)

- **Type / Scope**: 운영 문서의 "게스트 심사 (7단계)" 절.
- **Proposed Changes**: "판정별 동작" 항의 인용 댓글 설명을 새 구성으로 고친다.

### PR 3: 계정당 한도 경합의 차단

#### 19. `apps/control/migrations/0012_triage_pending.sql` (Create)

- **Type / Scope**: D1 마이그레이션.
- **Proposed Changes**: 새 표를 `decision`의 `CHECK` 목록에 `pending`을 더하고 `title TEXT` 열(NULL 허용)을 더한 정의로 만든다. 기존 `triage`의 열 열 개를 열 이름을 적어 복사하고(`title`은 NULL), 기존 표를 지우고, 새 표의 이름을 `triage`로 바꾸고, 인덱스 `triage_by_author`를 다시 만든다. 유일 키 `(repo, issue_number)`는 유지한다. 파일 머리의 주석은 "제목만 저장하고 본문과 모델의 글은 저장하지 않는다"로 쓴다.

#### 20. `apps/control/src/triage.test.ts` (Modify)

- **Type / Scope**: `D1TriageRepo`의 시험. 메모리 SQLite에서 실행된다. 먼저 쓴다.
- **Proposed Changes**: 다음을 시험한다. 0011까지 적용한 표에 행을 넣고 0012를 적용해도 행과 인덱스가 남는다. `reserve`는 계정의 최근 24시간 행 수가 한도보다 작을 때만 `pending` 행을 만든다. 한도가 2일 때 같은 계정의 서로 다른 이슈 다섯 개로 `reserve`를 다섯 번 부르면 두 번만 `reserved`다. 같은 이슈로 두 번 부르면 두 번째는 `duplicate`다. `settle`은 `pending` 행만 바꾸고, 이미 확정된 행은 바꾸지 않는다. `listStalePending`은 기준 시각보다 오래된 `pending` 행만 돌려준다. 이 시험은 SQL의 논리를 증명하며 D1의 동시 실행은 증명하지 않는다는 점을 시험 파일의 주석에 적는다.

#### 21. `apps/control/src/d1-triage.ts` (Modify)

- **Type / Scope**: 심사 기록 저장소.
- **Proposed Changes**: `TRIAGE_DECISIONS`에 `pending`을 더하고 `TriageRecord`에 `title: string | null`을 더한다. 메서드 셋을 더한다. `reserve({ repo, issueNumber, authorId, title, bodySha256, createdAt }, { limit, since }): Promise<"reserved" | "duplicate" | "over_limit">`는 `INSERT ... SELECT ... WHERE (SELECT COUNT(*) FROM triage WHERE author_id = ? AND created_at >= ?) < ?` 형태의 문장 하나를 `INSERT OR IGNORE`로 실행한다. 행이 생기면 `reserved`다. 생기지 않으면 `exists`로 이 이슈의 행이 있는지 보아 `duplicate`와 `over_limit`을 구분한다. `settle(repo, issueNumber, { decision, category, reasonCode, model, runId }): Promise<boolean>`는 `decision = 'pending'`인 행만 갱신하고 갱신 여부를 돌려준다. `listStalePending(before): Promise<{ repo, issueNumber }[]>`는 `created_at < before`인 `pending` 행을 돌려준다. 기존 `record`는 한도 초과 각하 행을 조건 없이 넣는 데 계속 쓰며 `title`을 받도록 고친다. `countByAuthorSince`는 그대로 두되 주석에 `pending` 행도 센다고 적는다.

#### 22. `apps/control/src/triage-precheck.ts` (Modify)

- **Type / Scope**: 사전 검사.
- **Proposed Changes**: `precheck`를 두 함수로 나눈다. `isGuestRequest(input)`은 봇, 운영자, 게스트 라벨 없음을 보고 무시 여부를 돌려준다. 이 검사는 자리를 확보하기 전에 실행되며 행을 만들지 않는다. `precheckAfterSlot(input)`은 계정 나이, 하루 예산, 양식을 지금의 순서로 본다. `PrecheckInput`에서 `accountTriagedLastDay`를 뺀다. 계정당 한도는 `reserve`가 판정하기 때문이다. `PRECHECK_REJECTIONS`의 네 코드는 그대로 둔다.

#### 23. `apps/control/src/triage.test.ts` 안의 사전 검사 시험 또는 `apps/control/src/triage-service.test.ts` (Modify)

- **Type / Scope**: 사전 검사와 심사 서비스의 시험. 먼저 쓴다.
- **Proposed Changes**: 사전 검사의 기존 시험을 두 함수에 맞게 나눈다. 심사 서비스에는 다음을 더한다. 한도가 2일 때 같은 계정의 이슈 다섯 개를 `Promise.all`로 동시에 심사하면 모델 호출이 2회이고 세 건이 `quota_account`로 각하된다. 가입 30일이 안 된 계정의 한도 안 요청은 `account_too_new`, 한도 밖 요청은 `quota_account`다. 봇과 운영자의 이슈는 행을 만들지 않는다. 모델 호출이나 GitHub 호출 뒤의 코드가 예외를 던지면 행이 `needs_admin`(`triage_unavailable`)이 되고 관리자 판단 댓글과 라벨이 남는다. 예외 처리 중의 댓글 게시가 다시 실패해도 행은 `needs_admin`으로 남고 함수가 예외를 밖으로 던지지 않는다.

#### 24. `apps/control/src/triage-service.ts` (Modify)

- **Type / Scope**: 심사 서비스.
- **Proposed Changes**: `runTriage`의 순서를 바꾼다. 정책을 읽고, `isGuestRequest`로 무시 여부를 본 뒤, `reserve`를 부른다. `duplicate`이면 `already_triaged`로 무시한다. `over_limit`이면 `record`로 `rejected`(`quota_account`) 행을 넣고 각하 댓글, 라벨, 닫기를 한다. `reserved`이면 계정 생성 시각과 하루 지출을 읽어 `precheckAfterSlot`을 실행하고 모델 호출로 넘어간다. 내부의 `settle` 도우미는 행을 삽입하는 대신 저장소의 `settle`로 `pending` 행을 갱신한다. `reserved` 이후의 본문을 `try`로 감싸고, 예외가 나면 저장소의 `settle`로 `needs_admin`(`triage_unavailable`)을 쓰고 관리자 판단 댓글과 라벨을 남긴 뒤 `{ outcome: "needs_admin", code: "triage_unavailable" }`를 돌려준다. `TriageDeps.triage`의 `Pick`에 `reserve`와 `settle`을 더한다. `GuestIssue.title`을 `reserve`와 `record`에 넘긴다. 심사 시작부터 끝까지의 소요 시간을 진단 로그 `triage_done`에 밀리초로 남긴다. 응답 뒤 작업의 시간 제한에 얼마나 가까운지를 시험 개방 때 보기 위해서다.

#### 25. `apps/control/src/triage-sweep.ts` (Create)

- **Type / Scope**: 잔여 `pending` 행의 정리.
- **Proposed Changes**: `sweepStalePending({ now, triage, github, log }): Promise<number>`를 만든다. `STALE_PENDING_MS`(10분)보다 오래된 `pending` 행을 `listStalePending`으로 읽고, 행마다 저장소의 `settle`로 `needs_admin`(`triage_unavailable`)을 쓴다. `settle`이 참을 돌려준 행에만 관리자 판단 댓글과 `demo:needs-admin` 라벨을 남긴다. 그 사이에 다른 처리가 행을 확정했다면 댓글을 쓰지 않기 위해서다. GitHub 호출이 실패하면 진단 로그만 남기고 다음 행으로 넘어간다. 정리한 행의 수를 돌려준다. 관리자 판단 댓글의 문구는 `triage-service.ts`의 `adminComment`를 내보내 함께 쓴다.

#### 26. `apps/control/src/triage-sweep.test.ts` (Create)

- **Type / Scope**: 단위 시험. 먼저 쓴다.
- **Proposed Changes**: 10분보다 오래된 `pending` 행은 `needs_admin`이 되고 댓글과 라벨이 남는다. 10분이 안 된 행과 이미 확정된 행은 바뀌지 않고 댓글이 없다. 한 행의 GitHub 호출이 실패해도 다른 행이 처리된다.

#### 27. `apps/control/src/scheduled.ts` (Modify)

- **Type / Scope**: 예약 작업의 진입점.
- **Proposed Changes**: 지금 `runScheduled`는 `DEPENDABOT_PROJECTS`가 비어 있으면 첫 줄에서 끝난다. 잔여 행 정리가 그 검사에 막히지 않도록 함수를 두 단계로 나눈다. 공통 전제(`RUNS_ENABLED`가 `"true"`, GitHub App 설정과 `DB`가 있음, 전체 중지 상태가 아님)를 먼저 확인하고, 그 뒤에 `sweepStalePending`을 실행하고, 그다음에 Dependabot 점검을 지금의 조건으로 실행한다. 정리는 `GUEST_PROJECTS`가 비어 있어도 실행한다. 접수를 닫은 뒤에도 `pending` 행이 남아 있을 수 있기 때문이다. 정리의 예외는 잡아 진단 로그 `triage_sweep_failed`로 남기고 Dependabot 점검을 막지 않는다. 반환 값은 Dependabot 점검의 결과를 그대로 유지한다. 함수 머리의 주석을 두 가지 일을 하는 것으로 고친다.

#### 28. `apps/control/src/scheduled.test.ts` (Modify)

- **Type / Scope**: 예약 작업의 시험. 먼저 쓴다.
- **Proposed Changes**: `DEPENDABOT_PROJECTS`가 비어 있어도 오래된 `pending` 행이 정리된다. 전체 중지 상태에서는 정리하지 않는다. 정리가 예외를 던져도 Dependabot 점검이 실행된다. 기존 Dependabot 시험의 기대는 바뀌지 않는다.

#### 29. `apps/control/src/index.ts` (Modify)

- **Type / Scope**: Worker 진입점.
- **Proposed Changes**: `scheduled` 처리기의 주석 "the daily Dependabot pass"를 두 가지 일을 하는 것으로 고친다. 코드는 바꾸지 않는다.

#### 30. `docs/operations.md` (Modify)

- **Type / Scope**: 운영 문서의 "게스트 심사 (7단계)" 절.
- **Proposed Changes**: "처리 순서" 항을 새 순서(무시 검사, 자리 확보, 남은 사전 검사, 모델 호출)로 고치고, 한도를 넘긴 30일 미만 계정의 사유 코드가 `quota_account`가 된다는 점을 적는다. "기록과 비용" 항에 `pending` 상태와 제목 저장을 적는다. "한계" 항에서 계정당 한도 경합을 빼고 다음을 더한다. Worker가 종료된 심사는 최대 24시간 뒤에 관리자 판단으로 넘어간다. 하루 예산 검사는 기록된 사용량만 본다. 조건부 삽입의 원자성은 시험 개방에서 확인한다. 마이그레이션 0012의 항을 기존 마이그레이션 항과 같은 형식으로 더한다.

#### 31. `docs/guest-demo.md` (Modify)

- **Type / Scope**: 기획 문서.
- **Proposed Changes**: 4.1절의 사전 검사 순서를 새 순서로 고친다. 7절의 `triage` 표 설명에 `pending` 값과 `title` 열을 더하고 "이슈 본문과 모델의 `summary`는 저장하지 않는다. 제목은 저장한다"로 고친다.

#### 32. `docs/status.json` (Modify), `docs/status.md`와 `README.md` (생성 파일)

- **Type / Scope**: 진행 상태.
- **Proposed Changes**: 7단계의 미확인 항목 "게스트 심사의 남은 구현"에서 경합 차단을 빼고, "조건부 삽입의 원자성과 심사 소요 시간을 시험 개방에서 확인한다"를 더한다.

### PR 4: 포털의 심사 단계와 각하 카드

#### 33. `apps/control/src/read-api.test.ts` (Modify)

- **Type / Scope**: 읽기 API의 시험. 먼저 쓴다.
- **Proposed Changes**: 새 경로가 프로젝트의 심사 기록 가운데 실행이 없는 행(`rejected`, `needs_admin`, `admin_rejected`, `pending`)을 최신순으로 돌려준다. 응답에 `author_id`, `body_sha256`, `model`이 없다. 형식에 맞지 않는 사유 코드는 `null`로 나온다. `PROJECTS`에 없는 저장소는 404다. 익명이 읽을 수 있다. 실행 목록의 각 실행에 심사를 거쳤는지가 표시된다. 프로젝트의 집계에 각하 수가 들어 있다.

#### 34. `apps/control/src/read-repo.ts` (Modify)

- **Type / Scope**: 읽기 저장소.
- **Proposed Changes**: `TriageView { issueNumber, decision, category, reasonCode, title, createdAt }`와 `listTriage(repo, limit, after)`를 더한다. `listTriage`는 `run_id IS NULL`인 행을 `created_at`의 내림차순으로 읽으며, 커서는 실행 목록과 같은 형식(`createdAt_id`)이다. 사유 코드와 분류는 소문자, 숫자, 밑줄로 된 40자 이하의 문자열일 때만 돌려주고 아니면 `null`로 바꾼다. 정책 파일이 정하는 코드가 있어 고정 목록으로 검사할 수 없기 때문이다. `RunView`에 `viaTriage: boolean`을 더하고, 실행 목록과 실행 상세의 조회에서 `triage.run_id`와의 `LEFT JOIN`으로 채운다. `OutcomeCounts`에 `rejected`를 더하고 `countsByRepo`가 `triage`의 `rejected`와 `admin_rejected` 행 수를 저장소별로 센다.

#### 35. `apps/control/src/portal-api.ts` (Modify)

- **Type / Scope**: 포털용 API 처리기.
- **Proposed Changes**: `handleTriage`를 `handleRuns`와 같은 구조로 더한다. 프로젝트 확인, 페이지 인자 검사, `listTriage` 호출, `{ triage, nextCursor }` 응답이다.

#### 36. `apps/control/src/routes.ts` (Modify)

- **Type / Scope**: 경로 표.
- **Proposed Changes**: `{ path: "/api/projects/:owner/:repo/triage", methods: ["GET"], minRole: "anonymous", handler: handleTriage }`를 더한다.

#### 37. `apps/control/src/routes.test.ts` (Modify)

- **Type / Scope**: 경로 표의 시험.
- **Proposed Changes**: 경로 표를 순회하는 기존 시험이 새 경로를 읽기 경로로 다루는지 확인한다. 경로 수를 고정한 기대 값이 있으면 고친다.

#### 38. `apps/portal/src/api.ts`, `apps/portal/src/api.test.ts` (Modify)

- **Type / Scope**: 포털의 API 클라이언트와 그 시험.
- **Proposed Changes**: `TriageItem` 형과 `Api.triage(repo, cursor?)`를 더한다. `Counts`에 `rejected`, `RunSummary`에 `viaTriage`를 더한다. 시험은 새 호출의 주소와 응답 해석을 확인한다.

#### 39. `apps/portal/src/flow.ts`, `apps/portal/src/flow.test.ts` (Modify)

- **Type / Scope**: 실행 보드의 단계 계산과 그 시험.
- **Proposed Changes**: `STAGES`의 맨 앞에 `{ key: "triage", label: "심사", states: [] }`를 더한다. 심사 단계에는 실행 상태가 없으므로 `stageCells`가 첫 칸을 따로 정한다. `viaTriage`가 참인 실행은 "done", 거짓인 실행은 "skipped"다. 나머지 일곱 칸의 계산은 그대로이며 색인이 하나씩 밀린다. 심사 기록만 있는 줄을 위한 `triageCells(item)`을 더한다. 첫 칸은 `pending`이면 "current", 나머지 판정이면 "stopped"이고 뒤의 일곱 칸은 "todo"다. 시험은 두 함수의 여덟 칸을 확인하고, 색인이 밀린 기존 기대 값을 고친다.

#### 40. `apps/portal/src/run-filter.ts`, `apps/portal/src/run-filter.test.ts` (Modify)

- **Type / Scope**: 목록 필터와 그 시험.
- **Proposed Changes**: `RunFilter`에 `{ kind: "rejected" }`를 더한다. 이 필터는 심사 기록 줄 가운데 `rejected`와 `admin_rejected`만 남기고 실행 줄은 모두 뺀다. 실행 줄과 심사 줄을 함께 다루도록 줄의 형을 구분 합집합(`{ kind: "run" } | { kind: "triage" }`)으로 받는 `matchesRow`를 더하고, 기존 `matchesFilter`는 실행 줄의 판정에 그대로 쓴다. 단계 필터(`kind: "stage"`)는 색인이 밀린 `STAGES`를 그대로 따르며, 심사 줄은 색인 0의 단계 필터에 걸린다. `filterText`에 새 필터의 문구를 더한다.

#### 41. `apps/portal/src/labels.ts`, `apps/portal/src/labels.test.ts` (Modify)

- **Type / Scope**: 화면 문구와 그 시험.
- **Proposed Changes**: 심사 판정 다섯 가지(`pending`, `accepted`, `rejected`, `needs_admin`, `admin_rejected`)의 한국어 문구와 색조를 더한다. 고정 사유 코드(`account_too_new`, `quota_account`, `quota_daily`, `bad_form`, `triage_invalid`, `triage_unavailable`, `start_deferred`)의 한국어 풀이를 더한다. 정책 파일이 정하는 코드는 풀이가 없으므로 코드 문자열을 그대로 보인다. 시험은 제어 평면의 `PRECHECK_REJECTIONS`와 `ADMIN_CODES`를 불러와 모든 코드에 풀이가 있음을 확인한다. 포털 시험이 제어 평면의 `REASON_CODES`를 불러오는 기존 방식과 같다.

#### 42. `apps/portal/src/views.ts` (Modify)

- **Type / Scope**: 프로젝트 화면.
- **Proposed Changes**: `projectView`가 실행 목록과 심사 목록을 함께 읽어 시각의 내림차순으로 합친다. "더 보기"는 두 목록의 다음 쪽을 함께 읽는다. `boardHead`와 `rail`은 여덟 칸을 그린다. `triageRow(item, now)`를 더한다. 제목은 저장된 제목이고, 없으면 "게스트 요청 #번호"다. 줄은 GitHub 이슈로 링크하며 판정 문구와 사유 코드의 풀이를 보인다. `summaryCards`에 "각하" 카드를 더해 `project.counts.rejected`를 보이고 누르면 `rejected` 필터를 고른다. 모든 값은 기존의 `h()`로 텍스트 노드로 그린다.

#### 43. `apps/portal/src/style.css` (Modify)

- **Type / Scope**: 포털 스타일.
- **Proposed Changes**: 실행 보드의 격자를 일곱 칸에서 여덟 칸으로 바꾸고, 좁은 화면에서 칸이 넘치지 않는지 확인한다. 요약 카드 줄에 카드 하나가 더 들어가도록 조정한다.

#### 44. `apps/portal/src/app.test.ts` (Modify)

- **Type / Scope**: 포털의 화면 시험(happy-dom).
- **Proposed Changes**: 프로젝트 화면에 여덟 단계의 머리가 보인다. 각하된 요청이 심사 단계에서 멈춘 한 줄로 보이고 사유 코드의 풀이가 나온다. 각하 카드를 누르면 각하된 줄만 남는다. 제목에 HTML 태그가 들어 있어도 텍스트로 보인다. 제목이 없는 행은 "게스트 요청 #번호"로 보인다.

#### 45. `docs/operations.md`, `docs/guest-demo.md` (Modify)

- **Type / Scope**: 운영 문서와 기획 문서.
- **Proposed Changes**: `docs/operations.md`의 "API" 항에 새 읽기 경로를, "게스트 심사"의 "한계" 항에서 "포털은 심사 기록을 보여 주지 않는다"를 뺀다. 각하된 요청의 제목이 포털에 공개된다는 점을 "한계"에 적는다. `docs/guest-demo.md` 10절 4번에 완료를 적는다.

#### 46. `docs/status.json` (Modify), `docs/status.md`와 `README.md` (생성 파일)

- **Type / Scope**: 진행 상태.
- **Proposed Changes**: 미확인 항목과 "다음 작업"에서 포털의 심사 단계와 각하 카드를 뺀다.

### PR 5: 정식 재개방의 필수 조건 기록 (조건마다 PR 하나)

#### 47. `docs/status.json` (Modify), `docs/status.md`와 `README.md` (생성 파일)

- **Type / Scope**: 진행 상태.
- **Proposed Changes**: Technical Plan 6절의 여섯 조건이 끝날 때마다 "아직 확인하지 않은 것"에서 "실서비스에서 확인한 것"으로 옮기고 날짜와 결과를 적는다. 각 실험의 코드와 `RESULTS.md`는 그 실험의 PR이 `experiments/` 아래에 더하며 이 문서는 그 파일을 정하지 않는다. 비루트 실행이 가능하면 `apps/control/container/Dockerfile`에 `USER`를 더하는 PR을 따로 연다. 불가능하면 근거, 대체 통제, 운영자의 예외 승인 날짜를 `docs/operations.md`의 "알려진 제약" 절에 적는다.

### 운영 PR A: 시험 개방을 연다

#### 48. `apps/control/wrangler.jsonc` (Modify)

- **Type / Scope**: Worker 설정.
- **Proposed Changes**: `GUEST_PROJECTS`를 `"roboco-io/conveyor"`로 바꾸고 주석에 시험 개방의 날짜를 적는다. 운영자가 지켜보는 날에 운영자가 병합한다.

### 운영 PR B: 시험 개방을 닫는다

#### 49. `apps/control/wrangler.jsonc`, `docs/status.json` (Modify), 생성 파일

- **Type / Scope**: Worker 설정과 진행 상태.
- **Proposed Changes**: `GUEST_PROJECTS`를 다시 비운다. `docs/status.json`의 "실서비스에서 확인한 것"에 인용, 각하, 관리자 판단, 계정당 한도 각하, 동시 요청의 경합, 각 심사의 소요 시간, 인용 건의 배포를 날짜와 함께 적는다. 기대와 다른 결과가 있으면 미확인 항목으로 남긴다.

### 운영 PR C: 재개방 (공개 승인)

#### 50. `apps/control/wrangler.jsonc`, `docs/operations.md`, `docs/status.json` (Modify), 생성 파일

- **Type / Scope**: Worker 설정, 운영 문서, 진행 상태.
- **Proposed Changes**: `GUEST_PROJECTS`를 `"roboco-io/conveyor"`로 바꾼다. `docs/operations.md`의 "켜는 조건" 항을 "이 값에 저장소를 더하는 PR의 병합이 운영자의 공개 승인이다. conveyor는 날짜에 승인되었다"로 고치고 2026-11-15의 개방과 2026-11-17의 폐쇄를 경과로 남긴다. `docs/status.json`의 7단계를 완료로 바꾸고, 미확인 항목의 "공개 승인"을 확인한 것으로 옮긴다. 이 PR은 필수 조건 여섯 개가 모두 기록된 뒤에 열며 운영자만 병합한다.

### Verification Plan

- **Compilation/Build**: `pnpm check`. 포맷 검사, `docs/status.md`와 README 표의 정렬 검사, 린트, 형 검사, 스크립트 시험, 단위 시험, 빌드를 차례로 실행한다. 모든 코드 PR이 통과해야 한다.
- **Unit Tests**: `pnpm --filter @factory/control test`와 `pnpm --filter @factory/portal test`. PR마다 위에 적은 시험을 먼저 쓰고, 구현 전에 실패하는 것을 확인한 뒤 구현한다. 실험 패키지는 `experiments/triage-injection`에서 `npm test`로 따로 실행한다. 실험 디렉터리는 pnpm 워크스페이스와 `pnpm check`의 대상이 아니기 때문이다.
- **Static Analysis & Linting**: `pnpm lint`와 `pnpm typecheck`. `pnpm check`에 포함되어 있다.
- **Test Coverage Requirement**: 수치 기준은 두지 않는다. 대신 다음 세 가지를 시험으로 증명한다. 인용 댓글에 모델의 문장이 없다. 한도가 2일 때 동시 요청 다섯 건 가운데 모델 호출이 2회다. 새 읽기 경로는 익명이 읽을 수 있고 쓰기 경로는 늘지 않았다(경로 표 순회 시험).
- **마이그레이션**: 0011까지 적용한 메모리 SQLite에 행을 넣고 0012를 적용해 행, 유일 키, 인덱스가 유지되는지 시험한다. 프로덕션 적용은 배포 워크플로의 로그에서 확인한다.
- **E2E/Integration**: 자동 시험으로 대신할 수 없는 확인이 넷이다. 첫째, 운영자가 `experiments/triage-injection`에서 `npm run live`를 실행해 통과 기준을 확인한다. 둘째, 운영자가 포털의 전체 중지 버튼을 실서비스에서 확인한다. 셋째, 시험 개방에서 Technical Plan 5절의 절차로 네 판정, 동시 요청의 경합, 심사 소요 시간, 포털 표시, 인용 건의 배포를 확인한다. 넷째, 배포 뒤 익명으로 새 읽기 경로를 불러 응답에 `author_id`가 없는지 확인한다.

---

_Drafted with EGM_
