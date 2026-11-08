# 운영 설정

이 문서는 2단계(이슈 하나가 PR이 되는 경로), 3단계(다른 엔진의 리뷰와 프로그램의 병합 판정), 4단계(포털과 로그인)를 켜기 위해 사람이 설정해야 하는 값을 정리한다. 작성일은 2026-11-06이다. 아래 값을 설정하기 전에도 배포는 실패하지 않으며, 웹훅은 요청을 처리하지 않고 거부하거나 무시한다.

## 비밀 값

비밀 값은 코드, 설정 파일, 명령 인자에 넣지 않는다. `apps/control` 디렉터리에서 `pnpm exec wrangler secret put <이름>`을 실행하면 값을 표준 입력으로 받는다. Worker를 한 번 배포한 뒤에 설정할 수 있다.

| 이름                         | 내용                                                                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`      | GitHub App 웹훅 설정에 입력한 비밀 값. 없으면 웹훅 엔드포인트가 503을 반환한다.                                                                                                                      |
| `GITHUB_APP_PRIVATE_KEY`     | GitHub App의 개인 키 PEM 전체. GitHub가 내려주는 PKCS#1(`BEGIN RSA PRIVATE KEY`) 형식을 그대로 넣는다. 코드가 WebCrypto용 PKCS#8로 변환한다.                                                         |
| `ANTHROPIC_API_KEY`          | 에이전트가 쓰는 Anthropic 키. 컨테이너에는 들어가지 않고, 출구 핸들러(`Outbound`)가 `api.anthropic.com`으로 나가는 요청에만 주입한다.                                                                |
| `OPENAI_API_KEY`             | 리뷰 에이전트(pi)가 쓰는 OpenAI 키. 컨테이너에는 들어가지 않고, 출구 핸들러가 리뷰 샌드박스에서 `api.openai.com`으로 나가는 요청에만 주입한다. 없으면 리뷰가 실패해 실행이 `needs_human`으로 끝난다. |
| `GITHUB_OAUTH_CLIENT_SECRET` | 포털 로그인용 GitHub OAuth App의 클라이언트 시크릿. GitHub App의 개인 키와는 다른 값이다. 없으면 로그인이 503 `auth_not_configured`를 반환한다.                                                      |
| `SESSION_SECRET`             | 세션 쿠키에 서명하는 키. 32자 이상의 무작위 문자열이어야 하며, 짧거나 없으면 로그인이 503을 반환하고 모든 요청이 익명으로 처리된다.                                                                  |

## 변수

변수는 비밀이 아니므로 `apps/control/wrangler.jsonc`의 `vars`에 적고 커밋한다. 대시보드에서 바꾼 값은 다음 배포 때 이 파일의 값으로 덮어써지므로 대시보드에서 바꾸지 않는다.

| 이름                     | 내용                                                                                                                                                                                                                                              | 기본값                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `GITHUB_APP_ID`          | GitHub App의 숫자 ID.                                                                                                                                                                                                                             | 빈 값                 |
| `GITHUB_OAUTH_CLIENT_ID` | 포털 로그인용 GitHub OAuth App의 클라이언트 ID(비밀이 아니다). GitHub App의 `GITHUB_APP_ID`와는 다른 앱이다. 빈 값이면 로그인이 503을 반환하고 읽기 API는 익명으로 계속 동작한다.                                                                 | 빈 값                 |
| `RUNS_ENABLED`           | 전체 중지 스위치. 문자열 `true`일 때만 실행을 시작한다. 그 밖의 값이나 빈 값이면 모든 요청을 무시한다.                                                                                                                                            | `false`               |
| `OPERATOR_IDS`           | 실행을 시작할 수 있고, PR 리뷰의 승인이 병합 조건으로 인정되는 GitHub 사용자의 숫자 ID 쉼표 목록(로그인 이름이 아님). 로그인 이름은 바꾸거나 다른 사람이 재사용할 수 있어서 숫자 ID로 확인한다. ID는 `gh api users/<로그인> --jq .id`로 조회한다. | 빈 값(아무도 못 함)   |
| `PROJECTS`               | 실행을 허용할 저장소 `owner/name`의 쉼표 목록. 정확히 일치해야 한다.                                                                                                                                                                              | 빈 값(아무것도 안 됨) |
| `IMPLEMENT_MODEL`        | 구현 에이전트의 모델. 영문자, 숫자, `.`, `_`, `-`만 허용하며 다른 값이면 기본값을 쓴다.                                                                                                                                                           | `claude-sonnet-5-5`   |
| `REVIEW_MODEL`           | 리뷰 에이전트(pi, OpenAI Responses API)의 모델. `IMPLEMENT_MODEL`과 같은 문자 규칙을 따른다. 출구 핸들러는 요청 본문의 `model`이 이 값과 다르면 거부한다.                                                                                         | `gpt-5.4-nano`        |

## 최초 설정 순서

1. D1 데이터베이스 `software-factory`는 2026-11-06에 만들었고 ID는 `wrangler.jsonc`에 있다. 새 환경을 만들 때만 `pnpm exec wrangler d1 create`를 다시 실행한다. 마이그레이션은 배포 워크플로가 적용한다.
2. 시험용 공개 저장소에 GitHub App을 설치한다. 저장소 권한은 Contents, Pull requests, Issues의 쓰기와 3단계를 위한 Checks의 읽기이고, 이벤트는 Issues를 구독한다. 3단계는 새 웹훅 이벤트를 요구하지 않는다. check-runs API가 403을 돌려주면 리뷰가 끝난 실행은 `checks_permission_missing` 코드로 `needs_human`이 된다. 공개 저장소인 시험 저장소에서는 2026-11-06 실제 시험 때 Checks 권한 없이도 체크를 읽고 병합까지 진행했다. 공개 저장소라서 읽힌 것으로 추정하지만 원인은 확인하지 않았다. 비공개 저장소에서 403으로 멈추는지도 아직 시험하지 않았으므로, 비공개 저장소를 관리하기 전에 이 권한을 추가하고 확인한다. 권한을 올리면 설치한 계정이 새 권한을 수락해야 적용된다. 웹훅 주소는 `https://<워커 주소>/api/github/webhook`, 콘텐츠 유형은 `application/json`이다.
3. 위 비밀 값 네 개를 설정하고, 변수 `GITHUB_APP_ID`, `OPERATOR_IDS`, `PROJECTS`를 채우고 `RUNS_ENABLED`를 `true`로 바꿔 커밋한다.
4. main에 병합하면 deploy 워크플로가 D1 마이그레이션을 먼저 적용한 뒤 Worker와 컨테이너 이미지를 배포한다.
5. 허용한 운영자가 시험 저장소의 열린 이슈에 `factory:go` 라벨을 붙인다. 성공하면 `factory/issue-<번호>-<실행 ID>` 브랜치와 `Closes #<번호>`를 본문에 담은 PR이 열리고(병합되면 GitHub가 이슈를 닫는다), 이슈에 PR 링크 코멘트가 달린다.
6. 3단계를 켜려면 시험 저장소의 기본 브랜치에 `.factory/policy.yml`을 사람이 PR로 추가한다. 형식은 `docs/examples/factory-policy.yml`에 있다. 이 파일이 없거나 형식이 틀리면 팩토리는 리뷰를 시작하지 않고 실행을 `needs_human`으로 끝낸다. 이 저장소의 작업은 시험 저장소를 건드리지 않는다.

## 동작 범위와 제한

