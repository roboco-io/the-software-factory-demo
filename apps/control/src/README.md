# control/src

## Overview

제어 평면 Cloudflare Worker의 소스다. 진입점 `index.ts`가 HTTP 요청을 `app.ts:handleRequest`로 넘기고, 두 Durable Object(`IssueRun`, `AgentSandbox`)와 출구 핸들러(`Outbound`)를 내보낸다. 흐름은 다음과 같다. GitHub 웹훅(`webhook.ts`)이 운영자가 붙인 `factory:go` 라벨을 받으면, 이슈마다 하나인 `IssueRun`이 `run-machine.ts`의 상태 기계로 실행을 진행한다. 구현은 `AgentSandbox` 컨테이너 안의 Claude Code가, 리뷰는 별도 리뷰 샌드박스의 pi(OpenAI 모델)가 맡는다. PR 생성과 병합은 제어 평면이 GitHub App 토큰으로 수행하고, 병합 여부는 `decision.ts`의 순수 함수가 정책 파일, 체크, 운영자 리뷰를 읽어 판정한다. 컨테이너에는 GitHub 토큰과 LLM 키가 들어가지 않으며, 컨테이너의 모든 HTTP(S) 요청은 `Outbound`가 허용 목록으로 걸러 실제 키를 주입한다.

`testing/`은 테스트 전용 헬퍼(가짜 GitHub, node:sqlite 기반 D1 어댑터, 상태 기계 하네스)이며 제품 코드가 의존하지 않는다.

## Interface

### HTTP와 포털 API

- `index.ts:default.fetch`: Worker 진입점. `AgentSandbox`, `IssueRun`, `Outbound`를 다시 내보낸다.
- `app.ts:handleRequest`, `http.ts:json`/`AppDeps`/`RouteContext`, `routes.ts:ROUTES`/`dispatch`: 단일 라우트 테이블과 디스패처.

| 메서드 | 경로                              | 처리기                         | 최소 역할             |
| ------ | --------------------------------- | ------------------------------ | --------------------- |
| GET    | `/api/health`                     | 인라인 `{status:"ok"}`         | anonymous             |
| POST   | `/api/github/webhook`             | `webhook.ts:handleWebhook`     | anonymous (서명 검증) |
| GET    | `/api/auth/login`                 | `auth.ts:handleLogin`          | anonymous             |
| GET    | `/api/auth/callback`              | `auth.ts:handleCallback`       | anonymous (HEAD 거부) |
| POST   | `/api/auth/logout`                | `auth.ts:handleLogout`         | anonymous (자기 세션) |
| GET    | `/api/me`                         | `portal-api.ts:handleMe`       | anonymous             |
| GET    | `/api/projects`                   | `portal-api.ts:handleProjects` | anonymous             |
| GET    | `/api/projects/:owner/:repo/runs` | `portal-api.ts:handleRuns`     | anonymous             |
| GET    | `/api/runs/:id`                   | `portal-api.ts:handleRun`      | anonymous             |
| POST   | `/api/runs/:id/stop`              | `portal-api.ts:handleStop`     | operator              |
| POST   | `/api/runs/:id/review`            | `review.ts:handleReviewStart`  | operator              |

- `auth.ts`: `startOAuth`(state + PKCE S256), `identify`, `authConfig`, `OAUTH_COOKIE`(`__Host-oauth`).
- `session.ts`: `signSession`/`verifySession`, `signPayload`/`verifyPayload`(용도 문자열에 묶인 HMAC), `SESSION_COOKIE`(`__Host-session`, 7일).
- `roles.ts`: `Role`(anonymous < observer < operator), `roleOf`, `hasRole`.
- `review.ts`: 포털의 운영자 승인. `handleReviewStart`, `completeReview`, `readReviewCookie`, `reviewRedirect`, `REVIEW_COOKIE`(`__Host-review`).
- `read-repo.ts:D1ReadRepo`: 포털 조회용 SELECT 전용 저장소(`countsByRepo`, `listRuns`, `getRun`, `statsByRepo`, `listEvents`).
- `env.ts:ControlEnv`, `config.ts`(`parseList`, `resolveModel`, `resolveReviewModel`), `diagnostics.ts`(`logDiagnostic`, `errorKind`, `safeLabel`).

### 실행 상태 기계

