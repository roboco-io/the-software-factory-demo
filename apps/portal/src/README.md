# portal/src

## Overview

이 디렉터리는 포털 웹앱의 소스 코드다. 포털은 프레임워크 없이 TypeScript와 DOM API만으로 만든 단일 페이지 앱(SPA)이다. 포털은 제어 평면 Worker(`apps/control`)의 `/api/*` 엔드포인트를 같은 출처(same-origin) 쿠키 인증으로 호출하고, 관리 프로젝트 목록, 프로젝트별 실행(run) 목록, 실행 상세 화면을 그린다. 실행 상세 화면에서 운영자(`operator`) 역할의 사용자는 실행을 중지하거나, 승인 대기 중인 PR에 "승인" 또는 "수정 요청"(`request_changes`) 리뷰를 남길 수 있다.

모듈은 역할별로 나뉜다. `main.ts`는 시작점이고, `app.ts`는 화면 틀과 라우팅을 맡고, `views.ts`는 각 화면을 그린다. `api.ts`는 HTTP 클라이언트이고, `router.ts`는 경로를 해석한다. `dom.ts`는 안전한 DOM 생성 도우미다. `flow.ts`, `labels.ts`, `console-labels.ts`, `replay.ts`는 DOM과 네트워크에 의존하지 않는 표시용 계산 모듈이다.

## Interface

| 파일                | 공개 심볼                                                                                                                                                                                                      | 설명                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`           | (export 없음)                                                                                                                                                                                                  | `#app` 요소를 찾으면 `mountApp(root, { api: createApi(call), startLogin })`를 호출한다. `#app`이 없으면 아무것도 하지 않는다. |
| `app.ts`            | `mountApp(root, options)`, `AppOptions`                                                                                                                                                                        | 헤더, 역할 영역, 배너, 본문을 그리고 경로에 맞는 화면을 렌더링한다. 정리(destroy) 함수를 반환한다.                            |
| `api.ts`            | `createApi(fetchFn)`, `startLogin(fetchFn, go)`, `ApiError`, `Api`, `Role`, `Me`, `Project`, `Counts`, `RunSummary`, `RunDetail`, `RunsPage`, `EventItem`, `RunCost`, `TokenUsage`, `PathStep`, `ReviewAction` | 제어 평면 API 클라이언트와 응답 타입.                                                                                         |
| `router.ts`         | `matchRoute(pathname)`, `Route`                                                                                                                                                                                | 경로를 `home`, `projects`, `project`, `run`, `notFound` 중 하나로 해석한다.                                                   |
| `dom.ts`            | `h`, `link`, `githubLink`, `projectPath`, `runPath`, `formatTime`, `Child`, `Attrs`                                                                                                                            | DOM 요소 생성, 내부 링크와 GitHub 외부 링크 생성, 시간 표시.                                                                  |
| `views.ts`          | `homeView`, `projectsView`, `projectView`, `runView`, `notFoundView`, `messageBox`, `View`, `ViewContext`                                                                                                      | 각 화면을 그린다. `View.cleanup`은 화면을 떠날 때 타이머를 멈춘다.                                                            |
| `flow.ts`           | `STAGES`, `stageCells(run, now)`, `stageCounts(runs, now)`, `durationText(ms)`, `StageStatus`, `StageCell`, `PathStep`                                                                                         | 실행 상태를 7단계 보드(intake, implement, pr, review, checks, approval, merge)로 변환한다.                                    |
| `labels.ts`         | `STATE_LABELS`, `EVENT_KIND_LABELS`, `REASON_LABELS`, `describeOutcome`, `describeNextStep`, `stateLabel`, `reasonLabel`, `Tone`, `Label`, `ReasonLabel`, `Outcome`, `NextStep`                                | 상태 값, 이벤트 종류, 사유 코드(reason code)를 한국어 문구와 톤으로 바꾼다.                                                   |
| `console-labels.ts` | `tokenTotal`, `tokenCount`, `tokenCountShort`, `moneyText`, `costLine`, `costUsdText`, `isAttention`, `shortSha`, `isGithubAuthorize`, `RunCostLike`, `TokenUsageLike`                                         | 토큰 사용량과 비용 표시, 주의 필요 실행 판정, GitHub 인가 URL 검사.                                                           |
| `replay.ts`         | `createReplay({ total, intervalMs, onChange })`, `Replay`, `ReplayState`                                                                                                                                       | 이벤트 타임라인을 한 단계씩 재생하는 타이머 기반 스테퍼.                                                                      |

