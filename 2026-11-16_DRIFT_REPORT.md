# EGM 드리프트 리포트 (2026-11-16)

이 리포트는 2026-11-16에 EGM 부트스트랩으로 만든 계약 README 10개를 현재 코드와 대조한 결과다. 계약마다 읽기 전용 검토 에이전트가 소스를 직접 읽고 차이만 보고했다. "틀림"으로 판정한 항목 가운데 핵심 항목은 이 리포트를 쓴 세션이 코드를 다시 열어 확인했다.

등급 기준은 다음과 같다. **틀림**은 문서의 주장이 코드와 반대인 경우다. **부정확**은 주장이 일부 경우에만 맞거나 인용 위치가 다른 경우다. **누락**은 유지보수자가 알아야 하는데 문서에 없는 동작이나 공개 심볼이다. 루트 `README.md`의 "동작 방식"과 "운영" 절은 이번 부트스트랩 이전에 사람이 쓴 내용이며, 해당 항목에 그렇게 표시했다.

## README.md (루트)

- **틀림 (기존 본문, 21행):** "체크아웃과 PR 생성은 제어 평면이 처리한다"는 코드와 다르다. 체크아웃은 컨테이너 안에서 토큰 없는 `git clone`으로 실행되고 `Outbound`가 바인딩된 저장소의 `git-upload-pack`만 통과시킨다(`apps/control/src/sandbox-core.ts:128-149`, `apps/control/src/outbound-policy.ts:64-86`). 제어 평면이 처리하는 것은 PR 생성뿐이다. 토큰이 없으므로 대상 저장소는 공개 저장소여야 한다는 결과도 문서에 없다.
- **부정확 (기존 본문, 66행):** "값을 설정하기 전에도 배포는 가능하며, `RUNS_ENABLED`가 `true`가 아니면 실행이 시작되지 않는다"는 문장은 커밋된 설정과 맞지 않는다. `apps/control/wrangler.jsonc:31-33`은 이미 `RUNS_ENABLED: "true"`, 비어 있지 않은 `OPERATOR_IDS`, `PROJECTS`를 담고 있다. 비밀 값 없이 배포하면 조건을 갖춘 웹훅은 "시작 안 함"이 아니라 500을 받는다(`apps/control/src/routes.ts:62-69`). `docs/operations.md:26`도 기본값을 `false`로 적고 있어 같은 불일치가 있다.
- **부정확 (기존 본문, 19행):** "T0는 조건이 맞으면 자동으로 병합"은 정책 파일의 `autoMergeTiers`에 T0가 있을 때만 맞다. 기본값으로 자동 병합되는 등급은 없다(`apps/control/src/decision.ts:125-128`, `apps/control/src/policy.ts:95-100`).
- **부정확 (진행 상태 표):** 5단계 "지출 계산 미구현"과 달리 실행별 비용 계산(`apps/control/src/pricing.ts:costUsd`, `usage-meter.ts`)이 있다. 6단계 "conveyor 이전 미구현"과 달리 `PROJECTS`에 `roboco-io/conveyor`가 이미 있다(`wrangler.jsonc:33`). 단계 완료 조건이 이보다 넓다면 문구를 그에 맞게 구체화해야 한다.
- **부정확 (전역 불변 조건):** `RUNS_ENABLED === "true"` 비교의 위치는 `webhook.ts`가 아니라 `apps/control/src/routes.ts:53`이다.
- **누락 (전역 불변 조건):** 실행 시작 조건에서 다음이 빠졌다. PR인 이슈 제외(`webhook.ts:96-101`), `X-GitHub-Delivery` 형식 검사와 중복 처리 방지(`webhook.ts:147-152`), 용량 초과 거부(`webhook.ts:156`), `ANTHROPIC_API_KEY`·`GITHUB_APP_ID`·`GITHUB_APP_PRIVATE_KEY` 미설정 시 500과 delivery id 반환(`routes.ts:62-69`, `webhook.ts:164-168`).
- **누락 (전역 불변 조건):** `Outbound`의 핵심 규칙이 빠졌다. 구현 단계는 Anthropic만, 리뷰 단계는 OpenAI만 호출할 수 있다(`outbound-policy.ts:45,53`). URL에 자격 증명이나 비기본 포트가 있으면 거부한다(`outbound-policy.ts:40-42`). 요청 본문을 검사하고 모델을 고정한다(`outbound.ts:49-58`).
- **부정확 (전역 불변 조건):** "옵저버 역할에는 쓰기 경로가 없다"와 달리 `POST /api/auth/logout`은 자기 세션 예외로 누구나 호출할 수 있다(`routes.ts:107-113`). 조회 GET 라우트는 익명에게도 열려 있다(`routes.ts:114-137`).
- **부정확 (전역 부수 효과):** `run_usage` 기록은 최선 노력이다. `runId`, `phase`, `model`, `DB` 중 하나가 없으면 건너뛰고 기록 오류는 삼킨다(`outbound.ts:75-95`). Worker `software-factory-control`과 D1 `deliveries` 테이블도 목록에 없다.