- `issue-run.ts:IssueRun`: 이슈당 하나인 Durable Object. `start`, `stop`, `alarm`을 `RunMachine`에 연결한다.
- `run-machine.ts:RunMachine`: `start`, `stop`, `alarm`. 포트 `RunStorage`, `SandboxPort`, `ReviewSandboxPort`, `PublisherPort`와 시간 상수(`RUN_TIMEOUT_MS` 20분, `CHECKS_TIMEOUT_MS` 30분, `APPROVAL_TIMEOUT_MS` 7일, `MAX_ACTIVE_RUNS` 2 등).
- `run-types.ts`: `STATES`, `REASON_CODES`, `EVENT_KINDS`, `RunInput`. `run-state.ts`: `canTransition`, `assertTransition`, `isTerminal`, `POST_PR_STATES`.
- `decision.ts`: `decideMerge`, `operatorStanding` (순수 함수).
- `policy.ts`: `parsePolicy`(`.factory/policy.yml`), `tierOfPath`, `classifyPullRequest`, `TIERS`(T0-T3), `ACTIONS_APP_ID`.
- `d1-repo.ts:D1RunRepo`: `createRun`, `findActiveRun`, `transition`, `recordCleanup`, `recordFacts`, `recordUsage`, `claimDelivery`, `releaseDelivery`. `ActiveRunConflict` 오류.

### GitHub

- `webhook.ts:handleWebhook`, `TRIGGER_LABEL`(`factory:go`), `signature.ts:verifySignature`, `repo.ts:isValidRepo`.
- `github-app.ts:createAppJwt`, `importPrivateKey`. `github-publisher.ts:createPublisher`, `createInstallationToken`, `githubRequest`, `GitHubError`, `branchName`.
- `pull-port.ts:PullRequestPort`(PR 조회, 파일 목록, 정책 읽기, diff, 체크, 리뷰, 병합)와 구현 `github-pulls.ts:createPullClient`.
- `changes.ts:validateChanges`: 컨테이너가 보고한 변경을 검증한다. `neutralize-mentions.ts:neutralizeMentions`.

### 샌드박스와 출구

- `agent-sandbox.ts:AgentSandbox`: 샌드박스 id마다 컨테이너 하나인 Durable Object. 리뷰 샌드박스는 `startReviewSandbox`로 시작하며, id는 `run-machine.ts:reviewSandboxId`가 정한다.
- 오류 타입: `IllegalTransitionError`(`run-state.ts`), `PublishRejected`(`run-machine.ts`), `ChecksPermissionMissing`(`pull-port.ts`), `LoginFailed`(`auth.ts`).
- 기본 모델: `config.ts`의 `DEFAULT_IMPLEMENT_MODEL`, `DEFAULT_REVIEW_MODEL`. `IMPLEMENT_MODEL`, `REVIEW_MODEL` 변수로 바꾼다.
- `sandbox-core.ts:SandboxController`(`clone`, `cloneAt`, `startAgent`, `startReview`, `readTaskStatus`, `readReviewText`, `collectChanges`).
- `agent-command.ts:buildAgentCommand`(Claude Code 실행 인자), `review-command.ts:buildReviewCommand`(pi 리뷰어 실행 인자).
- `prompt.ts:buildPrompt`, `review-prompt.ts:buildReviewPrompt`, `review-verdict.ts:parseVerdict`/`renderReviewComment`.
- `outbound.ts:Outbound`, `outbound-policy.ts:decideOutbound`/`selectKey`/`inject*Key`, `outbound-body.ts:prepareAnthropicRequest`/`prepareOpenAIRequest`.
- `usage-meter.ts:meterResponse`/`parseUsage`, `pricing.ts:costUsd`.

## Invariants

