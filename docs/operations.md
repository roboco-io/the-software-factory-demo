# 운영 설정

이 문서는 2단계(이슈 하나가 PR이 되는 경로)와 3단계(다른 엔진의 리뷰와 프로그램의 병합 판정)를 켜기 위해 사람이 설정해야 하는 값을 정리한다. 작성일은 2026-11-06이다. 아래 값을 설정하기 전에도 배포는 실패하지 않으며, 웹훅은 요청을 처리하지 않고 거부하거나 무시한다.

## 비밀 값

비밀 값은 코드, 설정 파일, 명령 인자에 넣지 않는다. `apps/control` 디렉터리에서 `pnpm exec wrangler secret put <이름>`을 실행하면 값을 표준 입력으로 받는다. Worker를 한 번 배포한 뒤에 설정할 수 있다.

| 이름                         | 내용                                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`      | GitHub App 웹훅 설정에 입력한 비밀 값. 없으면 웹훅 엔드포인트가 503을 반환한다.                                                                                                                                |
| `GITHUB_APP_PRIVATE_KEY`     | GitHub App의 개인 키 PEM 전체. GitHub가 내려주는 PKCS#1(`BEGIN RSA PRIVATE KEY`) 형식을 그대로 넣는다. 코드가 WebCrypto용 PKCS#8로 변환한다.                                                                   |
| `ANTHROPIC_API_KEY`          | 에이전트가 쓰는 Anthropic 키. 컨테이너에는 들어가지 않고, 출구 핸들러(`Outbound`)가 `api.anthropic.com`으로 나가는 요청에만 주입한다.                                                                          |
| `OPENAI_API_KEY`             | 리뷰 에이전트(pi)가 쓰는 OpenAI 키. 컨테이너에는 들어가지 않고, 출구 핸들러가 리뷰 샌드박스에서 `api.openai.com`으로 나가는 요청에만 주입한다. 없으면 리뷰가 실패해 실행이 `needs_human`으로 끝난다.           |
| `GITHUB_OAUTH_CLIENT_SECRET` | 이 플랫폼 GitHub App의 클라이언트 비밀 값. 사용자가 로그인할 때 GitHub 인증 코드를 사용자 토큰으로 바꾸는 데 쓴다. 없으면 로그인이 시작되지 않는다.                                                            |
| `SESSION_SECRET`             | 로그인 세션 쿠키와 로그인 중 `state` 값에 서명하는 비밀 값. 충분히 긴 무작위 문자열을 쓴다. 없으면 세션을 만들지 못해 로그인이 동작하지 않는다. 값을 바꾸면 기존 세션이 모두 무효가 되어 다시 로그인해야 한다. |

## 변수

변수는 비밀이 아니므로 `apps/control/wrangler.jsonc`의 `vars`에 적고 커밋한다. 대시보드에서 바꾼 값은 다음 배포 때 이 파일의 값으로 덮어써지므로 대시보드에서 바꾸지 않는다.

| 이름                     | 내용                                                                                                                                                                                                                                              | 기본값                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `GITHUB_APP_ID`          | GitHub App의 숫자 ID.                                                                                                                                                                                                                             | 빈 값                     |
| `RUNS_ENABLED`           | 전체 중지 스위치. 문자열 `true`일 때만 실행을 시작한다. 그 밖의 값이나 빈 값이면 모든 요청을 무시한다.                                                                                                                                            | `false`                   |
| `OPERATOR_IDS`           | 실행을 시작할 수 있고, PR 리뷰의 승인이 병합 조건으로 인정되는 GitHub 사용자의 숫자 ID 쉼표 목록(로그인 이름이 아님). 로그인 이름은 바꾸거나 다른 사람이 재사용할 수 있어서 숫자 ID로 확인한다. ID는 `gh api users/<로그인> --jq .id`로 조회한다. | 빈 값(아무도 못 함)       |
| `PROJECTS`               | 실행을 허용할 저장소 `owner/name`의 쉼표 목록. 정확히 일치해야 한다.                                                                                                                                                                              | 빈 값(아무것도 안 됨)     |
| `PUBLIC_REPOS`           | 로그인하지 않은 사람에게도 실행 기록을 보여 줄 저장소 `owner/name`의 쉼표 목록. 목록에 없는 저장소의 실행은 운영자만 본다. 저장소를 공개할지는 소유자가 결정하므로 승인 없이 추가하지 않는다.                                                     | 빈 값(공개된 저장소 없음) |
| `GITHUB_OAUTH_CLIENT_ID` | 이 플랫폼 GitHub App의 클라이언트 ID(비밀이 아님). 이 값이나 `GITHUB_OAUTH_CLIENT_SECRET`이 비어 있으면 로그인을 시작할 수 없고 승인 버튼도 동작하지 않는다.                                                                                      | 빈 값(로그인 불가)        |
| `IMPLEMENT_MODEL`        | 구현 에이전트의 모델. 영문자, 숫자, `.`, `_`, `-`만 허용하며 다른 값이면 기본값을 쓴다.                                                                                                                                                           | `claude-sonnet-5-5`       |
| `REVIEW_MODEL`           | 리뷰 에이전트(pi, OpenAI Responses API)의 모델. `IMPLEMENT_MODEL`과 같은 문자 규칙을 따른다. 출구 핸들러는 요청 본문의 `model`이 이 값과 다르면 거부한다.                                                                                         | `gpt-5.4-nano`            |

## 최초 설정 순서

1. D1 데이터베이스 `software-factory`는 2026-11-06에 만들었고 ID는 `wrangler.jsonc`에 있다. 새 환경을 만들 때만 `pnpm exec wrangler d1 create`를 다시 실행한다. 마이그레이션은 배포 워크플로가 적용한다.
2. 시험용 공개 저장소에 GitHub App을 설치한다. 저장소 권한은 Contents, Pull requests, Issues의 쓰기와 3단계를 위한 Checks의 읽기이고, 이벤트는 Issues를 구독한다. 3단계는 새 웹훅 이벤트를 요구하지 않는다. Checks 읽기 권한이 없으면 필수 체크를 읽을 수 없으므로, 리뷰가 끝난 실행은 `checks_permission_missing` 코드로 `needs_human`이 된다. 권한을 올리면 설치한 계정이 새 권한을 수락해야 적용된다. 웹훅 주소는 `https://<워커 주소>/api/github/webhook`, 콘텐츠 유형은 `application/json`이다.
3. 위 비밀 값 네 개를 설정하고, 변수 `GITHUB_APP_ID`, `OPERATOR_IDS`, `PROJECTS`를 채우고 `RUNS_ENABLED`를 `true`로 바꿔 커밋한다.
4. main에 병합하면 deploy 워크플로가 D1 마이그레이션을 먼저 적용한 뒤 Worker와 컨테이너 이미지를 배포한다.
5. 허용한 운영자가 시험 저장소의 열린 이슈에 `factory:go` 라벨을 붙인다. 성공하면 `factory/issue-<번호>-<실행 ID>` 브랜치와 `Refs #<번호>`를 본문에 담은 PR이 열리고, 이슈에 PR 링크 코멘트가 달린다.
6. 3단계를 켜려면 시험 저장소의 기본 브랜치에 `.factory/policy.yml`을 사람이 PR로 추가한다. 형식은 `docs/examples/factory-policy.yml`에 있다. 이 파일이 없거나 형식이 틀리면 팩토리는 리뷰를 시작하지 않고 실행을 `needs_human`으로 끝낸다. 이 저장소의 작업은 시험 저장소를 건드리지 않는다.
7. 콘솔 로그인을 켜려면 사람이 다음을 한다. (1) 이 플랫폼의 GitHub App 설정에서 콜백 주소(Callback URL)에 `<워커 주소>/api/auth/callback`을 넣고 클라이언트 비밀 값을 만든다. 별도의 OAuth 앱을 만들지 않는다. 승인은 GitHub App의 사용자 토큰으로 PR 리뷰를 쓰기 때문이고, scope 없이 발급한 OAuth 앱 토큰은 PR 리뷰를 쓸 권한이 없다. 로그인 코드가 요청한 주소와 같아야 하며, 요청 주소의 출처는 접속한 Worker의 주소다. (2) 클라이언트 ID를 `wrangler.jsonc`의 `GITHUB_OAUTH_CLIENT_ID`에 적어 커밋하고, 클라이언트 비밀 값은 `wrangler secret put GITHUB_OAUTH_CLIENT_SECRET`으로, 무작위 문자열은 `wrangler secret put SESSION_SECRET`으로 넣는다. (3) 비로그인 방문자에게 공개할 저장소가 있으면 소유자의 결정을 받아 `PUBLIC_REPOS`에 적는다. (4) 새 환경에서는 `pnpm exec wrangler d1 migrations apply software-factory --remote`를 `apps/control`에서 실행한다. 이 저장소의 deploy 워크플로도 배포 전에 마이그레이션을 적용하며, `0004_console.sql`이 `runs`에 `title`, `tier`, `head_sha` 열과 `run_usage` 표를 추가한다. 이전에 만든 실행은 이 열이 비어 있다.

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