## apps/README.md

- **부정확:** "두 앱 사이의 경계는 HTTP API 하나뿐이다"는 틀린 단정이다. control은 `../portal/dist`를 정적 자산으로 제공하고 포털의 `public/_headers`가 CSP를 정한다(`apps/control/wrangler.jsonc:8-13`). 포털 테스트는 control 소스를 직접 import한다(`apps/portal/src/labels.test.ts:2`의 `REASON_CODES`, `STATES`).
- **부정확:** "같은 출처의 `/api/*`만 호출한다"는 `fetch`에만 맞다. 포털은 `https://github.com/login/oauth/authorize`로 이동하고 github.com 링크를 만든다(`apps/portal/src/console-labels.ts:2`, `apps/portal/src/dom.ts:49`).

## apps/control/README.md

- **부정확:** "그 밖의 경로는 포털 정적 파일로 응답"에 `not_found_handling: "single-page-application"`(`wrangler.jsonc:11`)이 빠져 있다. 알 수 없는 경로가 `index.html`을 받는 이유가 이 설정이다.
- **누락:** `OPERATOR_IDS`나 `PROJECTS`가 비어도 모든 실행이 멈춘다(`wrangler.jsonc:24` 주석). `secrets.required`를 일부러 두지 않아 비밀 값 없이도 배포된다(`wrangler.jsonc:16-17`). `SESSION_SECRET`은 32자 이상이어야 한다(`src/env.ts:22`).
- **누락:** 바인딩 이름 `ISSUE_RUN`, `SANDBOX`, `ASSETS`, 두 DO의 SQLite 저장소, 컨테이너 이미지 키 `agent`(`wrangler.jsonc:45-63`).
- **부정확:** "pi 버전 고정"은 맞지만 이미지 전체가 고정된 것은 아니다. 기반 이미지는 다이제스트가 아닌 태그(`Dockerfile:5`)이고 apt 패키지 버전은 고정하지 않는다(`Dockerfile:8`). `sandbox-shim`은 `cloudflare/sandbox:1.0.3`에서 복사한다(`Dockerfile:20`).
- **누락:** `typecheck`는 생성 파일 `worker-configuration.d.ts`에 의존한다(`tsconfig.json:4`, `src/env.ts:29`). 배포는 패키지 스크립트가 아니라 `.github/workflows/deploy.yml:31`의 `wrangler deploy`가 하며, 그 전에 원격 D1 마이그레이션을 적용한다(`deploy.yml:23-31`).

## apps/control/src/README.md

라우트 11개, 시간 상수, 쿠키, DO 저장소 키, 상태 전환표, `decideMerge` 순서, 출구 허용 목록은 코드와 일치했다. 차이는 다음과 같다.