- 상태 전환은 `run-state.ts`의 `NEXT` 표만 허용하며, 그 밖의 전환은 `IllegalTransitionError`를 던진다. `merged`, `needs_human`, `failed`는 종료 상태다. PR 이후 상태(`POST_PR_STATES`)의 실패는 `needs_human`, 그 이전 실패는 `failed`가 된다.
- 실행 상태(`run` 키)는 `RunMachine.start`와 `IssueRun`의 alarm만 쓴다. `start`는 새 `queued` 실행을 만들거나 `ActiveRunConflict` 뒤 기존 활성 실행을 채택하고, `stop_requested`를 비운다. 이후 상태 전환은 alarm이 한다. 중지 요청은 별도 키(`stop_requested`)에 저장되며, `mergeAttempted`가 true가 된 뒤에는 거부된다(`merge_attempted`).
- 시간 제한: 구현 단계는 `RUN_TIMEOUT_MS`(20분), `pr_opened`와 `reviewing`은 `REVIEW_TIMEOUT_MS`(20분), 체크 대기는 `CHECKS_TIMEOUT_MS`(30분), 승인 대기는 `APPROVAL_TIMEOUT_MS`(7일)다. 단계 재시도는 `MAX_STEP_ATTEMPTS`(3), 대기 재시도는 `MAX_WAIT_ATTEMPTS`(12), 정리 재시도는 `MAX_CLEANUP_ATTEMPTS`(5)로 제한한다.
- 웹훅은 서명 검증 후, `issues` 이벤트의 `labeled` 동작, 라벨 `factory:go`, 봇이 아닌 `OPERATOR_IDS` 발신자, `PROJECTS`에 있는 저장소, PR이 아닌 열린 이슈일 때만 실행을 시작한다. `RUNS_ENABLED`가 정확히 `"true"`가 아니면 시작하지 않는다(`routes.ts`). 본문은 1 MiB(`MAX_BODY_BYTES`, 초과 시 413)로 제한하고, 이슈 제목과 본문은 500자와 20000자로 자른다. `X-GitHub-Delivery` 형식이 틀리면 400이다. 같은 delivery id는 한 번만 처리하지만, 시작이 실패하면 id를 되돌려 GitHub의 재전송을 다시 처리한다. `ANTHROPIC_API_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` 중 하나라도 없으면 시작하지 않고 500을 반환한다.
- 동시 활성 실행은 `MAX_ACTIVE_RUNS`(2)로 제한되며, `awaiting_approval`은 슬롯을 차지하지 않는다(`d1-repo.ts:CAPACITY_SQL`).
- 병합 판정 전에 다음 경우는 판정 없이 사람에게 넘기거나 멈춘다: 기준 브랜치가 기본 브랜치가 아님(`base_not_default`), 정책 파일 없음, PR 파일 목록 절단, 팩토리 밖에서 병합됨, 체크 조회 권한 없음(`ChecksPermissionMissing`).
- 병합 판정(`decideMerge`) 순서: PR 닫힘, head 변경, 리뷰 판정이 approve가 아님, 필수 체크 없음, 체크 실패, 체크 대기, 운영자 변경 요청. 필수 체크는 이름과 앱 id가 모두 맞아야 하며, 앱 id 기본값은 `ACTIONS_APP_ID`다. `operatorStanding`은 PR 작성자, 사용자(`User`)가 아닌 리뷰어, 댓글 리뷰를 무시하고, 정확히 현재 head SHA에 대한 승인만 센다. 자동 병합은 정책의 `autoMergeTiers`에 있는 등급만 하며, T3은 정책과 무관하게 자동 병합하지 않는다(`NEVER_AUTOMATIC`). 병합은 항상 squash이며 리뷰한 `headSha`에 고정된다.
- 정책 파일은 PR head가 아니라 기본 브랜치 끝 커밋에서 읽는다. 루트의 `.github`, `.factory` 경로는 최소 T3이고, 규칙에 맞지 않는 경로는 T2다. 변경 파일이 없는 PR은 T3으로 분류한다.
- 리뷰할 diff가 `DIFF_CAP`(300000자)을 넘으면 실행은 `diff_too_large`로 실패한다.
- 컨테이너는 `enableInternet:false`로 시작하고 모든 HTTP(S)는 `Outbound`로 간다. 허용 대상은 구현 단계의 `api.anthropic.com` `POST /v1/messages`(및 `count_tokens`), 리뷰 단계의 `api.openai.com` `POST /v1/responses`, 바인딩된 저장소의 `github.com` git-upload-pack(읽기 전용)뿐이다. https가 아니거나 URL에 자격 증명이나 기본이 아닌 포트가 있으면 거부한다. OpenAI 요청에는 쿼리 문자열을 허용하지 않는다.
- LLM 요청 본문은 4 MiB(`MAX_REQUEST_BYTES`) 이하여야 하고, 모델은 실행 모델과 같아야 한다. Anthropic `/v1/messages`는 `max_tokens`가 16000 이하여야 하고(`count_tokens`에는 적용하지 않음), `mcp_servers`, `container`, 웹 검색 도구를 거부하며, `anthropic-beta` 헤더는 `BETA_ALLOWLIST`로 거른다. OpenAI는 `max_output_tokens`가 있으면 16000 이하여야 하고, `store`나 `background`가 true이거나 `previous_response_id`, `conversation`, `prompt`가 있거나 function이 아닌 도구가 있으면 거부한다(`outbound-body.ts`).
- 컨테이너에는 자리표시자 키(`PLACEHOLDER_API_KEY`)만 들어간다. Anthropic 요청은 `authorization`을 지우고 `x-api-key`를 실제 키로 덮어쓴다. OpenAI 요청은 `authorization`을 실제 키로 덮어쓴다. github.com 요청은 헤더를 바꾸지 않고 키도 넣지 않으므로, 컨테이너의 복제는 토큰 없이 실행되고 공개 저장소에서만 동작한다.
- 컨테이너의 변경 보고는 신뢰하지 않는 데이터다. `validateChanges`는 다음 중 하나라도 있으면 변경 전체를 거부한다: 빈 변경, `truncated` 보고, 50파일·파일당 256 KiB·합계 1 MiB 초과, 1024자 초과 경로, 절대 경로나 드라이브 경로, 역슬래시, 비UTF-8·제어·보이지 않는 문자, `..` 경로 탐색, 첫 세그먼트가 `.github`나 `.factory`(소문자화하고 끝의 점과 공백을 지운 뒤 비교), 어느 세그먼트든 `.git`이나 `git~N` 형태, 심볼릭 링크, 서브모듈, 특수 파일. 게시 단계(`github-publisher.ts`)는 기준 트리의 심볼릭 링크나 서브모듈을 지나는 경로도 `PublishRejected`로 거부한다.
- 이슈 본문과 diff는 프롬프트에서 `UNTRUSTED_*_DATA` 표지로 감싸며, 리뷰 판정은 스키마 검증(`parseVerdict`)을 통과해야만 유효하다. high/critical 발견이 있는 approve는 무효다.
- 실행을 바꾸는 라우트(중지, 승인)는 operator만 호출할 수 있다. observer가 호출할 수 있는 비GET 라우트는 자기 세션만 지우는 `POST /api/auth/logout`뿐이다. GET/HEAD가 아닌 요청은 서명 웹훅을 빼고 `Origin`이 일치해야 한다. `PROJECTS`에 없는 저장소의 실행은 404다.
- 진단 로그(`logDiagnostic`)에는 `diagnostics.ts:errorKind`가 형식을 검사한 오류 클래스 이름만 남긴다. `Outbound`는 별도의 `errorKind`(형식 검사 없이 `error.name` 또는 `typeof`)를 쓰고, 허용·거부 결과를 `outbound allow|deny 메서드 호스트/경로` 형태의 평문 로그로 남긴다. 어느 경우에도 토큰, 요청 본문, 쿼리 문자열은 기록하지 않는다.

