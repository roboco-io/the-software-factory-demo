<!-- README에서 분리한 설정·운영·리허설 안내입니다. -->

# 개발자·운영자 안내

아래는 팩토리를 설치하거나 운영하고, 데모를 재현하는 사람을 위한 상세 안내입니다.

- 설계: [소프트웨어 팩토리 설계 문서](superpowers/specs/2026-10-11-software-factory-design.md)
- 개발 지침: [AGENTS.md](../AGENTS.md)
- 웹: React + Vite, GitHub Pages 배포
- API: Hono, Cloudflare Workers + D1 배포 — <https://sfd-api.roboco.workers.dev/api>
- 팩토리: GitHub Issues/Actions, 단계별 AI 에이전트, 위험 정책과 검증 절차

## 운영자 안내: 팩토리 설정과 실행

- 이슈를 열면 트리아지 코멘트가 달린다. 리포 쓰기 권한자가 `@factory go`를 남기면 구현 → 교차 리뷰 → 체크 → 병합 → 배포가 진행된다. `@factory stop`은 진행 중인 run을 취소하고 사람에게 넘긴다.
- 자동 병합은 위험 등급 T0·T1만 한다. T2·T3 PR은 CODEOWNERS 승인 후 사람이 병합한다. T2 봇 PR은 교차 리뷰가 현재 head를 승인할 때까지 T1과 같은 수정 라운드를 거친 뒤 사람에게 넘어온다. T3 봇 PR은 CI 직후 바로 사람에게 넘어온다. T0·T1 봇 PR은 PR 프리뷰에서 앱 E2E(`e2e-preview`)와 프로덕션 읽기 전용 스모크(`smoke-preview`)가 끝난 뒤 병합된다. `smoke-preview`가 실패하면 변경이 스모크 계약을 깬 것이므로 이슈가 `factory:needs-human`으로 넘어온다. 의도한 변경이면 사람이 `tests/smoke/`나 `apps/web/e2e-smoke/`를 갱신하는 PR을 먼저 병합한다. 트리아지 코멘트에 "먼저 갱신할 보호 계약"이 있으면 `@factory go` 전에 그 갱신부터 한다. 봇 PR 본문에 "사람 조치 필요" 절이 있거나, 필수가 아닌 체크가 실패했거나, 리뷰가 에이전트가 고칠 수 없는 지적을 남기면 이슈가 `factory:needs-human`으로 넘어온다.
- 런 기록: `factory-data` 브랜치의 `runs/YYYY-MM.jsonl`. 실패율 차단기가 작동하면 리포 변수 `FACTORY_PAUSED`가 `true`가 되고 `factory:alert` 이슈가 열린다. 원인을 확인한 뒤 변수를 `false`로 바꾸면 재개한다.
- 처음 설정: 시크릿 `FACTORY_APP_ID`, `FACTORY_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `DEEPSEEK_API_KEY`와 리포 변수 `FACTORY_BOT_USER_ID`, `CODEX_MODEL`(필수), `CLAUDE_MODEL`, `PI_MODEL`, `FACTORY_DAILY_LIMIT`, `FACTORY_PAUSED`를 둔다. 그다음 App 토큰을 `FACTORY_TOKEN`에 넣고 `pnpm -s factory bootstrap`을 한 번 실행해 라벨과 `factory-data` 브랜치를 만든다(다시 실행해도 결과가 같다). P3부터는 GitHub environment `production`에 secret `INTAKE_TOKEN`(임의의 64자 16진수)도 둔다. `deploy` 워크플로가 배포마다 같은 값을 Worker secret으로 넣는다. P4부터는 App에 조직 권한 Projects(Read and write)를 더해야 한다. 권한을 더한 뒤 `bootstrap`을 다시 실행하면 org 보드 "Software Factory"와 `Factory` 필드가 생긴다. 보드는 비공개로 생성된다. App은 공개 범위를 바꿀 수 없으므로, 데모에서 공개하려면 org 관리자가 보드 설정에서 직접 바꾼다.
- prepare job이 이슈를 `factory:in-progress`로 옮긴 뒤 실패하면(agent·publish job이 돌지 않음) 이슈가 `factory:in-progress`에 남는다. `@factory retry`는 `in-progress` 상태에서는 거부되므로, 쓰기 권한자가 `@factory stop`을 남겨 `factory:needs-human`으로 옮긴 다음 `@factory retry`로 다시 시작한다. `guard` 워크플로는 이 상태를 자동으로 복구하지 않는다.
- 연속 병합으로 대기 중이던 `deploy` run이 더 새 run으로 대체되어 취소되면, 다음 배포의 `deployed` 단계가 앞선 main 커밋(최근 14일, 최대 50개)의 이슈 가운데 아직 `factory:merged`로 열린 것도 함께 배포 완료로 옮긴다(PR #52). 이 범위를 벗어난 이슈는 배포가 성공했는지 확인한 뒤 `pnpm -s factory deployed --sha <sha>`로 반영한다(`FACTORY_TOKEN` 필요).
- GitHub API가 일시적인 5xx 오류를 내면 단계가 재시도 없이 실패할 수 있다. 실패한 run을 `gh run rerun <run-id> --failed`로 다시 실행한다.
- 리뷰가 멈췄거나 리뷰 run이 취소되어 PR이 `factory:in-review`에 남으면 `gh workflow run factory-review.yml -f pr=<n> -f issue=<n>`으로 리뷰를 다시 시작한다(`<n>`은 각각 PR 번호와 이슈 번호).

## 운영자 안내: 오류·피드백 수집과 수정 증거

- `evidence` 필수 체크: PR 본문의 팩토리 표식이 가리키는 이슈에 `type:bug` 라벨이 있으면, PR이 추가·수정한 테스트 파일만 base 커밋 트리에 덮어써 실행해 실패하고, head 트리에서 같은 테스트가 통과해야 한다. 그 밖의 PR은 즉시 통과한다. 실행 대상은 Vitest 파일(`*.test.ts`, `*.test.tsx`)이고, Playwright E2E(`apps/web/e2e/`)는 실행하지 않는다. 판정 코드는 base 커밋의 팩토리 CLI이며, PR 코드는 시크릿과 GitHub 토큰이 없는 `evidence` job에서만 실행된다.
- 에러 유입: Worker가 처리하지 못한 예외는 `error_events` 테이블에 fingerprint(정규화한 메시지와 스택 상위 3프레임의 해시) 단위로 모인다. `factory-intake` 워크플로(매시 7분·37분)가 미확인 항목을 읽어 `source:error`·`type:bug` 이슈를 만들거나, 같은 fingerprint의 열린 이슈에 누적 횟수를 코멘트한다.
- 피드백 유입: 웹 푸터의 "피드백" 버튼으로 익명 의견을 받는다. API는 IP 원문을 저장하지 않고 `SHA-256(IP + INTAKE_TOKEN)`만 저장하며, 같은 해시는 10분에 3건까지 받는다. 건마다 `source:feedback` 이슈가 된다.
- 스모크 유입: `factory-smoke` 워크플로(6시간마다)가 프로덕션에 읽기 요청만 보낸다(Hurl `tests/smoke/readonly.hurl`, Playwright `apps/web/e2e-smoke/`). 실패하면 `source:smoke` 이슈를 만들거나 열린 이슈에 코멘트하고, 다음 성공 때 "복구됨" 코멘트를 남긴다. 이슈 종료는 사람이 정한다.
- 유입 이슈는 자동으로 트리아지되지만, 구현은 리포 쓰기 권한자의 `@factory go`가 있어야 시작한다.
- `INTAKE_TOKEN`: 원본은 GitHub environment `production`의 secret이다. 값을 바꾸려면 secret을 바꾼 뒤 `deploy` 워크플로를 다시 실행한다. 검증용 로컬 사본은 `~/.config/sfd-intake-token`(권한 600)에만 두고 터미널에 출력하지 않는다. 프리뷰 Worker에는 이 값을 넣지 않으므로 프리뷰의 수집 엔드포인트는 항상 404다.
- 수동 실행: `gh workflow run factory-intake.yml`, `gh workflow run factory-smoke.yml`.
- 스모크 실패 주입: `gh workflow run factory-smoke.yml -f api_base=https://sfd-api.roboco.workers.dev/api/__smoke_injected_failure`. 존재하지 않는 경로라 `/health`가 404가 된다. 입력 없이 다시 실행하면 복구를 확인할 수 있다. `api_base`는 프로덕션 API 주소 자신이나 그 하위 경로만 받는다. 다른 값을 주면 `target` job이 실패하고 스모크 검사와 이슈 기록은 실행되지 않는다.
- 에러 주입: `POST /api/_factory/intake/probe`에 `Authorization: Bearer <INTAKE_TOKEN>`을 보내면 의도적 예외가 하나 기록된다(응답 500). 토큰이 없거나 틀리면 다른 미지 경로와 같은 404다. 토큰이 명령줄·셸 기록에 남지 않게 헤더를 파일 디스크립터로 넘긴다:
  `curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H @<(printf 'Authorization: Bearer %s\n' "$(cat ~/.config/sfd-intake-token)") https://sfd-api.roboco.workers.dev/api/_factory/intake/probe`
  예약 수집(매시 7분·37분)을 기다리지 않으려면 probe 직후 `gh workflow run factory-intake.yml`을 실행한다. 같은 probe를 다시 보내고 수집하면 열린 이슈에 "누적 2회" 코멘트가 달린다.