- **부정확:** "컨테이너의 인증 헤더는 제거되고 `Outbound`가 실제 키를 주입한다"는 Anthropic과 OpenAI에만 맞다. github.com 요청은 헤더를 그대로 전달하고 키를 넣지 않는다(`outbound.ts:69`).
- **부정확:** "출력 토큰은 16000 이하"는 Anthropic `/v1/messages`에만 적용된다. `count_tokens`에는 적용되지 않고, OpenAI는 `max_output_tokens`가 없어도 허용한다(`outbound-body.ts:62-72,187-196`).
- **부정확:** "observer는 쓸 수 있는 라우트가 없다"는 같은 문서의 라우트 표(`/api/auth/logout`, anonymous)와 어긋난다.
- **부정확:** "오류 로그에는 오류 클래스 이름만 남긴다(`errorKind`)"와 달리 `outbound.ts:100-102`에는 이름 형식 검사가 없는 별도 `errorKind`가 있다. `Outbound`는 JSON이 아닌 평문 `console.log`도 남긴다(`outbound.ts:38-40,54,83,90,94`).
- **부정확:** "실행 상태는 `IssueRun`의 alarm만 쓴다"와 달리 `RunMachine.start`도 실행을 만들거나 채택하고 `stop_requested`를 비운다(`run-machine.ts:226-269`).
- **누락:** `REVIEW_TIMEOUT_MS`(20분)가 `pr_opened`와 `reviewing`에 적용된다(`run-machine.ts:24-26`). `MAX_STEP_ATTEMPTS`, `MAX_WAIT_ATTEMPTS`, `MAX_CLEANUP_ATTEMPTS`, `CHECKS_POLL_MS`, `START_GRACE_MS`도 없다.
- **누락:** 웹훅 본문 상한 1 MiB(413), 제목·본문 500자·20000자 절단, PR인 이슈 무시, 시작 실패 시 delivery id 반환(`webhook.ts:6-9,98,122,164-168`).
- **누락:** `validateChanges`의 규칙 일부. 빈 변경, `truncated` 보고, 절대 경로와 역슬래시, 비UTF-8·제어·보이지 않는 문자, 1024자 초과 경로, `git~N` 세그먼트를 거부한다. `.github`와 `.factory`는 첫 세그먼트에서만, `.git`은 모든 세그먼트에서 거부한다(`changes.ts:93-171`). 게시 단계는 기준 트리의 심볼릭 링크와 서브모듈을 지나는 경로도 `PublishRejected`로 거부한다(`github-publisher.ts:223-235`).
- **누락:** 출구 본문 규칙. Anthropic의 `mcp_servers`, `container`, 웹 검색 도구 거부, `anthropic-beta` 헤더 허용 목록, OpenAI의 `store`·`background`·`previous_response_id`·`conversation`·`prompt` 거부와 function 외 도구 거부, 요청 본문 4 MiB 상한(`outbound-body.ts:3-24,48-75,168-208`).
- **누락:** 병합 판정 전 중단 조건(`base_not_default`, 정책 없음, 파일 목록 절단, 외부 병합, `ChecksPermissionMissing`; `run-machine.ts:356-358,554-591`), 필수 체크의 이름과 앱 id 동시 일치(`decision.ts:55-57`), `operatorStanding`이 PR 작성자와 비사용자 리뷰를 무시하고 정확한 head SHA의 승인만 세는 규칙(`decision.ts:72-96`), 변경 파일이 없는 PR의 T3 분류(`policy.ts:219`), 300000자 초과 diff의 `diff_too_large` 실패(`review-prompt.ts:13,38-39`).
- **누락 (부수 효과):** GitHub App 설치 토큰 발급 호출과 저장소별 캐시(`github-publisher.ts:114-154`, `github-pulls.ts:44-69`), blob·tree 생성(`github-publisher.ts:261-275`), 운영자 리뷰의 OAuth 범위 `public_repo`와 PR 사전 조회(`review.ts:19,204-227`), OAuth·리뷰 쿠키 수명 600초.
- **누락 (공개 심볼):** `IllegalTransitionError`, `PublishRejected`, `ChecksPermissionMissing`, `LoginFailed`, `AgentSandbox.startReviewSandbox`, `DEFAULT_IMPLEMENT_MODEL`, `DEFAULT_REVIEW_MODEL`, `SECURITY_HEADERS`, `BETA_ALLOWLIST` 등이 계약에 없다.