## Side Effects

- D1 쓰기(`d1-repo.ts`): `runs` INSERT/UPDATE, `events` INSERT(추가 전용), `run_usage` INSERT, `deliveries` INSERT OR IGNORE/DELETE. 포털 조회(`read-repo.ts`)는 SELECT만 한다.
- Durable Object 저장소와 alarm: `IssueRun`의 `run`, `stop_requested` 키, `AgentSandbox`의 repo/model/phase/runId 키.
- 컨테이너: 시작, `git clone`/`fetch`, Claude Code 또는 pi 실행, 변경 수집(`git reset --mixed`), 종료와 정리(`destroy`). 비활성 25분 후 종료된다.
- GitHub App 토큰: `GET /repos/:repo/installation`과 `POST /app/installations/:id/access_tokens`로 설치 토큰을 발급한다. `createPullClient`는 저장소별로 토큰을 캐시한다.
- GitHub 쓰기: blob·tree·커밋·브랜치·PR·이슈 댓글 생성(`github-publisher.ts`), PR 리뷰 댓글과 squash 병합(`github-pulls.ts`), 운영자 사용자 토큰으로 PR 리뷰 게시(`review.ts`). 운영자 리뷰는 OAuth 범위 `public_repo`를 요청하고, 게시 전에 사용자 토큰으로 PR을 다시 조회한다.
- GitHub OAuth: 토큰 교환과 `/user` 조회. 쿠키 `__Host-oauth`와 `__Host-review`(600초), `__Host-session`(7일)을 설정하거나 지운다.
- 외부 LLM 호출: `Outbound`가 Anthropic과 OpenAI로 요청을 전달하고, 응답의 토큰 사용량을 `run_usage`에 최선 노력으로 기록한다. 실행 id, 단계, 모델, `DB` 중 하나가 없으면 기록을 건너뛰며, 기록 실패는 응답에 영향을 주지 않는다.
- 로그: `logDiagnostic`이 JSON 진단 이벤트를, `Outbound`가 평문 허용·거부 로그를 `console.log`로 남긴다.

## Verification

- Run: `pnpm --filter @factory/control test`
- 타입 검사: `pnpm --filter @factory/control typecheck`