### 고정 사유 코드

3단계가 추가한 코드는 다음과 같다. 이벤트에는 이 코드만 저장하고 리뷰어의 글, 정책 파일 내용, 체크 출력은 저장하지 않는다.

| 코드                               | 뜻                                                          |
| ---------------------------------- | ----------------------------------------------------------- |
| `legacy_run`                       | 리뷰 기능이 없던 때 열린 PR이거나 필요한 정보가 없는 실행   |
| `pr_closed`                        | PR이 닫혔거나 다른 사람이 병합함                            |
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

## 콘솔과 사용량 측정

로그인은 GitHub App의 사용자 인증 흐름을 쓴다. 사용자가 로그인하면 제어 평면은 숫자 GitHub ID를 `OPERATOR_IDS`와 비교해 운영자인지 옵저버인지 정한다. 세션은 서명한 쿠키(`HttpOnly`, `Secure`, `SameSite=Lax`)이며 8시간 뒤 만료된다. 로그인 도중의 `state`는 10분 안에 쓰지 않으면 만료되고, 같은 값을 담은 쿠키와 일치해야 한다. 사용자 토큰은 한 요청 안에서만 쓰고 저장하거나 기록하거나 응답에 싣지 않는다.

운영자가 승인 대기 중인 PR에서 승인 버튼을 누르면 GitHub 로그인을 한 번 더 거친 뒤, 제어 평면이 PR의 현재 헤드가 기록된 헤드와 같을 때만 그 SHA에 승인 리뷰를 올린다. 헤드가 바뀌었으면 리뷰를 올리지 않는다. 결과는 포털 주소의 `review=ok|stale|denied|failed`로 돌려준다. 병합 판정은 3단계 코드가 그대로 맡고, 콘솔은 리뷰만 올린다.