## apps/control/migrations/README.md

테이블, 열, 인덱스, 트리거 이름과 `CHECK` 목록, 최신 `events.reason_code` 목록과 코드의 `REASON_CODES` 일치는 확인되었다. 차이는 다음과 같다.

- **부정확:** "`src/d1-*.test.ts`가 마이그레이션을 적용한 D1에서 실행된다"와 달리 테스트는 D1이 아니라 D1 형태 어댑터를 씌운 메모리 `node:sqlite`에서 실행되며 `PRAGMA foreign_keys = ON`을 켠다(`src/testing/d1.ts:12-18`).
- **부정확:** 순서 의존성 설명이 실제 제약과 다르다. 0004와 0005는 `IF EXISTS` 없는 `DROP TRIGGER`와 고정 7개 열 복사에 의존한다(`0004:6-7,32-33`). 0006의 `ADD COLUMN`은 어떤 `runs`에도 동작하므로 0003 의존이라는 설명은 과하다.
- **누락:** `run_usage`의 `id INTEGER PRIMARY KEY AUTOINCREMENT`와 모든 열의 NOT NULL. `run_usage.phase`, `run_usage.model`, `runs.tier`, `runs.title`, `runs.head_sha`에도 `CHECK`가 없다.
- **누락:** 앞으로 `runs`를 재생성하는 마이그레이션은 `events`와 `run_usage`를 먼저 옮기거나 지워야 한다(외래 키). 문서는 `events` 재생성만 안내한다.
- **누락:** 0003의 행 재작성은 `events` 행을 추가하지 않는다. 인덱스 조건이 `NOT IN ('pr_opened','failed')`에서 바뀐다. 0004는 과거 `pr_closed` 실행을 일부러 재작성하지 않는다(`0004:3-4`).
- **누락:** 프로덕션 적용은 `deploy.yml:23-31`이 `wrangler deploy` 전에 원격으로 한다. 코드와 `CHECK`의 불일치는 `d1-repo.test.ts:151-172`가 잡는다. `read-repo.ts:141`은 모르는 사유 코드를 `null`로 바꾼다.

## apps/portal/README.md

- **부정확:** CSP 목록에 `img-src 'self'`, `font-src 'self'`, `connect-src 'self'`, `form-action 'self'`가 빠져 있다(`public/_headers:4`).
- **누락:** `src/safety.test.ts`가 CSP 값과 `index.html`의 인라인 스크립트·스타일·`on*=` 금지를 시험으로 강제한다. `tsconfig.json`의 `types: ["vite/client"]`도 이 시험에 필요하다.

## apps/portal/src/README.md

공개 심볼 목록, 엔드포인트 표, 라우터 정규식, `dom.ts:h` 거부 규칙, 운영자 버튼 표시 조건, `isGithubAuthorize`는 코드와 일치했다. 차이는 다음과 같다.