웹훅은 `issues` 이벤트의 `labeled` 동작에서 라벨이 `factory:go`일 때만 실행을 시작한다. 보낸 사람의 숫자 ID가 `OPERATOR_IDS`에 없거나, 봇이거나, 저장소가 `PROJECTS`에 없으면 202를 반환하고 아무것도 하지 않는다. 같은 `X-GitHub-Delivery`는 한 번만 처리한다. 활성 실행 중 자리를 차지하는 실행이 이미 2개이면 새 요청은 202와 `capacity_full` 코드로 거부하며 실행을 만들지 않는다. 자리를 차지하는 상태는 `queued`, `cloning`, `implementing`, `publishing`, `pr_opened`, `reviewing`, `awaiting_checks`이다. 사람의 승인을 기다리는 `awaiting_approval` 상태의 실행은 샌드박스를 쓰지 않으므로 자리를 차지하지 않는다. 다만 한 이슈에는 종료 상태(`merged`, `needs_human`, `failed`)가 되기 전까지 활성 실행이 하나만 있을 수 있으므로, 승인을 기다리는 이슈에 새 요청을 보내도 새 실행은 만들어지지 않는다. 시간 제한은 에이전트 단계마다 따로 적용한다. 구현 단계(`queued`부터 `publishing`까지)는 시작부터 20분 안에 끝나지 않으면 `timeout` 코드로 `failed`가 되고, 리뷰 단계(`pr_opened`와 `reviewing`)는 PR이 열린 뒤 20분 안에 끝나지 않으면 `timeout` 코드로 `needs_human`이 된다.

에이전트 컨테이너는 인터넷 없이 시작한다. 출구는 샌드박스 단계에 따라 LLM 제공자를 하나만 허용한다. 구현 샌드박스는 `api.anthropic.com`의 `POST /v1/messages`, `POST /v1/messages/count_tokens`만, 리뷰 샌드박스는 `api.openai.com`의 `POST /v1/responses`만 허용하고, 서로의 제공자와 그 키에는 닿지 않는다. 단계가 지정되지 않은 샌드박스는 두 제공자 모두 막힌다. 두 단계 모두 그 실행에 지정된 저장소의 `git-upload-pack` 읽기를 허용한다. 요청 본문은 출구 핸들러가 검사한다. Anthropic 요청은 `model`이 그 실행의 모델과 다르거나, `max_tokens`가 16000을 넘거나 없거나, `mcp_servers` 또는 `container`가 있거나, 도구 중 하나라도 `type`이 `web_search`로 시작하는 서버 측 웹 검색 도구이거나, 본문이 4 MB를 넘으면 403 또는 413으로 거부한다. OpenAI 요청은 `model`이 리뷰 모델과 다르거나, `max_output_tokens`가 있는데 16000을 넘거나, `store`가 `true`이거나, `background`가 `true`이거나, `previous_response_id`, `conversation`, `prompt`가 있거나, `tools`에 `type`이 `function`이 아닌 도구(웹 검색, 파일 검색, 코드 인터프리터, MCP 등)가 있거나, 본문이 4 MB를 넘으면 거부한다. 요청 본문, 프롬프트, 키는 로그에 남기지 않고 거부 사유 코드만 남긴다. `anthropic-beta` 헤더는 허용 목록(`apps/control/src/outbound-body.ts`)에 있는 값만 남긴다. 응답은 읽지 않고 그대로 전달하므로 스트리밍은 유지된다. 에이전트가 보조 호출에도 같은 모델과 출력 한도를 쓰도록 컨테이너 환경변수 `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`를 설정한다. npm 레지스트리는 허용하지 않으므로, 의존성 설치가 필요한 이슈는 실패하거나 코드만 바꾼 PR이 될 수 있다. 이 제한은 공개 전에 다시 정한다.

컨테이너가 보고한 파일 종류와 권한은 신뢰하지 않는다. 모든 파일은 일반 파일(100644)로 게시하고, 기준 커밋의 GitHub 트리에서 이미 실행 가능(100755)인 파일만 그 권한을 유지한다. 기준 트리에서 심볼릭 링크나 서브모듈 위치를 건드리는 변경은 실패 처리한다. 컨테이너가 돌려준 변경 목록은 제어 평면이 신뢰하지 않는 데이터로 검사한다. 변경이 없거나, 파일이 50개나 합계 1 MB(파일당 256 KB)를 넘거나, `.github`, `.git`, `.factory` 경로, 절대 경로, `..`, 심볼릭 링크, 서브모듈, UTF-8이 아닌 경로, 제어 문자나 길이 0 문자와 방향 제어 문자(U+200B-U+200F, U+202A-U+202E, U+2066-U+2069 등)가 경로에 있으면 브랜치를 만들지 않고 실행을 실패 처리한다. 실행 기록은 D1의 `runs`와 `events` 테이블에 쌓이며, 이벤트에는 고정된 사유 코드만 저장하고 에이전트 출력이나 이슈 본문은 저장하지 않는다. 아직 이 기록을 읽는 API는 없다.

## 리뷰와 병합 (3단계)

PR이 열린 실행은 `pr_opened`, `reviewing`, `awaiting_checks`를 거쳐 `merged`가 되거나, 사람의 승인을 기다리는 `awaiting_approval`을 거쳐 `merged`가 된다. 어느 상태에서든 고정된 사유 코드와 함께 `needs_human`(PR이 있는 뒤) 또는 `failed`(PR이 생기기 전)로 끝날 수 있다. 허용되지 않은 전환은 예외를 던진다. 병합한 실행도 다른 전환처럼 `events`에 전환 이벤트를 남긴다. 상태와 사유 코드는 `apps/control/migrations/0003_review_and_merge.sql`이 D1에 추가했다. 이 마이그레이션은 이전에 `pr_opened`로 끝나 있던 실행을 `needs_human`과 `legacy_run`으로 바꾼다. 리뷰 기능이 없던 때 열린 PR이라 사람이 확인해야 하기 때문이다.

### 위험 정책 파일

대상 저장소의 기본 브랜치에 `.factory/policy.yml`을 둔다. 제어 평면은 설치 토큰으로 기본 브랜치 끝 커밋을 먼저 고정한 뒤 그 커밋에서 파일을 읽는다. PR 브랜치의 같은 파일은 읽지 않는다. 형식은 엄격하며 아래 필드만 허용한다. 모르는 키, 중복 키, YAML 별칭, 문서가 둘 이상인 파일, 64 KiB를 넘는 파일은 모두 잘못된 정책이다.

- `requiredChecks`: 1개 이상 50개 이하의 체크 이름 문자열 목록. 이름은 체크 실행(check run)의 이름과 정확히 같아야 한다. 비어 있으면 잘못된 정책이다. 필수 체크가 없는 병합을 허용하지 않기 위해서다.
- `autoMergeTiers`: 사람 승인 없이 병합해도 되는 등급 목록(`T0`, `T1`, `T2`, `T3` 중에서). 코드가 `T3`은 이 목록에 있어도 자동 병합하지 않는다.
- `rules`: 순서가 있는 목록. 각 항목은 `tier`와 `patterns`(글롭 문자열 목록)를 가진다. 첫 번째로 맞는 규칙이 이긴다. 패턴은 대소문자를 구분하지 않으며 `**`는 `/`를 넘고 `*`와 `?`는 넘지 않는다.