사용량은 출구 핸들러가 `api.anthropic.com`과 `api.openai.com` 응답을 읽어 호출마다 `run_usage`에 기록한다. 응답은 둘로 나눠 한쪽은 에이전트에 그대로 전달하고 다른 쪽에서 토큰 수를 센다. 측정이나 기록이 실패하면 로그에 오류 종류만 남기고 응답은 바꾸지 않는다. 비용은 읽을 때 계산한다. 가격은 2026-11-07에 platform.claude.com과 developers.openai.com에서 읽었으며 `apps/control/src/pricing.ts`에 있다. 단위는 백만 토큰당 USD다.

| 모델                | 입력 | 출력 | 캐시 읽기 | 캐시 쓰기 |
| ------------------- | ---- | ---- | --------- | --------- |
| `claude-sonnet-5-5` | 2    | 10   | 0.10      | 2.50      |
| `gpt-5.4-nano`      | 0.20 | 1.25 | 0.02      | 0.20      |

`IMPLEMENT_MODEL`이나 `REVIEW_MODEL`을 이 표에 없는 모델로 바꾸면 토큰 수는 기록되지만 비용은 계산되지 않는다. 가격이 바뀌면 `pricing.ts`를 고쳐야 한다.

## 실서비스에서 아직 확인하지 않은 것

2026-11-06 기준으로 아래 항목은 실제 Cloudflare, GitHub, Anthropic 서비스에서 실행해 보지 못했다. 단위 시험은 가짜 구현으로 통과했다.