## 운영자 안내: 주간 실행과 자가 개선

`factory-weekly` 워크플로는 매주 월요일 00:00 UTC에 실행된다. 수동으로 실행하려면 `gh workflow run factory-weekly.yml`을 쓴다. 먼저 `report` job이 지난 주의 주간 리포트 이슈를 만든다. 이 이슈에는 런 기록에서 계산한 지표(완주율, 엔진별 성공률과 비용), 실패 범주별 횟수, 표본 수가 기준에 못 미칠 때의 표시, 이전에 병합된 개선 규칙의 적용 전후 비교가 들어간다. 개선 이력은 `factory-data` 브랜치의 `improvements.json`에 쌓인다.

같은 범주의 실패가 서로 다른 이슈 3건 이상에서 반복되면 그 범주가 개선 후보가 되고, `prepare`·`agent`·`publish` job이 차례로 돈다. 후보가 없으면 이 세 job은 `skipped`로 끝난다. improve 에이전트는 `AGENTS.md`, `factory/prompts/**`, `eslint.config.*`, `factory/evals/**`만 고칠 수 있으며, 고친 결과는 PR로 열리고 `factory:improve` 라벨이 붙는다. `eval` 체크는 이 라벨이 아니라 PR 본문 메타와 작성자로 개선 PR을 판별한다. 이 PR은 `factory/`와 `AGENTS.md`를 바꾸므로 T3이고, 사람(CODEOWNERS)이 승인하기 전에는 병합되지 않는다.