`createApi`가 호출하는 엔드포인트는 다음과 같다(모두 `credentials: "same-origin"`).

| 메서드 | 경로                                                      | 호출 함수                     |
| ------ | --------------------------------------------------------- | ----------------------------- |
| GET    | `/api/me`                                                 | `me()`                        |
| GET    | `/api/projects`                                           | `projects()`                  |
| GET    | `/api/projects/{owner}/{name}/runs?limit=20[&cursor=]`    | `runs(repo, cursor?)`         |
| GET    | `/api/runs/{id}`                                          | `run(id)`                     |
| POST   | `/api/runs/{id}/stop`                                     | `stop(id)`                    |
| POST   | `/api/runs/{id}/review` (JSON 본문 `{ action, headSha }`) | `review(id, action, headSha)` |
| POST   | `/api/auth/logout`                                        | `logout()`                    |
| HEAD   | `/api/auth/login` (`redirect: "manual"`)                  | `startLogin` 사전 확인        |

## Invariants

- 신뢰할 수 없는 문자열은 HTML로 해석하지 않는다. `dom.ts:h`는 문자열 자식을 `document.createTextNode`로 넣고 속성은 `setAttribute`로 설정한다. 소스 파일에는 `innerHTML`이나 `insertAdjacentHTML`이 없다. `safety.test.ts`가 이를 시험으로 강제하며, `outerHTML`, `document.write`, `eval(`, `new Function`, 문자열 `setTimeout`, `setAttribute("style"|"on…")`도 금지한다.
- `dom.ts:h`는 `on`으로 시작하는 속성 이름과 `style` 속성을 거부하고 `Error`를 던진다. 이는 `public/_headers`의 CSP(`script-src 'self'; style-src 'self'`)와 짝을 이룬다.
- `router.ts:matchRoute`는 끝의 `/` 하나를 지운 뒤 경로를 해석한다. GitHub 소유자 이름 규칙(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`), 저장소 이름 규칙(`^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$`, 즉 `.`과 `..`를 거부하고 100자 이하), 실행 ID 규칙(`^[A-Za-z0-9_-]{1,64}$`)에 맞지 않는 경로를 모두 `notFound`로 처리한다.
- `dom.ts:githubLink`는 저장소 이름이 위 규칙에 맞고 번호가 1 이상의 안전한 정수일 때만 링크를 만들며, `rel="noopener noreferrer"`를 붙인다. `projectPath`, `runPath`, `api.ts`의 경로 조립은 각 경로 조각을 `encodeURIComponent`로 인코딩한다.
- 운영자 기능은 화면에서 역할로 가린다. 중지 버튼은 `me.role === "operator"`이고 상태가 종료 상태(`merged`, `needs_human`, `failed`)가 아닐 때만 보인다. 승인 버튼은 `operator`이고 상태가 `awaiting_approval`이며 `headSha`가 있을 때만 보인다(`views.ts:runView`). 실제 권한 검사는 서버가 한다. 포털의 이 가림은 표시용이다.
- 승인 요청 후 이동은 `console-labels.ts:isGithubAuthorize`가 `https://github.com/login/oauth/authorize` 또는 그 뒤에 `?`가 붙은 URL로 확인한 경우에만 한다(`views.ts:approveControl`).
- `api.ts`의 요청이 네트워크 오류로 실패하면 `ApiError(0, "network")`를 던진다. 응답이 성공이 아니면 본문의 `error` 값을 코드로 하는 `ApiError(status, code)`를 던지며, 본문이 JSON이 아니거나 `error`가 없으면 코드는 `"error"`다. 성공 응답은 형식 검사 없이 타입 단언(`as T`)으로 반환하고, 본문이 JSON이 아니면 `null`을 반환한다. 예외로 `review`는 문자열 `redirect`가 없으면 `ApiError(200, "bad_response")`를 던진다.
- 화면이 구분해 처리하는 오류 코드: 중지는 `merge_attempted`, `not_active`, `not_found`, `unauthenticated`, `forbidden`, 리뷰는 `unauthenticated`, `forbidden`, `not_found`를 문구로 바꾼다. 리뷰의 `head_changed`와 `not_awaiting_approval`은 알림 후 화면을 다시 불러온다(`views.ts`). 로그인 배너는 `auth_not_configured`를 구분한다(`app.ts`).
- `startLogin`의 사전 확인 응답이 503이면 `ApiError(503, "auth_not_configured")`를 던지고 이동하지 않는다. 사전 확인 요청 자체가 예외를 던지면 무시하고 로그인 경로로 이동한다.
- `app.ts:render`는 세대 카운터로 늦게 도착한 이전 렌더링 결과를 버리고 그 화면의 `cleanup`을 호출하며, 새 렌더링 전에 이전 화면의 `cleanup`을 호출한다. API가 404를 반환하면 `notFoundView`를, 그 밖의 오류에는 "다시 시도" 버튼이 있는 오류 화면을 보여 준다. 같은 루트에 `mountApp`을 다시 호출하면 이전 마운트를 먼저 정리한다(`WeakMap`).
- `app.ts`의 SPA 링크 처리는 이미 `defaultPrevented`가 아닌, 수정 키 없는 기본 버튼 클릭이고 대상이 `a[data-link]`일 때 동작한다. 이때 `event.preventDefault()`를 먼저 호출한 뒤 출처를 확인하므로, 다른 출처를 가리키는 `a[data-link]`를 클릭하면 아무 이동도 일어나지 않는다. 같은 출처면 `go(url.pathname)`으로 이동하며 쿼리와 해시는 버린다. 쿼리 `?review=`는 `REVIEW_NOTICES`에 있는 값만 반영하고 URL에서 지운다. 이때 URL은 경로만 남기므로 다른 쿼리도 함께 지워진다. `REVIEW_NOTICES`에 없는 값은 URL에 그대로 남는다.
- `api.me()`가 실패하면 역할을 `anonymous`로 간주한다(`app.ts:refreshMe`).
- `labels.ts`는 모르는 상태 값에 "알 수 없음" 문구를 쓰고, `views.ts:eventItem`은 모르는 이벤트 종류에 고정 문구를 쓴다. `reasonLabel`은 모르는 사유 코드에 `undefined`를 반환한다.
- `flow.ts:stageCells`는 `needs_human`과 `failed`를 "멈춤"으로 표시하고, 실행 경로(`path`)에서 마지막으로 들어간 단계에 멈춤 표시를 둔다. 단계 상태는 색상만이 아니라 `aria-label`과 `title` 문구로도 표시한다(`views.ts:rail`).

## Side Effects

- 네트워크: 위 표의 `fetch` 호출. 로그인은 `window.location.assign("/api/auth/login")`으로 이동한다(`main.ts`). 리뷰 요청 후에는 `ctx.navigate(redirect)`(기본값 `window.location.assign`, `AppOptions.navigate`로 바꿀 수 있음)로 GitHub 인가 페이지로 이동한다. `projectView`는 `runs()`와 함께 `projects()`를 호출하고 그 실패는 무시한다. "더 보기"는 다음 페이지를 이미 읽은 실행 목록에 덧붙인다.
- DOM: `app.ts:mountApp`이 루트 요소의 자식을 교체하고 `document.title`을 바꾼다. 각 화면은 자기 컨테이너를 `replaceChildren`/`append`로 갱신한다.
- 히스토리: `app.ts`가 `history.pushState`로 이동하고, `?login=failed`나 `?review=` 표시를 `history.replaceState`로 지운다. `popstate`와 루트 `click` 리스너는 정리 함수에서 제거한다.
- 타이머: 중지 요청 후 `views.ts:stopControl`은 `run(id)`를 즉시 한 번 조회하고, 이어서 3000 ms 간격으로 최대 20회 더 조회한다. 상태가 종료 상태가 되면 조회를 멈추고 화면을 다시 불러온다. 한도에 이르면 중지 요청이 아직 적용되지 않았다는 안내와 수동 새로고침 버튼을 보여 준다. 조회 오류는 무시한다. 이벤트 재생은 `replay.ts:createReplay`가 받은 `intervalMs` 간격의 `setInterval`을 쓰며, `views.ts`의 `REPLAY_INTERVAL_MS`(1200 ms)를 넘겨받는다. 두 타이머는 `View.cleanup`에서 멈춘다.
- 저장소(localStorage, sessionStorage, 쿠키 직접 접근)는 쓰지 않는다. `flow.ts`, `labels.ts`, `console-labels.ts`, `router.ts`는 부수 효과가 없다.

## Verification

- Run: `pnpm --filter @factory/portal test` (Vitest로 `*.test.ts` 실행. DOM이 필요한 `app.test.ts`만 `@vitest-environment happy-dom`을 쓴다)
- 타입 검사: `pnpm --filter @factory/portal typecheck`