PR의 등급은 바뀐 파일 중 가장 높은 등급이다. 어떤 규칙에도 맞지 않는 파일은 `T2`다. 이름이 바뀐 파일은 이전 경로도 함께 본다. `.github/` 또는 `.factory/` 아래 파일은 정책 규칙과 관계없이 최소 `T3`이다. 바뀐 파일 목록은 샌드박스 보고가 아니라 검토한 시점의 GitHub PR 파일 API(쪽 단위 조회)에서 가져온다. 목록이 GitHub가 보고한 파일 개수와 다르거나 3000개를 넘으면 잘렸다고 보고 `files_truncated`로 사람에게 넘긴다. 정책 파일이 없으면 `policy_missing`, 형식이 틀리면 `policy_invalid`로 리뷰를 시작하기 전에 사람에게 넘긴다. PR이 기본 브랜치를 대상으로 하지 않으면 `base_not_default`이다. 예시는 `docs/examples/factory-policy.yml`에 있다.

### 리뷰

리뷰는 구현과 다른 엔진인 pi 1.5.0이 맡는다. 새 샌드박스 ID(`<실행 ID>-review`)로 새 컨테이너를 만들고, PR 헤드 커밋(40자리 SHA)만 가져온다. pi는 읽기 전용 도구(`read,ls,grep,find`)만 쓰고, 세션, 확장, MCP, 스킬, 프롬프트 템플릿, 컨텍스트 파일을 읽지 않으며(`--no-session --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files`) JSON 모드(`--mode json`)로 실행한다. 프롬프트에는 이슈 본문과 PR diff가 각각 구분선으로 둘러싼 신뢰할 수 없는 데이터로 들어간다. 구분선과 같은 문구는 데이터 안에서 무력화한다. diff가 300000자를 넘으면 일부만 보여 주지 않고 `diff_too_large`로 사람에게 넘긴다.

리뷰 결과는 마지막 어시스턴트 메시지 전체가 아래 JSON 객체 하나여야 한다. 코드 펜스 하나는 허용한다. 앞뒤에 다른 글이 있거나, 모르는 필드가 있거나, 길이 제한(요약 2000자, 지적 30개, 지적 메시지 1000자, 파일 300자)을 넘거나, 승인(`approve`)인데 `high` 또는 `critical` 지적이 있으면 결과가 없는 것으로 보고 `review_invalid`로 사람에게 넘긴다. 승인으로 취급하는 경로는 이 검증을 통과한 `approve`뿐이다.

```json
{
  "verdict": "approve",
  "summary": "...",
  "findings": [{ "file": "src/a.ts", "severity": "low", "message": "..." }]
}
```

제어 평면은 결과를 PR에 코멘트 형태의 리뷰로 남긴다. 리뷰어가 쓴 글은 `@` 멘션, `#숫자` 참조, HTML(주석 포함)을 무력화하고 길이를 제한한 뒤 올린다. 이 리뷰는 사람의 승인이 아니라고 본문에 적는다. `changes_requested`는 자동 수정 반복 없이 `needs_human`(`changes_requested`)으로 끝난다.

### 병합 판정

판정은 프로그램(`apps/control/src/decision.ts`의 순수 함수)이 한다. 병합은 다음이 모두 참일 때만 일어난다. (1) PR이 열려 있고 헤드 SHA가 리뷰한 SHA와 같다. 헤드가 한 번이라도 바뀌면 `head_changed`로 사람에게 넘긴다. (2) 리뷰가 그 SHA에서 `approve`였다. (3) `requiredChecks`가 모두 그 SHA의 체크 실행(쪽 단위 조회)으로 존재하고 결론이 `success`다. 진행 중이면 기다리고, 하나라도 성공이 아닌 결론(`failure`, `cancelled`, `timed_out`, `neutral`, `skipped` 등)이면 `check_failed`로 사람에게 넘기며, 아직 나타나지 않았으면 30분 제한까지 기다린다. 같은 이름의 체크 실행이 여럿이면 모두 성공이어야 한다. (4) 등급이 `autoMergeTiers`에 있고 `T3`이 아니거나, `OPERATOR_IDS`의 숫자 ID를 가진 사용자가 바로 그 헤드 SHA에 승인(`APPROVED`) 리뷰를 남겼다. 다른 SHA에 남긴 승인은 인정하지 않는다. (5) 운영자 중 누구라도 마지막 리뷰가 변경 요청(`CHANGES_REQUESTED`)이면 등급과 관계없이 `operator_changes_requested`로 사람에게 넘긴다. PR 작성자 본인의 승인과 봇 계정의 승인은 세지 않는다. 작성자는 팩토리 봇이다.

병합은 `PUT /pulls/{번호}/merge`에 `merge_method: squash`와 `sha`(검토한 헤드)를 실어 한 번만 호출한다. 강제 병합이나 보호 규칙 우회는 하지 않는다. GitHub가 405를 주면 `merge_refused`, 409를 주면 `merge_conflict`로 사람에게 넘긴다. 병합 호출의 응답을 받지 못한 채 GitHub에서 병합이 끝난 경우, 다음 확인에서 병합된 PR을 `merged`로 기록한다.

### 시간 제한과 확인 주기

폴링은 Durable Object 알람으로 한다. `awaiting_checks`는 30초마다 확인하고 30분이 지나면 `checks_timeout`으로 `needs_human`이 된다. `awaiting_approval`은 1분에서 시작해 두 배씩 늘려 15분까지 간격을 늘리며 확인하고, 7일이 지나면 `approval_timeout`으로 `needs_human`이 된다. 운영자가 승인한 뒤 병합까지는 최대 15분 걸릴 수 있다. 새 웹훅 이벤트는 쓰지 않는다. 승인을 기다리는 동안 샌드박스는 이미 모두 삭제되어 있다. 구현 샌드박스는 PR이 열릴 때, 리뷰 샌드박스는 리뷰가 끝날 때 삭제하며, 어떤 종료 경로에서도 남은 샌드박스를 삭제한다. 삭제가 실패하면 알람이 다시 시도하고 5번째 실패를 `cleanup_failed`로 기록한다.

### 멈춘 실행을 이어서 처리하는 방법

실행이 끝난 뒤의 조치는 끝난 상태에 따라 다르다. `needs_human`으로 끝난 실행은 PR이 이미 있으므로, PR을 승인해도 팩토리가 병합하지 않고 같은 이슈에 `factory:go`를 다시 붙여도 새 실행을 만들지 않는다(`start()`가 `already_done`을 돌려준다). 사람이 PR을 직접 병합하거나 닫아야 하고, 팩토리에 다시 맡기려면 새 이슈를 만든다. `failed`로 끝난 실행은 PR이 만들어지기 전에 끝났으므로, 라벨을 뗐다가 다시 붙이면 같은 이슈에서 새 실행이 시작된다. 포털의 실행 화면은 이 구분과 사유 코드에 따라 운영자가 할 일을 보여 준다(`apps/portal/src/labels.ts`의 `describeNextStep`).

### 고정 사유 코드

3단계가 추가한 코드는 다음과 같다. 이벤트에는 이 코드만 저장하고 리뷰어의 글, 정책 파일 내용, 체크 출력은 저장하지 않는다.