- `ctx.exports.Outbound({ props })`로 실행별 저장소를 출구 핸들러에 넘기는 동작
- 컨테이너 안에서 `git clone`, Claude Code 실행, 변경 목록 수집 스크립트의 동작 (변경 목록 수집 스크립트는 로컬 git 저장소로 시험했다)
- GitHub App 설치 토큰 발급과 Git Data API 호출
- 핀 고정한 Claude Code 2.1.318이 실제로 보내는 `anthropic-beta` 값과 `max_tokens`(바이너리 문자열 검사로 환경변수 이름만 확인함). 허용 목록에 없는 값은 제거되므로, 기능이 빠지면 목록을 조정한다.
- 비루트 실행, DNS 이름 조회를 통한 외부 유출, 크레딧 차감은 0단계 결과의 미해결 항목 그대로다.
- 3단계는 모두 가짜 GitHub, 가짜 샌드박스, 가짜 LLM으로만 시험했다. pi 1.5.0은 `max_output_tokens`를 모델의 기본 최대 출력(gpt-5.4-nano는 128000, 문맥 크기에 따라 더 작을 수 있음)으로 보내는 것으로 패키지 소스에서 읽었다. 출구 핸들러는 16000을 넘는 값을 거부하므로, 리뷰 샌드박스는 `PI_CODING_AGENT_DIR`의 `models.json`에 `modelOverrides`로 `maxTokens: 16000`을 써서 낮춘다. 이 설정을 pi가 실제로 받아들이는지는 실행해 보기 전에는 모른다. 받아들이지 않으면 요청이 403으로 거부되어 리뷰가 `review_failed`로 끝나며, 병합은 일어나지 않는다.
- pi가 실제로 보내는 요청 본문은 패키지 소스에서 읽었다(`store: false`, 함수 도구만, `previous_response_id`, `background` 없음, `stream: true`, `reasoning`, `include`, `prompt_cache_key` 등). 실제 네트워크 요청으로는 확인하지 못했다. 출구 핸들러는 위에 적은 필드만 거부하고 다른 필드는 막지 않는다.
- 실제 GitHub의 check-runs, 리뷰, 병합 API의 응답 형태와 403 구분(권한 부족과 요율 제한)은 문서와 가짜 응답으로만 확인했다. 요율 제한 403은 `x-ratelimit-remaining: 0` 또는 `retry-after` 헤더로 구분한다.
- 새 Dockerfile 단계(`@earendil-works/pi-coding-agent@1.5.0` 설치)는 `wrangler deploy --dry-run`의 이미지 빌드까지 통과했다. 컨테이너 안에서 pi를 실제로 실행하는 것은 확인하지 못했다.
- 필수 체크 이름은 체크 실행의 이름만 비교한다. 같은 이름의 체크 실행을 다른 앱이 만들 수 있는지는 저장소의 Checks 쓰기 권한 설정에 달려 있으며 여기서 막지 않는다.
- Claude Code 2.1.318이 보내는 `tools` 배열의 형식은 확인하지 못했다. 그래서 `type`이 `custom`이 아닌 도구를 모두 거부하는 규칙은 넣지 않고, `web_search`로 시작하는 `type`만 거부한다. 다른 서버 측 도구(`web_fetch` 등)는 막지 않는다.
- 콘솔(2026-11-07 추가)은 가짜 GitHub와 가짜 D1로만 시험했다. GitHub App이 발급한 사용자 토큰으로 App에 지금 설정된 권한만으로 PR 리뷰를 올릴 수 있는지는 확인하지 못했다. 올릴 수 없으면 GitHub가 오류를 돌려주고 콘솔은 `review=failed`를 표시하며 리뷰는 올라가지 않는다. 이때 병합 조건은 충족되지 않는다.
- 실제 모델 스트림에서의 사용량 측정은 workerd에서 확인하지 못했다. 세 가지가 남아 있다. 느린 클라이언트가 응답을 천천히 읽을 때 `tee`로 나눈 한쪽이 본문을 얼마나 버퍼에 쌓는지, 다시 만든 응답에 `content-encoding` 같은 헤더가 올바르게 남는지, 클라이언트가 연결을 끊은 뒤에 `waitUntil`의 시간 제한 때문에 일부 사용량만 기록되는지다.
- T3 등급 PR의 승인에서 병합까지의 흐름(포털 승인, 리뷰 등록, 다음 확인에서의 병합)은 시험 저장소에서 실행해 보지 못했다. 사람이 GitHub로 로그인해 승인해야 하므로 에이전트가 대신 확인할 수 없다.