`eval` 필수 체크는 모든 PR에서 돈다. 모든 PR에서 head 트리의 평가 케이스(`factory/evals/**`)가 모두 계속 잡혀야 하며, 이는 이전에 막은 실패가 다시 살아나지 않게 하는 회귀 방지 검사다. 봇이 연 개선 PR(PR 본문 메타의 `role=improve`이고 작성자가 봇인 PR)은 여기에 더해 새 평가 케이스를 1개 이상 추가해야 한다. 각 새 케이스는 base 규칙으로는 잡히지 않고 head 규칙으로는 잡혀야 하며, 그래야 이 PR이 실제로 규칙을 바꾼 것이 증명된다. 봇 PR은 기존 평가 케이스를 지우거나 내용을 바꿀 수 없다. 사람이 연 PR은 케이스를 지울 수 있다. 판정은 시크릿과 GitHub 토큰이 없는 job에서 하며, PR의 ESLint 설정은 별도 자식 프로세스에서 실행한다.

보고 화면은 두 곳이다. 대시보드 <https://roboco.io/the-software-factory-demo/factory/>는 브라우저가 `factory-data` 브랜치의 런 기록과 `improvements.json`을 `raw.githubusercontent.com`에서 직접 읽어 그린다. 요청별 처리 과정, 개선 PR과 병합 전후 관찰 기록, 역할·에이전트 도구·사용 모델별 실행 결과를 보여 준다. 비용은 보고된 실행의 합계이며 누락된 비용은 별도로 표시한다. 그래서 새 런 기록이 Pages 재배포 없이 반영된다. 다만 GitHub의 CDN 캐시 때문에 최대 5분 늦을 수 있다. Projects 보드 <https://github.com/orgs/roboco-io/projects/3>의 `Factory` 필드는 팩토리가 상태 라벨을 바꿀 때마다 같은 값으로 바뀐다. 동기화가 실패해도 상태 전이는 계속되며, `guard`가 매시 17분에 어긋난 항목을 맞춘다.

`factory-eval-live`는 개선 PR의 효과를 실제 에이전트로 확인하는 수동 워크플로다. `gh workflow run factory-eval-live.yml -f pr=<개선 PR> -f issue=<리포트 이슈>`로 실행한다. 이 워크플로는 개선 전 규칙과 개선 후 규칙으로 같은 과제를 각각 구현·리뷰하게 하고, 리뷰 범주를 비교한 결과를 PR 코멘트로 남긴다. 실행 전에 일시 중지(`FACTORY_PAUSED`)와 일일 상한을 확인하지만, 런 기록을 남기지 않으므로 상한 계산과 주간 지표에는 집계되지 않는다. 리포트 이슈에 `@factory stop`을 남기면 이 실행도 취소된다. agent job의 제한 시간 120분은 실측이 아닌 추정치다.

## 운영자 안내: 자동 포스트모템

프로덕션 장애와 요청 정체가 생기면 팩토리가 자동으로 원인을 분석하고 포스트모템 기록을 남긴다. 프로덕션 장애는 `source:smoke`, `source:deploy`, `source:error` 이슈이고, 정체는 요청 이슈가 `factory:needs-human`으로 옮겨진 경우다. 사람이 `@factory stop`으로 옮긴 `needs-human`은 정체로 보지 않는다. 분석은 각 단계가 장애 이슈를 처음 만들거나 상태를 옮기는 시점에 `factory-postmortem` 워크플로를 dispatch해 시작하며, 복구가 확인되면 사후 분석을 한 번 더 실행한다. 정기 스모크 주기를 기다리지 않는다. 분석 결과는 장애 이슈에 고정된 코멘트 하나로 쓰고 갱신한다. 닫힌 이슈 이벤트(`source:smoke`·`source:deploy`·`source:error` 또는 `factory:` 상태 라벨이 있는 이슈)도 사후 분석 후보로 같은 워크플로를 시작한다. 이때 장애 종류는 이슈 라벨로 정한다. `source:smoke`·`source:deploy`·`source:error`이면 각각 스모크·배포·에러 장애로, 어느 것도 없으면 정체로 본다.