| 코드                               | 뜻                                                          |
| ---------------------------------- | ----------------------------------------------------------- |
| `legacy_run`                       | 리뷰 기능이 없던 때 열린 PR이거나 필요한 정보가 없는 실행   |
| `pr_closed`                        | PR이 병합되지 않은 채 닫힘                                  |
| `merged_outside_factory`           | 사람이 팩토리를 거치지 않고 직접 병합함. 남은 조치는 없음   |
| `base_not_default`                 | PR의 대상 브랜치가 기본 브랜치가 아님                       |
| `head_changed`                     | PR 헤드가 팩토리가 만든 커밋과 달라짐                       |
| `policy_missing`, `policy_invalid` | 정책 파일이 없거나 형식이 틀림                              |
| `files_truncated`                  | PR 파일 목록이 잘렸을 수 있음                               |
| `diff_too_large`                   | diff가 너무 커서 전부 보여 줄 수 없음                       |
| `review_failed`, `review_invalid`  | 리뷰어가 실패했거나 유효한 결과를 내지 않음                 |
| `changes_requested`                | 리뷰어가 변경을 요청함                                      |
| `check_failed`, `checks_timeout`   | 필수 체크가 성공하지 못했거나 30분 안에 끝나지 않음         |
| `checks_permission_missing`        | GitHub App에 Checks 읽기 권한이 없음 (check-runs API가 403) |
| `operator_changes_requested`       | 운영자가 변경을 요청함                                      |
| `approval_timeout`                 | 7일 안에 승인이 없음                                        |
| `merge_refused`, `merge_conflict`  | 병합 API가 405 또는 409를 줌                                |

## 포털과 로그인 (4단계)

### 구성과 역할

control Worker(`software-factory-control`)는 `/api/*` 요청을 직접 처리하고, 그 밖의 경로는 `apps/portal`을 빌드한 정적 파일로 응답한다. 포털은 주소 표시줄의 경로(`/projects`, `/runs/<ID>` 등)로 화면을 정하므로, 정적 파일이 없는 경로도 `index.html`로 응답하는 SPA 설정(`not_found_handling`)을 그대로 쓴다.

역할은 세 가지이며 요청마다 계산한다. 세션 쿠키가 없거나 서명이 맞지 않거나 만료되었으면 익명이다. 유효한 세션이 있고 그 GitHub 숫자 ID가 변수 `OPERATOR_IDS`에 없으면 옵저버이고, 있으면 운영자다. 역할은 쿠키에 넣지 않는다. 그래서 `OPERATOR_IDS`에서 ID를 빼고 배포하면 그 사람의 기존 쿠키도 다음 요청부터 운영자 권한을 잃는다. 읽기 API는 세 역할 모두에게 열려 있다. 읽는 내용이 `PROJECTS`에 적힌 공개 시험 저장소의 실행 기록과 고정 코드뿐이기 때문이다. 쓰기 API는 운영자만 쓸 수 있다. 읽기 API는 익명에게도 열려 있으므로 `PROJECTS`에는 공개 저장소만 적어야 한다. 비공개 저장소를 적으면 그 저장소의 실행 목록, 이슈 번호, 이벤트 시각이 누구에게나 보인다.

### GitHub OAuth App 만들기

로그인은 기존 GitHub App(웹훅과 PR 작업용)과 별개인 **OAuth App**으로 처리한다. OAuth App은 일반 로그인에서 사용자의 신원(숫자 ID와 로그인 이름)을 확인하는 데만 쓰며 권한 범위(scope)를 요청하지 않는다. 예외는 운영자의 PR 승인 흐름 하나이며, 그 흐름은 `public_repo`를 요청한다(아래 "콘솔" 절). GitHub 토큰은 저장하지 않는다. 사람이 다음 순서로 만든다.

1. GitHub의 Settings, Developer settings, OAuth Apps에서 New OAuth App을 선택한다. 이 저장소의 조직(`roboco-io`) 소유로 만들려면 조직의 설정에서 같은 메뉴를 쓴다.
2. Application name은 임의로 정한다. Homepage URL에는 Worker 주소 `https://<Worker 주소>`를 적는다. Worker 주소는 `https://software-factory-control.<계정 서브도메인>.workers.dev` 형태이며, 배포 워크플로의 변수 `WORKERS_SUBDOMAIN`과 같은 서브도메인이다.
3. Authorization callback URL에 `https://<Worker 주소>/api/auth/callback`을 적는다. OAuth App은 콜백 주소를 하나만 등록할 수 있다. 로컬 개발이나 다른 주소를 쓰려면 OAuth App을 따로 만든다. Device Flow는 켜지 않는다.
4. 만든 뒤 화면에 나오는 Client ID를 `apps/control/wrangler.jsonc`의 변수 `GITHUB_OAUTH_CLIENT_ID`에 적어 커밋한다. 이 값은 비밀이 아니다.
5. 같은 화면에서 Generate a new client secret으로 시크릿을 만들고, `apps/control` 디렉터리에서 `pnpm exec wrangler secret put GITHUB_OAUTH_CLIENT_SECRET`를 실행해 표준 입력으로 넣는다.
6. 세션 서명 키는 `openssl rand -base64 48 | pnpm exec wrangler secret put SESSION_SECRET`로 넣는다. 값이 명령 인자에 나타나지 않는다. 이 값을 바꾸면 이미 발급된 모든 세션이 무효가 되어 모두 다시 로그인해야 한다.

세 값 중 하나라도 비어 있거나 `SESSION_SECRET`이 32자보다 짧으면 `GET /api/auth/login`과 `GET /api/auth/callback`은 503과 `{"error":"auth_not_configured"}`를 돌려준다. 이때도 읽기 API와 포털은 익명으로 동작한다. 포털의 로그인 버튼은 먼저 이 상태를 확인하고, 설정이 없으면 JSON 오류 화면으로 이동하는 대신 안내 문구를 보여 준다.

### 로그인 흐름

`GET /api/auth/login`은 무작위 `state`와 PKCE `code_verifier`를 만들어 짧은 수명(10분)의 쿠키 `__Host-oauth`에 넣고, `state`와 `code_challenge`(S256)만 붙여 GitHub의 승인 화면으로 보낸다. 로그인에서 `scope`는 보내지 않는다. 콜백 `GET /api/auth/callback`은 쿼리의 `state`와 쿠키의 `state`를 모든 바이트를 끝까지 비교하는 방식(처음 다른 곳에서 멈추지 않음)으로 확인하고, 일치하면 코드를 토큰으로 바꿔 GitHub의 `/user`를 한 번 호출한다. 응답에서 숫자 `id`와 `login`만 꺼내고 토큰은 버린다. 토큰은 저장, 로그, 응답 어디에도 남지 않는다. 응답 모양이 기대와 다르거나(숫자 ID가 아니거나 로그인 이름의 형식이 틀리는 등) 어떤 단계든 실패하면 `/?login=failed`로 이동하며, 실패 이유는 고정된 이름(`denied`, `bad_request`, `state_mismatch`, `token_exchange`, `profile`, `unexpected`)으로 로그에만 남긴다. 사용자 화면과 주소에는 이유가 나타나지 않는다.

세션은 서버에 저장하지 않는다. `id`, `login`, 만료 시각 세 값을 HMAC-SHA256으로 서명한 문자열이 쿠키 `__Host-session`(HttpOnly, Secure, SameSite=Lax, Path=/, Domain 없음)에 담기며 7일 뒤 만료된다. 만료 시각은 서명된 내용 안에 있어 쿠키를 고쳐서 늘릴 수 없다. 로그아웃(`POST /api/auth/logout`)은 쿠키를 지우지만, 서버에 세션 목록이 없으므로 이미 복사된 쿠키는 만료 시각까지 유효하다. 즉시 모든 세션을 끊으려면 `SESSION_SECRET`을 바꾼다. 로그인은 GitHub 쪽에 승인 기록(OAuth App 권한 부여)을 남기며, 사용자는 GitHub 설정의 Applications에서 직접 취소할 수 있다. 우리 쪽에서는 이 기록을 지우지 않는다.

