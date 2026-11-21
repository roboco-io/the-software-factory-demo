# apps/control

## Overview

제어 평면 Cloudflare Worker(`@factory/control`, 배포 이름 `software-factory-control`)다. `/api/*` 요청은 Worker가 직접 처리하고, 그 밖의 경로는 `../portal/dist`의 포털 정적 파일(바인딩 `ASSETS`)로 응답한다(`wrangler.jsonc`의 `assets.run_worker_first`). `assets.not_found_handling`이 `"single-page-application"`이므로 파일이 없는 경로는 `index.html`을 받고, 포털의 클라이언트 라우터가 화면을 고른다. 실행 기록은 D1(`DB`)에 저장하고, 이슈마다 하나인 Durable Object `IssueRun`이 상태 전환을 직렬화하며, 컨테이너 Durable Object `AgentSandbox`가 구현과 리뷰 에이전트를 실행한다.

설정은 `wrangler.jsonc`의 `vars`(`RUNS_ENABLED`, `OPERATOR_IDS`, `PROJECTS`, `IMPLEMENT_MODEL`, `REVIEW_MODEL`, `GITHUB_APP_ID`, `GITHUB_OAUTH_CLIENT_ID`)와 `wrangler secret put`으로 넣는 비밀 값(`GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`)으로 한다. `RUNS_ENABLED`는 전역 중지 스위치이며 정확히 `"true"`일 때만 실행이 시작된다. `OPERATOR_IDS`나 `PROJECTS`가 비어 있어도 실행은 시작되지 않는다. `wrangler.jsonc`는 `secrets.required`를 일부러 두지 않으므로 비밀 값 없이도 배포된다. `ControlEnv`에서 모든 비밀 값은 선택 항목이며, `SESSION_SECRET`은 32자 이상이어야 한다(`src/env.ts`). 운영 절차는 [docs/operations.md](../../docs/operations.md)에 있다.

Durable Object 바인딩은 `ISSUE_RUN`(`IssueRun`)과 `SANDBOX`(`AgentSandbox`)이며 둘 다 SQLite 저장소를 쓴다. 컨테이너 이미지 키는 `agent`다.

`container/Dockerfile`은 에이전트 이미지를 정의한다. Claude Code(2.1.318), pnpm(12.18.0), pi(1.5.0)는 버전을 고정하고, `sandbox-shim`은 `cloudflare/sandbox:1.0.3`에서 복사한다. 기반 이미지 `node:24-trixie-slim`은 다이제스트가 아닌 태그로 지정하고 apt 패키지 버전은 고정하지 않으므로, 이미지 전체가 재현 가능하지는 않다. 이미지에는 도구만 있고 GitHub 토큰이나 LLM 키는 없다.

`worker-configuration.d.ts`는 `wrangler types`가 생성하는 파일이며 git에서 제외된다. `tsconfig.json`이 이 파일을 포함하고 `src/env.ts`가 생성된 `Env` 타입을 쓰므로, `tsc`를 직접 실행하기 전에 `wrangler types`를 먼저 실행해야 한다(`typecheck` 스크립트는 이를 함께 한다).

배포용 패키지 스크립트는 없다. `.github/workflows/deploy.yml`이 `pnpm check`, 원격 D1 마이그레이션 적용, `wrangler deploy`, 상태 확인 순서로 배포한다. 마이그레이션을 Worker보다 먼저 적용하므로 새 Worker가 이전 `CHECK` 제약을 만나지 않는다.

## Subdirectories & Boundaries

- src: [./src/README.md](./src/README.md) - Worker 진입점, API 라우트와 인증, 실행 상태 기계(`IssueRun`/`RunMachine`), 병합 판정, GitHub 연동, 샌드박스와 출구 핸들러(`Outbound`).
- migrations: [./migrations/README.md](./migrations/README.md) - D1 스키마(`runs`, `events`, `deliveries`, `run_usage`)와 상태·사유 코드 `CHECK` 제약.

## Verification

- Run: `pnpm --filter @factory/control test`
- 타입 검사: `pnpm --filter @factory/control typecheck`
- 로컬 실행: `pnpm --filter @factory/portal build` 후 `pnpm --filter @factory/control dev`