어떤 사건을 분석할지, 비용과 보고서 길이는 `factory/postmortem-policy.yml` 한 파일이 정한다. 기본값은 장애당 분석 2회(1차와 사후 각 1회), 분석 1회당 2 USD와 15분, 하루 합계 10 USD, 보고서 6000자이다. 예산을 바꾸려면 이 파일의 `budget` 값을 고치는 PR을 연다. 이 파일은 `factory/` 아래라 T3이므로 CODEOWNERS 승인 뒤에만 병합된다. 일일 상한에 도달하면 이후 장애는 분석 없이 사실 수집 결과만 장애 이슈에 남긴다. 분석이 시간 초과나 출력 형식 오류로 실패하면 재시도하지 않고 사유만 남긴다. 분석 에이전트의 엔진은 `factory/agents.yml`의 `postmortem` 역할이, 모델은 그 엔진의 환경 변수(예: `CLAUDE_MODEL`)가 정한다.

되돌리기는 에이전트가 아니라 코드가 판정하며, 다음 조건을 모두 충족할 때만 한다. 프로덕션 장애이고 분류가 봇 PR 회귀 또는 사람 PR 회귀이며, 원인 PR이 타임라인 후보 PR 중 하나이고, 실패 원문이 있고, 에이전트가 인용한 구절이 그 원문에 글자 그대로 있고, 인용에서 뽑은 단어가 원인 PR의 변경 파일 경로나 변경 줄과 겹치고, 원인 PR이 아직 되돌려지지 않았고, `git revert`가 충돌하지 않는 경우다. 하나라도 어긋나면 되돌리지 않고 진단만 장애 이슈에 남기며, 거절 사유는 코멘트에 코드로 적힌다. 거절 사유 코드는 `disabled`(정책에서 끔), `not_production_breakage`(배포 실패나 정체), `not_regression`(회귀가 아님), `no_cause`(원인 PR 없음), `unknown_cause`(후보에 없는 PR), `no_excerpt`(실패 원문 없음), `quote_not_in_excerpt`(인용이 원문에 없음), `no_overlap`(변경 파일과 겹치지 않음), `already_reverted`(이미 되돌려짐)이다. 충돌은 git 결과로 판정한다.

되돌리기 PR도 `factory/risk-policy.yml`의 위험 등급을 따른다. T0·T1이고 모든 체크가 통과하면 교차 리뷰 없이 자동 병합한다. T2·T3이면 PR만 열고 장애 이슈에 CODEOWNERS 승인 요청을 남긴다. 마이그레이션 파일은 되돌리지 않는다. 되돌리기 PR의 체크가 실패하면 수정 라운드나 새 포스트모템을 시작하지 않고 장애 이슈에 코멘트만 남긴다. 되돌리기 커밋이 배포되면 전체 스모크를 한 번 실행해 복구를 확인한다. 복구가 확인되면 원인 PR의 요청 이슈를 다시 열고 되돌린 이유를 남기지만, 다시 구현하려면 사람이 `@factory go`를 남겨야 한다.