`__Host-` 접두사 쿠키는 Secure여야 하므로 `https`가 아닌 주소에서는 일부 브라우저가 저장하지 않는다. `localhost`는 Chrome 계열에서 동작하지만 Safari에서는 로그인이 되지 않을 수 있다.

### API

모든 응답은 `Cache-Control: no-store`이고 JSON이다. 경로와 메서드, 최소 역할은 `apps/control/src/routes.ts`의 경로 표(`ROUTES`) 한 곳에 선언하며, 처리기가 아니라 분배 코드가 표를 보고 메서드(405), 역할(익명 401, 부족하면 403), 출처(403)를 먼저 검사한다. 표에 없는 경로는 404다. 경로 매개변수는 표에서 선언한 정규식을 통과해야 하며, 퍼센트 인코딩된 `/`나 `.`은 통과하지 못해 404가 된다.

| 경로                              | 메서드 | 최소 역할 | 내용                                                                                                                                                                                                                                                                           |
| --------------------------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/api/health`                     | GET    | 익명      | 상태 확인                                                                                                                                                                                                                                                                      |
| `/api/me`                         | GET    | 익명      | `{role, login?}`                                                                                                                                                                                                                                                               |
| `/api/projects`                   | GET    | 익명      | `PROJECTS`의 저장소별 실행 수(진행 중, 병합됨, 사람 확인 필요, 실패)                                                                                                                                                                                                           |
| `/api/projects/:owner/:repo/runs` | GET    | 익명      | 그 저장소의 실행 목록(각 실행에 `path` 포함). `PROJECTS`에 없으면 404. 새 것부터, `limit`(기본 20, 최대 50)과 `cursor`로 쪽 나누기                                                                                                                                             |
| `/api/runs/:id`                   | GET    | 익명      | 실행과 이벤트(순서대로). 실행의 `path`는 지나온 상태와 시각의 목록이다. `cost.tokens`는 구현과 리뷰로 나눈 토큰 수이고, 사용 기록이 없으면 `null`이다. 단가를 모르는 모델이 있어 비용이 `unknown`이어도 토큰 수는 나온다. 모르는 ID이거나 저장소가 `PROJECTS`에서 빠졌으면 404 |
| `/api/runs/:id/stop`              | POST   | 운영자    | 활성 실행의 중지를 요청(202)                                                                                                                                                                                                                                                   |
| `/api/runs/:id/review`            | POST   | 운영자    | 승인 또는 수정 요청을 시작한다. GitHub 승인 화면의 주소를 돌려준다(아래 "콘솔" 절)                                                                                                                                                                                             |
| `/api/auth/login`, `/callback`    | GET    | 익명      | 로그인 시작과 완료                                                                                                                                                                                                                                                             |
| `/api/auth/logout`                | POST   | 익명      | 내 쿠키만 지움. 이 경로와 웹훅만 운영자가 아니어도 POST할 수 있고, 시험이 이 두 경로 외에 낮은 역할의 쓰기 경로가 없음을 확인한다                                                                                                                                              |
| `/api/github/webhook`             | POST   | 서명      | GitHub 웹훅. 세션이 아니라 HMAC 서명으로 확인한다                                                                                                                                                                                                                              |

읽기 API의 응답 필드는 코드에서 하나씩 나열한 목록(`apps/control/src/read-repo.ts`)이며, 실행은 `id, repo, issueNumber, state, reasonCode, prNumber, title, tier, headSha, cost, createdAt, updatedAt`, 이벤트는 `id, ts, kind, fromState, toState, reasonCode`뿐이다. 저장된 사유 코드가 고정 코드 목록에 없으면 `null`로 바꿔 보낸다. 이슈 본문, 에이전트 출력, 토큰은 D1에 저장하지 않으므로 어떤 응답에도 나타나지 않는다. 이슈 제목은 콘솔 기능 이후 `title`로 저장되며 데이터로만 취급한다(포털은 텍스트 노드로만 그린다).

상태를 바꾸는 요청(POST)은 `SameSite=Lax` 쿠키에 더해 `Origin` 헤더가 요청 주소의 출처와 정확히 같아야 한다. 헤더가 없거나 다르면 로그인한 운영자여도 403 `bad_origin`이다. 웹훅은 GitHub가 `Origin`을 보내지 않으므로 이 검사에서 빠지고 서명으로 확인한다.

### 실행 중지

중지는 즉시 적용되는 명령이 아니라 **요청**이며, 실행 상태를 바꾸는 쪽은 언제나 Durable Object의 알람 하나뿐이다. 운영자가 포털의 실행 화면에서 `실행 중지`를 확인하면 `POST /api/runs/:id/stop`이 호출된다. API는 D1에서 실행 ID로 저장소와 이슈 번호를 찾고 저장소가 `PROJECTS`에 있는지만 확인한다. 중지할 수 있는지 판단은 D1이 아니라 항상 실행을 맡은 Durable Object(이름은 `<저장소>#<이슈 번호>`)의 `stop(<실행 ID>)`에 물어서 한다. 그래서 중지 요청이 중간에 끊겨 다시 보내도 첫 호출과 같은 답을 받는다.

`stop()`은 상태 전환도 D1 기록도 하지 않는다. 실행 객체와 별개인 저장소 키 `stop_requested`에 실행 ID를 적고 알람을 지금으로 당긴 뒤 답한다. 별개 키를 쓰는 이유는, 알람이 이미 읽어 둔 이전 사본의 실행 객체를 나중에 저장해도 요청이 지워지지 않게 하기 위해서다. 알람은 매번 시작할 때 이 키가 자기 실행의 ID인지 보고, 맞으면 다른 이유로 멈출 때와 같은 종료 처리를 한다. 따라서 PR이 만들어진 뒤라면 `needs_human`, 만들어지기 전이면 `failed`로 끝나며 사유 코드는 둘 다 `stopped_by_operator`다. 샌드박스 삭제와 알람 해제도 같은 경로로 처리한다. 다른 실행의 ID가 적힌 키는 무시하고, 새 실행을 시작할 때는 키를 비운다. `failed`로 끝난 이슈는 라벨을 다시 붙이면 새 실행이 시작된다. 길게 기다리는 상태(승인 대기는 최대 15분 간격)나 오류 뒤 재시도 중인 상태에서도, 알람이 끝날 때마다 요청이 남아 있으면 알람을 지금으로 당기므로 다음 확인을 기다리지 않는다. 다만 알람이 오류로 끝났을 때(예: D1 장애로 종료 처리를 기록하지 못함)는 지금이 아니라 30초 뒤로 잡아 계속 도는 것을 막고, 원래 오류는 그대로 다시 던진다. 병합 표시가 먼저 저장되어 요청이 409로 거부되면 남은 요청 키는 지운다. 병합 호출이 일시적으로 실패해 다시 시도할 때는 이미 거부된 요청이 있어도 병합을 이어 간다.

API 응답은 다음과 같다. 요청을 받았으면 202 `{"status":"stop_requested"}`이다. 이 응답은 실행이 멈췄다는 뜻이 아니다. 포털은 "중지 요청됨"이라고 표시하고 실행을 다시 읽으며, 실행의 상태가 끝난 상태로 바뀐 것을 확인한 뒤에야 중지된 것으로 보여 준다. 이미 끝난 실행은 409 `not_active`, 병합 요청을 GitHub에 이미 보냈으면 409 `merge_attempted`, 객체가 모르는 실행이면 404다. 운영자가 아니면 Durable Object를 호출하기 전에 401 또는 403으로 거부한다.