- **틀림:** SPA 링크 처리가 "같은 출처일 때만 동작한다"고 했지만, 코드는 출처 검사 전에 `event.preventDefault()`를 호출한다(`app.ts:232-234`). 따라서 다른 출처의 `a[data-link]` 클릭은 아무 이동도 하지 않는다. 또 `go(url.pathname)`은 쿼리와 해시를 버린다.
- **부정확:** 중지 후 조회는 즉시 1회 후 3000 ms 간격 최대 20회로 모두 21회다. 종료 상태면 일찍 멈추고 다시 그리며, 한도에 이르면 수동 새로고침 버튼을 보여 준다. 조회 오류는 삼킨다(`views.ts:644-675`).
- **부정확:** 1200 ms는 `replay.ts`가 아니라 `views.ts:67`의 `REPLAY_INTERVAL_MS`가 정해 전달한다.
- **부정확:** `?review=` 값이 `REVIEW_NOTICES`에 없으면 URL에 남는다. 정리할 때는 다른 쿼리도 모두 지운다(`app.ts:244-252`). 저장소 이름 규칙은 문자 집합과 100자 제한도 포함한다(`router.ts:9`).
- **누락:** 오류 응답 본문에 `error`가 없으면 코드가 `"error"`가 되고, 성공 응답이 JSON이 아니면 `null`을 반환한다(`api.ts:103-116`). 화면이 처리하는 오류 코드(`merge_attempted`, `not_active`, `head_changed`, `not_awaiting_approval` 등; `views.ts:443-507`)가 문서에 없다. `startLogin`의 사전 확인이 예외를 던지면 무시하고 이동한다(`api.ts:167-171`).
- **누락:** 404 외 오류에는 "다시 시도" 버튼이 있는 오류 화면을 보인다(`app.ts:199-212`). 같은 루트에 다시 `mountApp`하면 이전 마운트를 먼저 정리한다(`app.ts:45-49`). 승인 후 `ctx.navigate(redirect)`로 사이트를 떠난다(`views.ts:478`).
- **부정확:** 운영자는 "승인"과 "수정 요청" 두 동작을 할 수 있다(`views.ts:470-471`). happy-dom 환경은 `app.test.ts`만 쓴다.

## experiments/README.md

No drift detected. (참고: 실험 디렉터리는 ESLint와 Prettier 대상에서도 제외된다. `eslint.config.js:8`, `.prettierignore:4`)

## experiments/sandbox-spike/README.md

- **누락:** 파일 표에 `package-lock.json`이 없다. 이 실험은 pnpm이 아니라 npm 잠금 파일을 쓴다.
- **누락:** 실험의 GitHub 허용 규칙은 저장소에 묶여 있지 않다(`src/outbound.ts:44-45`). 제품은 바인딩된 저장소만 허용하므로 이 차이를 적어 둘 만하다.

## experiments/sandbox-spike/src/README.md

- **틀림:** `start`도 `{ exitCode, stdout, stderr }`를 반환한다고 했지만 실제로는 `{ running, instance }`를 반환한다(`sandbox.ts:53-57`).
- **틀림:** "요청 실패는 `console.error`로 남긴다"가 `Outbound`의 동작처럼 쓰였지만 `console.error`는 Worker 진입점에 있다(`index.ts:60`). `Outbound`는 `console.log`만 쓴다.
- **틀림:** `readDiff`를 읽기 동작으로 설명했지만 `git add --intent-to-add .`를 먼저 실행해 인덱스를 바꾼다(`sandbox.ts:112`).
- **누락:** `setUpSandbox`는 멈춘 컨테이너를 시작할 때 `task` 키를 지운다(`sandbox.ts:188-189`). 그래서 다른 호출이 먼저 컨테이너를 시작하면 `readTask`는 `lost` 대신 `none`을 보고한다. pid 파일이 없고 `task` 키가 있으면 `boot_id` 확인 없이 `running`으로 본다(`sandbox.ts:211-218`).
- **누락:** `readLog`의 `file` 값은 검사 없이 경로에 들어가므로 `../`로 작업 디렉터리를 벗어날 수 있다(`sandbox.ts:106`). 일회성 실험이지만 토큰 소지자에게 열린 경로다.
- **부정확:** 에이전트 명령의 인자가 일부만 적혀 있다(claude의 `--verbose`, `--dangerously-skip-permissions`, `--no-session-persistence`, `--model`; pi의 `--no-session`, `--model`; `sandbox.ts:150-171`). 각 에이전트는 자기 공급자의 자리표시자 키 하나만 받는다.
- **부정확:** 컨테이너가 꺼져 있으면 `alarm()`은 `task` 키를 지우지 않고 끝난다(`sandbox.ts:89`). `leakCheck`의 `scannedBytes`는 숫자다. `/workspace/repo`는 코드가 지우지 않는다.