과거 장애나 임의 장애를 다시 분석하려면 dry-run으로 실행한다. 이 모드는 새 이슈에만 결과를 쓰고 원래 장애 이슈와 되돌리기 PR은 건드리지 않는다. 입력 `issue`는 장애 이슈 번호(정체는 요청 이슈 번호), `kind`는 `smoke`·`deploy`·`error`·`stall` 중 하나, `event`는 `detected`(1차 분석) 또는 `recovered`(사후 분석)이다. `gh workflow run factory-postmortem.yml -f issue=<이슈> -f kind=<smoke|deploy|error|stall> -f event=detected -f dry_run=true -f excerpt="<실패 원문 끝부분>"`을 쓴다. 이슈에 실패 원문이 없으면(예: PR #74 이전의 스모크 이슈 #66) 해당 스모크 run 로그에서 복사해 `excerpt`로 넣는다.

봇 PR 회귀를 실제로 확인하는 데모는 T1 변경으로 일부러 스모크를 깨는 방식이다. 순서는 다음과 같다.

1. 프로덕션 스모크(`tests/smoke/`, `apps/web/e2e-smoke/`)가 확인하는 동작 하나를 T1 변경으로 깨는 요청 이슈를 연다. 주의할 점이 있다. gate는 프리뷰 스모크가 실패한 PR을 `smoke_contract` 사유로 병합하지 않고 사람에게 넘긴다. 그래서 프리뷰에서 스모크가 통과하고 프로덕션에서만 실패하는 변경을 골라야 한다. 이런 변경을 고를 수 있는지는 이 문서를 쓰는 시점에 실제로 확인하지 않았으므로, 리허설 전에 먼저 확인한다.
2. `@factory go`로 구현과 병합을 진행하고, 배포 뒤 프로덕션 스모크가 실패해 `source:smoke` 이슈가 열리는 것을 확인한다.
3. 장애 이슈에 포스트모템 코멘트가 달리고, 원인 PR이 방금 병합한 PR로 지목되며, 되돌리기 PR이 열려 자동 병합되는지 확인한다.
4. 되돌리기 배포 뒤 전체 스모크가 통과해 "복구됨"이 남고, 원인 PR의 요청 이슈가 다시 열리며, 사후 분석이 개선 PR을 여는지 확인한다.
5. 데모가 끝나면 다시 열린 요청 이슈를 닫고 개선 PR을 검토한다. 이 절차는 프로덕션 스모크를 실제로 실패시키므로 시작 전에 사람이 일정을 정한다.

## 데모 리허설: 심은 버그

> 상태: 포럼 기준 절차(2026-10-21 작성). 심을 버그가 기존 검사를 통과하고 프로덕션 화면에서 보인다는 것은 로컬에서 확인했지만, 이 절차 전체를 팩토리로 실행해 검증하지는 않았다. RealWorld 기준의 이전 리허설(2026-10-11, 버그 PR #16·이슈 #18·수정 PR #19)은 git 이력에 있다.

사람이 일부러 넣은 버그를 버그 이슈로 접수하고, 팩토리가 재현 테스트를 먼저 쓴 뒤 고쳐 배포하는 과정을 보여 준다. 필수 체크 `evidence`가 재현 테스트가 수정 전 코드에서 실패하고 수정 후 코드에서 통과하는지 확인하는 장면이 핵심이다.

- 버그: `apps/web/src/components/BookToc.tsx`에서 목차를 `data.documents.map(...)` 대신 `data.documents.slice(0, 20).map(...)`으로 그린다. 홈의 "책 목차"가 앞의 20개 문서(머리말과 1-19장)만 보여 주고 20장·패턴 15개·데모 해설 9개가 사라진다.
- 2026-10-21 로컬 확인: 이 버그를 심어도 웹 단위 테스트 134개와 웹 E2E 5개가 통과했다(E2E 고정 데이터의 문서는 4개라 잘리지 않는다). 그래서 팩토리는 새 재현 테스트를 써야 하고, `evidence`가 그 테스트를 수정 전 코드에서 실행해 실패를 확인할 수 있다.
- 프로덕션 조건: 책 문서가 21개 이상이어야 보인다. 2026-10-21 기준 45개다.
- 리허설 순서:
  1. 문서 수를 확인한다: `curl -fsS https://sfd-api.roboco.workers.dev/api/book | jq '.documents | length'`(21 이상).
  2. 버그를 심는 사람 PR을 만든다(T1). AGENTS.md "사람이 연 PR의 자체 승인" 절차로 병합한다. 병합 뒤 배포를 확인한다.
  3. 홈의 책 목차에 "P01"·"데모" 문서와 20장이 없는 것을 보여 준다.
  4. 버그 템플릿으로 이슈를 연다(`type:bug`). 예: 제목 "홈 책 목차에 20장과 패턴·데모 해설이 보이지 않는다", 내용 "홈의 책 목차가 20개 문서까지만 보인다. `GET /api/book`은 45개를 돌려준다. 목차는 동기화된 모든 문서를 보여야 한다." 트리아지 코멘트가 달리면 `@factory go`를 남긴다.
  5. 수정 PR의 `ci` run에서 `evidence` job 로그의 "evidence 통과"와 "base 종료 코드 1, head 종료 코드 0" 줄을 보여 준다. 재현 테스트는 Vitest(`apps/web/src/**/*.test.tsx`)여야 한다.
  6. 이슈 라벨이 `factory:deployed`가 되고 닫히면 홈 목차에 45개 문서가 모두 보이는 것을 보여 준다.
- 되돌리기: 팩토리가 고치지 못하거나 리허설을 중단하면, 2번 PR을 되돌리는 사람 PR을 병합한다.
- evidence 음성 대조: `evidence`는 봇이 연 PR만 판정하므로 사람 PR로는 음성 대조를 만들 수 없다. main에서 갈라진 브랜치에 base에서도 통과하는 테스트만 커밋한 뒤 로컬에서 판정 CLI를 직접 실행해 "재현 테스트가 수정 전 코드에서 실패하지 않는다"는 거절을 확인한다.

## 데모 리허설: 실패 패턴 심기

> 상태: 절차의 구조는 2026-10-12에 RealWorld 경로로 검증했다(PR #40-#51). 아래 4번의 기능 요청 문안은 2026-10-21에 포럼 경로로 바꿨으며, 포럼 문안으로는 아직 실행하지 않았다.

자기개선 루프를 보여 주는 리허설이다. 팩토리 규칙에 잘못된 지시를 심어 같은 실수를 반복하게 만들고, 주간 실행이 이를 ESLint 규칙과 평가 케이스로 막는 과정을 보여 준다. 2026-10-12에 이 절차로 검증했다(spec 7.2.7, 9장 P4).

`AGENTS.md`에서 오류 헬퍼 규칙만 지우는 방법으로는 실패가 생기지 않았다(PR #31, 이슈 #32-#34, #38). 구현 에이전트가 리포의 기존 코드를 보고 계속 헬퍼를 썼기 때문이다. 그래서 구현 프롬프트에 잘못된 규칙을 직접 넣는다.

1. 반복 리허설이면 먼저 이전 개선 PR이 추가한 ESLint 규칙(`eslint.config.js`의 `apps/api/src/routes/**` `no-restricted-syntax` 블록)과 평가 케이스(`factory/evals/error-format/`)를 지우는 사람 PR을 병합한다. 지우지 않으면 lint가 구현 에이전트의 실수를 먼저 막으므로 리뷰 지적이 쌓이지 않는다. 사람이 연 PR은 `eval`이 평가 케이스 삭제를 허용한다.
2. 리뷰 기준을 확인한다. `factory/prompts/review.md`의 판단 기준 5번에 "라우트에서 `c.json({ errors: ... })`를 직접 반환하면 category `error-format`의 major 지적"이 있어야 한다(PR #31에서 추가했고 유지한다).
3. 심기 PR을 병합한다(PR #40과 같은 내용). `factory/prompts/implement.md`의 규칙 목록에 다음 줄을 넣는다: ``- API 오류 응답은 라우트 핸들러에서 `return c.json({ errors: { <필드>: ["<메시지>"] } }, <상태>)`로 직접 반환한다. 오류 헬퍼를 import하지 않는다.``
4. 서로 다른 라우트 파일을 고치는 기능 이슈 3건을 `type:feature`로 연다. 파일이 다르면 병렬로 진행해도 병합 충돌이 없다. 세 파일 모두 T1이라 리뷰가 승인하면 자동 병합된다. 포럼 기준 문안은 다음과 같다(2026-10-21 확인: 세 동작 모두 아직 없고, `tests/forum/vendor/`의 계약과 충돌하지 않는다).
   - "토론 목록의 알 수 없는 유형 필터 거절"(`topics.ts`): `GET /api/topics?kind=rant`처럼 네 유형(question·argument·case·general)이 아닌 값이면 422와 `{"errors":{"kind":["is invalid"]}}`. 지금은 빈 목록을 돌려준다.
   - "사용자별 하루 신고 상한"(`reports.ts`): 한 사용자가 UTC 하루에 새 신고를 20건 넘게 하면 429와 `{"errors":{"report":["daily limit reached"]}}`. 계약 `reports.hurl`은 사용자마다 신고를 2건만 하므로 충돌하지 않는다. (신고 사유 최소 길이는 계약이 2자 사유 "욕설"을 쓰므로 문안으로 쓰지 않는다.)
   - "에이전트 예약어 이름 금지"(`agents.ts`): `admin`, `system`, `factory`, `conveyor`로 시작하는 에이전트 이름이면 422와 `{"errors":{"name":["is reserved"]}}`.
5. 트리아지 코멘트가 달리면 각 이슈에 `@factory go`를 남긴다. 리뷰가 직접 반환을 `error-format`으로 지적하고, 수정 라운드가 헬퍼로 고친다. 런 기록에서 지적을 확인한다: `gh api "repos/roboco-io/the-software-factory-demo/contents/runs/$(date -u +%Y-%m).jsonl?ref=factory-data" -H "Accept: application/vnd.github.raw" | jq -c 'select(.role=="review") | {issue, c: [.findings[]?.category]}'`
6. 지적이 서로 다른 이슈 3건에 쌓이면 `gh workflow run factory-weekly.yml`을 실행한다.
7. 보여 줄 화면은 다음과 같다.
   - 주간 리포트 이슈의 "개선 후보" 표에 `review:error-format`이 있다.
   - `factory:improve`·`risk:T3` 라벨이 붙은 개선 PR이 열린다. 2026-10-12에는 PR #47이 열렸다.
   - 개선 PR의 `ci` run에서 `eval` job 로그에 "error-format: base=못 잡음, head=잡음"이 있다.
   - CODEOWNER가 승인하고 병합하면, 리포트 이슈에 "개선 PR #N이 병합되었다" 코멘트가 달린다.
   - 같은 실수를 넣은 draft PR에서 `lint`가 `no-restricted-syntax`로 실패한다(PR #48).
   - weekly를 다시 실행하면 리포트의 "규칙 효과" 표에 개선 PR이 나타나고, 후보는 다시 열리지 않는다(PR #51).
   - 보드의 `Factory` 필드가 `deployed`이고, 대시보드의 자가 개선 사례에 개선 PR·검증 결과 링크와 병합 전후 관찰 기록이 있다.
8. 되돌리기: 3번에서 넣은 줄을 지우고 `AGENTS.md`의 오류 헬퍼 규칙("API 오류 형식은 `{"errors": {"field": ["message"]}}`이며 `apps/api/src/lib/errors.ts`의 헬퍼만 사용한다.")이 있는지 확인한다(PR #49). 오염된 프롬프트로 만든 PR 가운데 아직 병합되지 않은 것(이전 RealWorld 리허설에서는 T2인 #41의 PR #45)은 닫고 `@factory go`로 다시 구현한다.

## 배포 롤백

프로덕션 배포·스모크가 실패하면 해당 이슈가 `factory:needs-human` + `source:deploy`가 된다.

1. 이전 Worker 버전을 확인한다: `cd apps/api && pnpm exec wrangler deployments list --name sfd-api`
2. 이전 버전으로 되돌린다: `pnpm exec wrangler rollback <version-id> --name sfd-api -m "<사유>"`
3. D1 마이그레이션은 자동으로 되돌리지 않는다. 되돌려야 하면 역방향 마이그레이션을 사람이 새로 작성해 PR로 병합한다.
4. 웹은 문제 커밋을 revert하는 PR을 병합하면 `deploy` 워크플로가 다시 배포한다.

## 팩토리 GitHub App 권한

App `roboco-software-factory-bot`에는 다음 리포 권한만 준다.

| 권한          | 수준           | 쓰는 곳                                                       |
| ------------- | -------------- | ------------------------------------------------------------- |
| Contents      | Read and write | `factory/issue-<N>` 브랜치 push, `factory-data` 런 기록, 병합 |
| Issues        | Read and write | 상태 라벨, 코멘트, `factory:alert` 이슈                       |
| Pull requests | Read and write | PR 생성, 리뷰 판정, 라벨                                      |
| Actions       | Read and write | 다음 단계 workflow dispatch, `@factory stop`의 run 취소       |
| Variables     | Read and write | 실패율 차단기가 `FACTORY_PAUSED`를 `true`로 바꿈              |
| Checks        | Read           | 병합 판단에서 필수 체크 결과 확인                             |
| Metadata      | Read           | 필수(기본)                                                    |
| Projects(org) | Read and write | Projects 보드 생성(`bootstrap`)과 `Factory` 필드 동기화(P4)   |

Workflows 권한은 주지 않는다. 이 권한이 없으면 App 토큰으로는 `.github/workflows/**`를 바꾸는 커밋을 push할 수 없다. 그래서 구현 역할의 T3 경로 금지(`risk-tier`, publish 검증)가 뚫리더라도 봇이 자기 워크플로를 고쳐 토큰·시크릿 처리 방식을 바꿀 수 없다. 워크플로 변경은 사람이 직접 커밋하고 병합한다.

## 팩토리 보안 한계

다음 위험은 데모 범위에서 수용했다.

- agent job은 배정된 엔진의 키만 환경변수로 받는다. 그러나 job 정의가 참조하는 세 엔진 시크릿(`ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `DEEPSEEK_API_KEY`)은 마스킹 목록으로 모두 runner에 전달될 수 있다. runner에서 sudo 권한을 가진 에이전트 프로세스가 runner 프로세스 메모리를 읽으면 다른 엔진의 키를 얻을 수 있다.
- agent job의 runner 프로세스에는 Actions 런타임 토큰(`ACTIONS_RUNTIME_TOKEN`)이 있다. 에이전트 프로세스의 env에는 이 토큰이 없지만, runner를 장악한 에이전트는 이 토큰으로 Actions 캐시(예: pnpm 저장소 캐시)에 오염된 항목을 쓸 수 있다. 이후 신뢰하는 job이 그 캐시를 복원하면 오염된 의존성이 실행될 수 있다. 계획 파일은 prepare job의 artifact ID로만 받으므로 artifact 교체로 계획을 바꿀 수는 없다.
- `evidence` job은 PR 코드(테스트, 의존성 설치 스크립트)를 실행한다. 이 job에는 시크릿과 GitHub 토큰이 없지만, 판정 프로세스와 같은 VM에서 돌기 때문에 악의적인 PR 코드는 판정 결과를 조작할 수 있다. PR 코드를 실행하는 다른 필수 체크(`unit`, `e2e` 등)와 같은 수준이다. `evidence`는 재현 테스트가 있다는 증거를 요구하는 장치이고, 악의적인 작성자를 막는 장치가 아니다. T2·T3 변경은 계속 사람 승인이 막는다.
- 피드백에는 IP별 한도(10분에 3건) 외에 전체 한도(하루 50건)도 있다. 두 한도는 삽입 문장 안에서 함께 검사되므로 동시 요청도 한도를 넘지 못한다. 그러나 IP를 바꿔 가며 보내는 스팸은 IP별 한도를 피할 수 있다. 이 위험은 수용했다. 전체 한도 때문에 피드백 이슈는 하루 최대 50개이고, 이슈마다 triage 실행이 한 번 일어나므로 하루 triage 실행은 약 50회로 제한된다.
- `evidence` job이 읽는 증거 JSON 보고서는 PR의 테스트 코드가 쓸 수 있으므로 위조할 수 있다. 이 job에는 시크릿이 없고, 위조해도 얻는 것은 `evidence` 체크 통과뿐이다. 이 체크는 악의적인 작성자를 막는 장치가 아니므로 이 위험을 수용했다(판정 T3-c).
- `INTAKE_TOKEN`은 GitHub `production` environment secret에 두고, 이 environment는 `main` 브랜치만 쓸 수 있도록 배포 브랜치 정책을 건다. main이 아닌 브랜치의 워크플로는 이 토큰을 읽지 못한다.
- `POST /api/_factory/intake/probe`는 `INTAKE_TOKEN`을 가진 사람만 쓸 수 있는 오류 주입 경로다. 효과는 `error_events` 한 행과 그에 따른 유입 이슈뿐이다.
- `factory-intake`는 environment `production`을 참조하므로, GitHub가 30분마다 이 environment의 배포 기록을 하나씩 만든다.
- CODEOWNERS 승인은 PR 작성자가 유일한 코드 소유자(`@serithemage`)이면 강제되지 않는다. 그래서 T2·T3의 사람 승인 게이트는 봇 PR에만 실질적으로 적용된다. 사람 기여자가 늘면 코드 소유자를 두 명 이상으로 둔다.
- GitHub `schedule` 트리거는 지연되거나 건너뛰어질 수 있다. 에러·피드백이 30분 안에 이슈가 되는 것은 예약 실행이 제때 돌 때만 보장된다. 급하면 `gh workflow run factory-intake.yml`로 수동 실행한다.
- `eval` job은 head 트리의 `eslint.config.js`를 실행하므로, 악의적인 PR은 판정 결과를 위조할 수 있다. job에는 시크릿과 GitHub 토큰이 없고, 개선 PR은 T3라 사람 승인이 막는다.
- 평가 케이스가 없는 기존 ESLint 규칙을 지우는 변경은 `eval`이 잡지 못한다. 개선 PR 본문의 "ESLint 설정에서 삭제된 줄" 절과 사람 검토에 의존한다.
- `factory-eval-live`의 agent job은 구현 엔진과 리뷰 엔진의 키를 함께 환경변수로 받는다. 이 워크플로는 수동으로만 실행한다.
- 보드는 제목 "Software Factory"로 찾는다. org에 같은 제목의 보드가 생기면 동기화가 멈추고 경고만 남는다.
- 런 기록에 리뷰 지적 원문(최대 300자)이 저장된다. 같은 문장이 퍼블릭 PR 리뷰에 이미 있다.

## 보안

- CI의 Cloudflare 토큰(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)은 워크플로 전체가 아니라 wrangler 또는 Cloudflare API를 호출하는 단계에만 `env`로 전달한다. 의존성 설치, 웹 빌드, Playwright 단계는 이 토큰을 받지 않는다.
- Cloudflare 토큰은 `production`·`preview` environment 시크릿으로만 둔다. 팩토리 워크플로(`factory-*.yml`)는 Cloudflare 토큰을 받지 않는다. 봇 PR이 T2·T3 경로를 바꾸면 `preview.yml`의 `policy` job이 프리뷰 배포를 생략한다.
- 팩토리의 에이전트는 GitHub 토큰이 없는 별도 job(VM)에서 실행되고, prepare job이 배정한 엔진의 API 키 하나만 받는다. push·PR·라벨은 에이전트가 실행된 적 없는 publish job이 새로 발급한 App 토큰으로 한다. publish job은 main을 체크아웃한 별도 디렉토리의 팩토리 CLI를 실행하고, 에이전트가 만든 작업 트리의 코드는 실행하지 않는다.

## 프리뷰 보안 한계

- 프리뷰 웹은 프로덕션 웹과 같은 오리진(`https://roboco.io`)에서 서빙된다. 같은 오리진의 JavaScript는 `localStorage`를 읽을 수 있으므로, PR 코드가 다른 경로의 로그인 토큰을 읽을 수 있다.
- 완화책으로 토큰 키를 API 주소별(`jwt:<API_BASE>`)로 나누고, 프리뷰 Worker마다 PR 번호에서 파생한 별도 `JWT_SECRET`을 쓴다. 프로덕션 토큰은 프리뷰 API에서 검증되지 않는다. 그러나 프리뷰 JS가 프로덕션 토큰을 읽는 것 자체는 막지 못한다.
- 데모 범위에서 수용한 위험이다. 같은 리포 브랜치 PR만 프리뷰를 만들기 때문이다.