되돌릴 수 없는 일은 되돌리지 않는다. 요청이 오기 전에 시작된 PR 게시는 끝까지 진행되어 PR이 남고, 실행은 그 PR 번호를 기록한 채 `needs_human`으로 끝난다. 이미 열린 PR은 닫지 않는다. 병합은 요청을 GitHub에 보내기 직전에 상태 기계가 "병합을 시도했다"는 표시를 저장하는데, 알람은 그 표시를 쓰기 직전에 `stop_requested` 키를 다시 읽는다. 요청이 먼저 있었다면 병합하지 않고 `needs_human`으로 끝낸다. 표시가 먼저 저장되었다면 요청은 409 `merge_attempted`로 거부되고 실행은 병합된 상태로 끝난다. 두 쪽이 거의 동시에 일어나는 경우의 순서는 Durable Object가 저장소 작업 중에 새 이벤트를 받지 않는 성질에 기대며, 이 성질은 실제 Workers 런타임에서 확인하지 못했다.

### 마이그레이션 0005

`apps/control/migrations/0005_stopped_by_operator.sql`은 `events` 테이블의 `reason_code` CHECK 제약에 `stopped_by_operator`를 더한다. SQLite는 CHECK 제약을 바꿀 수 없어 0004와 같은 방식으로 테이블을 다시 만든다. 기존 행과 이벤트 ID는 그대로 복사하고, 추가만 가능하게 하는 트리거(`events_no_update`, `events_no_delete`)와 인덱스 `events_by_run`을 다시 만든다. `runs` 테이블은 바꾸지 않는다. 배포 워크플로가 Worker 배포보다 먼저 적용하므로 새 Worker가 아직 없는 제약에 부딪히는 일은 없다. 마이그레이션은 되돌릴 수 없으니, 적용 뒤 이 Worker 버전을 이전 버전으로 되돌려도 테이블은 새 제약을 유지한다(이전 Worker가 쓰던 코드는 모두 새 제약에서 허용된다).

### 포털의 보안 헤더

`apps/portal/public/_headers`가 정적 파일 응답에 `Content-Security-Policy`(`default-src 'self'`, 인라인 스크립트와 스타일 없음, `frame-ancestors 'none'` 등), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`를 붙인다. Vite가 이 파일을 `dist`로 복사하고, Workers 정적 자산 계층이 `dist/_headers`를 읽어 적용한다. 포털 코드는 서버 데이터를 `textContent`로만 화면에 넣고 HTML 문자열을 쓰지 않으며(시험이 소스에서 금지 패턴을 검사한다), 인라인 스타일과 이벤트 속성도 쓰지 않는다. Vite 설정(`assetsInlineLimit: 0`)은 자산이 `data:` 주소로 스크립트에 들어가지 않게 한다. API 응답은 Worker가 만들므로 `_headers`가 적용되지 않으며 `X-Content-Type-Options: nosniff`만 직접 붙인다.

`_headers`가 배포된 Worker에서 실제로 적용되는지는 이 작업에서 확인하지 못했다. 배포 직후 `curl -sI https://<Worker 주소>/`와 `curl -sI https://<Worker 주소>/runs/x`를 실행해 두 응답에 `content-security-policy` 헤더가 있는지 사람이 확인해야 한다. 없으면 포털은 CSP 없이 서비스되는 것이다.

### 이 단계에서 확인한 것과 확인하지 못한 것

2026-11-06에 확인한 것은 다음과 같다.

- 가짜 GitHub와 메모리 D1(실제 SQL과 마이그레이션 사용)로 시험했다. 시험은 경로 표를 순회하며 모든 쓰기 경로가 익명(401), 옵저버(403)를 거부하고 부작용이 없음, 잘못된 메서드(405), 위조, 변조, 만료, 다른 키로 서명한 쿠키는 익명으로 처리됨, 옵저버가 서명된 쿠키 안에 역할 필드를 넣어도 권한이 오르지 않음, 다른 출처는 운영자도 거부됨, 운영자는 중지할 수 있음, 운영자 목록에서 빼면 같은 쿠키가 즉시 거부됨을 확인한다. 쓰기 경로 중 운영자 전용이 아닌 것이 새로 생기면 실패하는 시험도 있다. 토큰과 클라이언트 시크릿이 로그와 응답에 나타나지 않는지, 응답에 허용 목록에 없는 필드가 없는지도 시험한다.
- 상태 기계의 중지는 가짜 저장소와 가짜 GitHub로 시험했다. PR 게시 중의 요청, 체크 조회 중의 요청, 병합 요청이 이미 간 뒤의 요청, 느린 D1 전환 중의 요청, 샌드박스 시작 중의 요청, 오류 뒤 재시도 중의 요청, PR이 생기기 전에 중지한 뒤의 새 실행, 중복 요청의 일관된 응답이다.
- `wrangler dev --local`로 같은 정적 자산 설정을 실행해 `_headers`의 CSP가 `/`와 SPA 대체 경로 응답에 붙는 것을 확인했다. 가짜 API를 붙인 포털을 앱 안 브라우저에서 열어 CSP 위반 없이 그려지고, 375픽셀 너비에서 가로 스크롤이 없고, 재생 버튼이 동작하는 것을 확인했다.
- `pnpm check`와 `wrangler deploy --dry-run`이 통과했다.

확인하지 못한 것은 다음과 같다.

- **실제 GitHub OAuth 왕복.** 로그인과 콜백은 가짜 `fetch`로만 시험했다. GitHub의 실제 응답 모양, OAuth App이 `code_verifier`를 받아 PKCE를 검증하는지(받지 않아도 흐름은 동작하지만 PKCE 보호는 없다), 콜백 주소 설정은 OAuth App을 만든 뒤 사람이 한 번 로그인해 확인해야 한다.
- 실제 Durable Object를 거치는 중지. `IssueRun.stop`은 `blockConcurrencyWhile`로 상태 기계를 부르는 얇은 래퍼이며 Workers 런타임에서는 실행해 보지 못했다. 상태 기계는 가짜 저장소로 시험했다.
- 프로덕션 D1에 0005를 적용한 결과. 시험은 메모리 SQLite에서 했다.
- 배포된 Worker가 `_headers`를 적용하는 것. 같은 설정의 로컬 실행으로만 확인했다.
- 실제 `workers.dev` 주소에서 `__Host-` 쿠키가 저장되고 로그인 뒤 역할이 바뀌는 것, Safari와 모바일 브라우저의 동작.
- 실행 목록 조회는 `runs` 테이블에 `(repo, created_at)` 인덱스가 없어 저장소의 행을 훑는다. 현재 규모에서는 문제가 없다고 보지만 실측하지 않았다.

## 콘솔: 승인, 비용 (4단계 이후)

이 절은 2026-11-07 기준 코드가 하는 일을 적는다. 모두 가짜 GitHub와 메모리 D1로 시험했고 실제 서비스에서는 해 보지 않았다.

### 승인과 수정 요청

`POST /api/runs/:id/review`는 운영자만 호출할 수 있고, 본문은 `{"action": "approve" | "request_changes", "headSha": "<커밋>"}` 형식의 JSON이다. 실행이 `PROJECTS`의 저장소에 속하고 상태가 `awaiting_approval`이며 `headSha`가 저장된 PR 머리 커밋과 같을 때만 진행한다. 아니면 404, 409 `not_awaiting_approval`, 409 `head_changed`를 돌려준다. 진행하면 요청 내용(실행 ID, 동작, 커밋, 운영자 ID, 만료)을 서명한 쿠키 `__Host-review`(10분)에 담고, 로그인과 같은 PKCE 흐름의 GitHub 승인 화면 주소를 `{"redirect": ...}`로 돌려준다. 이때 요청하는 권한 범위가 `public_repo`다.

운영자가 GitHub에서 허용하면 기존 콜백 `GET /api/auth/callback`이 `state`를 쿠키와 대조한 뒤 리뷰를 마무리한다. 로그인한 사람이 요청한 운영자와 같은지, 여전히 `OPERATOR_IDS`에 있는지, 실행이 여전히 승인 대기이며 머리 커밋이 같은지를 확인하고, GitHub에서 PR의 현재 머리 커밋을 다시 읽어 한 번 더 비교한다. 모두 맞으면 운영자의 토큰으로 PR 리뷰(`APPROVE` 또는 `REQUEST_CHANGES`)를 남긴다. 리뷰 본문은 코드에 고정된 문장이며 요청의 내용은 들어가지 않는다. 결과는 `/runs/<ID>?review=<결과>`로 이동해 알리며 결과는 `ok`, `stale`, `denied`, `failed` 중 하나다. 이유는 고정된 이름으로 로그에만 남는다.

사용자 토큰은 이 콜백 요청 하나의 변수에만 있고 저장하지 않으며 로그, 응답, 주소에도 남기지 않는다. 승인 흐름에서만 `public_repo`를 요청하므로, 비공개 저장소의 PR에는 리뷰를 남기지 못하고 `failed`로 끝난다. 병합 여부는 이 API가 정하지 않는다. 남긴 리뷰를 3단계의 판정이 GitHub에서 읽어 반영한다.

### 비용 측정과 표시

출구 핸들러는 허용된 모델 응답을 둘로 나누어, 한쪽은 그대로 에이전트에 돌려주고 다른 쪽에서 토큰 수(입력, 출력, 캐시 읽기, 캐시 쓰기)를 읽어 D1의 `run_usage` 표에 단계와 모델별로 기록한다. 측정이나 기록이 실패해도 응답은 바뀌지 않고, 실패 종류만 로그에 남는다. 읽기 API는 실행마다 `cost`(`status`, `totalUsd`, `implementUsd`, `reviewUsd`)를, 프로젝트 목록은 저장소마다 `attention`(사람이 확인할 실행 수)과 `costUsd`를 돌려준다. `status`는 기록이 없으면 `not_measured`, 단가가 없는 모델이 있으면 `unknown`(합계는 `null`), 모두 단가가 있으면 `measured`다. `attention`은 `awaiting_approval` 실행과, 최근 7일 안에 바뀐 `needs_human` 또는 `failed` 실행의 수다.

단가는 `apps/control/src/pricing.ts`에 있고 2026-11-07에 공급사 문서에서 읽었다(100만 토큰당 달러). `claude-sonnet-5-5`는 입력 2, 출력 10, 캐시 읽기 0.10, 캐시 쓰기 2.50이고, `gpt-5.4-nano`는 입력 0.20, 출력 1.25, 캐시 읽기 0.02, 캐시 쓰기 0.20이다. 공급사가 단가를 바꾸면 이 파일을 사람이 고쳐야 하며 자동으로 갱신하지 않는다. 월 예산 한도, 지출 예약, 엔진 전환은 아래 "예산과 엔진 전환 (5단계)" 절에 있다.

### 마이그레이션 0006

`apps/control/migrations/0006_console.sql`은 `runs` 표에 `title`, `tier`, `head_sha` 열을 더하고 `run_usage` 표와 `run_id` 인덱스를 만든다. 기존 행의 새 열은 `NULL`이다. 사람이 할 일은 배포 전에 이 파일이 배포 워크플로의 D1 마이그레이션 적용에 포함되는지 확인하고, 배포 뒤 프로덕션 D1에 적용됐는지 확인하는 것이다. 적용 결과는 아직 확인하지 않았다.

### 확인하지 못한 것

- 실제 저장소의 PR에 실제 운영자 계정으로 승인 또는 수정 요청을 남기는 것.
- 조직이 OAuth App의 접근을 제한하는 경우(조직의 OAuth App 접근 제한)에 승인이 어떻게 실패하는지.
- workerd에서 실제 모델 스트림을 읽어 토큰 수를 기록하는 것. 시험은 가짜 스트림으로 했다.
- 프로덕션 D1에 0006을 적용한 결과.

## 예산과 엔진 전환 (5단계)

이 절은 2026-11-08 기준 코드가 하는 일을 적는다. 모두 가짜 사용량, 가짜 GitHub, 메모리 D1로 시험했고 실제 서비스에서는 해 보지 않았다. 설계상의 이유는 `docs/design.md`의 "5단계 구현 상태"에 있다.

### 변수

| 변수                       | 기본값                                | 뜻                                                      |
| -------------------------- | ------------------------------------- | ------------------------------------------------------- |
| `BUDGET_ANTHROPIC_USD`     | `50`                                  | Anthropic 계정의 월 예산(달러, 추정)                    |
| `BUDGET_OPENAI_USD`        | `50`                                  | OpenAI 계정의 월 예산(달러, 추정)                       |
| `RUN_BUDGET_USD`           | `5`                                   | 실행 하나가 한 계정에서 쓸 수 있는 최대 금액            |
| `FALLBACK_IMPLEMENT_MODEL` | `gpt-6.1-terra`                       | Anthropic이 상한에 도달했을 때 Codex가 구현에 쓰는 모델 |
| `ANTHROPIC_REVIEW_MODEL`   | `claude-haiku-5-5`                    | Anthropic에서 리뷰하는 모델                             |
| `FACTORY_REPO`             | `roboco-io/the-software-factory-demo` | 예산 소진 이슈를 등록할 저장소                          |

잘못된 금액은 기본값으로 바뀐다. 모델은 `pricing.ts`에 단가가 있어야 한다. 단가가 없는 모델은 출구 핸들러가 호출을 거부하므로 그 엔진의 실행은 실패한다. `gpt-6.1-terra`(입력 1, 캐시 입력 0.05, 출력 5)와 `claude-haiku-5-5`의 단가는 2026-11-08에 공급사 문서에서 읽었다. `claude-haiku-5-5`는 프롬프트가 10만 토큰을 넘으면 비싸지는데, 추정이 작아지지 않도록 비싼 쪽 단가(입력 0.50, 출력 2.50, 캐시 읽기 0.05, 캐시 쓰기 0.625)를 모든 호출에 쓴다.

### 동작

- 청구 주기는 UTC 달력 월이다. 실제 구독의 청구일과 다르면 경계 근처에서 오차가 생긴다.
- 출구 핸들러는 모델 호출 전에 실행 상한과 월 상한을 확인한다. 거부 응답은 402 `run_budget_exceeded`, 402 `monthly_budget_exceeded`, 402 `model_not_priced`, 403 `no_run_bound`(실행 ID가 없는 샌드박스), 503 `budget_unavailable`(D1을 읽지 못함)이다. 이전에는 실행 ID가 없는 샌드박스의 호출을 측정 없이 통과시켰으나 이제 거부한다.
- 웹훅은 새 실행을 거절할 때 202와 함께 `budget_exhausted`(두 계정 모두 상한) 또는 `budget_reserved`(진행 중인 실행이 예산을 잡고 있음)를 돌려준다.
- `GET /api/budget`은 로그인 없이 읽을 수 있고, 청구 주기, 실행 상한, 모드(`normal`, `single_engine`, `paused`), 계정별 월 상한과 추정 지출을 돌려준다. 포털은 모드가 `normal`이 아니면 모든 화면 위에 안내를 표시한다.
- 실행 상태 `awaiting_engine`은 리뷰 엔진을 기다리는 상태다. 운영자는 이 상태의 실행을 포털에서 중지할 수 있고, 중지하면 `needs_human`으로 끝난다.
- 새 사유 코드는 `budget_exceeded`(실행 또는 계정의 상한 때문에 에이전트가 끝내지 못함)와 `engine_wait_timeout`(35일 넘게 리뷰 엔진을 기다림)이다.

### 사람이 할 일

예산 소진 이슈를 등록하려면 GitHub App(`roboco-software-factory-control`)이 `FACTORY_REPO` 저장소에 설치되어 있고 Issues 쓰기 권한이 있어야 한다. 2026-11-08 기준으로 이 권한과 설치 여부는 확인하지 않았다. 권한이 없으면 이슈 등록이 실패하고 실패 종류만 로그(`budget_alert_failed`)에 남으며, 다음 확인 때 다시 시도한다. 컨테이너 이미지에는 Codex CLI 0.166.0이 추가되므로 배포 때 이미지가 다시 빌드된다.

### 마이그레이션 0007

`apps/control/migrations/0007_budget.sql`은 `runs`와 `events`에 새 상태와 사유 코드를 허용하도록 두 표를 다시 만들고, `runs`를 참조하는 `run_usage`도 함께 다시 만든다. 행과 ID는 그대로 옮긴다. `runs`에 `implement_model`, `review_model`, `single_engine` 열을, `run_usage`에 `ts` 인덱스를, 새 표 `budget_alerts`를 더한다. 0007 전에 시작한 실행은 `implement_model`이 비어 있어 예약에 세지 않는다. 배포 전에 이 파일이 D1 마이그레이션 적용에 포함되는지, 배포 뒤 프로덕션 D1에 적용됐는지 사람이 확인해야 한다.

### 확인하지 못한 것

- Codex CLI 0.166.0이 컨테이너에서 출구 핸들러를 거쳐 실제로 동작하는지. 플래그는 로컬 `codex exec --help`에서 확인했다. Codex가 보내는 요청 본문은 확인하지 않았다. 출구 핸들러는 함수 도구만 허용하므로 Codex가 `custom`이나 `local_shell` 도구, 16000을 넘는 `max_output_tokens`, `store: true`를 보내면 거부되고 실행은 `agent_failed`로 끝난다. 이 경우 허용 범위를 넓힐지는 실제 요청을 보고 정해야 한다. Codex가 다른 호스트(통계, 업데이트 확인)에 접속하려 하면 출구 핸들러가 거부한다.
- Codex가 `CODEX_API_KEY` 자리 값으로 `api.openai.com/v1/responses`에 요청하는지.
- pi 1.5.0이 `--provider anthropic`으로 Anthropic에 리뷰 요청을 보내는 동작.
- 실제 청구액과 추정 지출의 차이. 그리고 0단계부터 남은 질문인, API 호출이 구독 크레딧에서 차감되는지(설계 문서 8절).
- 두 실행이 동시에 시작할 때 예약 확인이 서로를 보지 못하는 경우. 이때 초과분은 출구 핸들러의 상한 확인으로 제한된다.
- GitHub App으로 예산 소진 이슈를 실제로 등록하는 것.

## 실서비스에서 아직 확인하지 않은 것

2026-11-06 기준으로 아래 항목은 실제 Cloudflare, GitHub, Anthropic 서비스에서 실행해 보지 못했다. 단위 시험은 가짜 구현으로 통과했다.

- `ctx.exports.Outbound({ props })`로 실행별 저장소를 출구 핸들러에 넘기는 동작
- 컨테이너 안에서 `git clone`, Claude Code 실행, 변경 목록 수집 스크립트의 동작 (변경 목록 수집 스크립트는 로컬 git 저장소로 시험했다)
- GitHub App 설치 토큰 발급과 Git Data API 호출
- 핀 고정한 Claude Code 2.1.318이 실제로 보내는 `anthropic-beta` 값과 `max_tokens`(바이너리 문자열 검사로 환경변수 이름만 확인함). 허용 목록에 없는 값은 제거되므로, 기능이 빠지면 목록을 조정한다.
- 비루트 실행, DNS 이름 조회를 통한 외부 유출, 크레딧 차감은 0단계 결과의 미해결 항목 그대로다.
- 3단계는 2026-11-06에 공개 시험 저장소 `roboco-io/factory-test-app`에서 실제로 실행했다. 확인한 경로는 T0 자동 병합, 승인 대기, 리뷰어의 `changes_requested`로 인한 병합 차단, 운영자 승인 후 병합, 사람의 직접 병합 뒤 실행 종료다. T3, 승인 후 헤드 변경, 체크 실패, 비공개 저장소의 경로는 실제로 시험하지 않았다.
- pi 1.5.0은 위 시험에서 컨테이너 안에서 동작했고 출구 핸들러에 거부되지 않았다. 다만 실제 요청 본문은 기록하지 않으므로 `maxTokens` 조정이 적용됐는지는 직접 확인하지 못했다. 패키지 소스에 따르면 pi 1.5.0은 `max_output_tokens`를 모델의 기본 최대 출력(gpt-5.4-nano는 128000, 문맥 크기에 따라 더 작을 수 있음)으로 보내는 것으로 패키지 소스에서 읽었다. 출구 핸들러는 16000을 넘는 값을 거부하므로, 리뷰 샌드박스는 `PI_CODING_AGENT_DIR`의 `models.json`에 `modelOverrides`로 `maxTokens: 16000`을 써서 낮춘다. 이 값을 넘는 요청은 403으로 거부되어 리뷰가 `review_failed`로 끝나며, 병합은 일어나지 않는다.
- pi가 실제로 보내는 요청 본문은 패키지 소스에서 읽었다(`store: false`, 함수 도구만, `previous_response_id`, `background` 없음, `stream: true`, `reasoning`, `include`, `prompt_cache_key` 등). 실제 네트워크 요청으로는 확인하지 못했다. 출구 핸들러는 위에 적은 필드만 거부하고 다른 필드는 막지 않는다.
- 실제 GitHub의 check-runs, 리뷰, 병합 API의 성공 응답은 위 시험에서 확인했다. 403 구분(권한 부족과 요율 제한)은 문서와 가짜 응답으로만 확인했다. 요율 제한 403은 `x-ratelimit-remaining: 0` 또는 `retry-after` 헤더로 구분한다.
- 필수 체크 이름은 체크 실행의 이름만 비교한다. 같은 이름의 체크 실행을 다른 앱이 만들 수 있는지는 저장소의 Checks 쓰기 권한 설정에 달려 있으며 여기서 막지 않는다.
- Claude Code 2.1.318이 보내는 `tools` 배열의 형식은 확인하지 못했다. 그래서 `type`이 `custom`이 아닌 도구를 모두 거부하는 규칙은 넣지 않고, `web_search`로 시작하는 `type`만 거부한다. 다른 서버 측 도구(`web_fetch` 등)는 막지 않는다.
