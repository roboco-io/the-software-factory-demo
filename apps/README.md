# apps

## Overview

이 디렉터리에는 pnpm 워크스페이스에 포함된 제품 앱 두 개가 있다. `control`은 Cloudflare Worker로 동작하는 제어 평면이며, API를 제공하고 `portal`의 빌드 결과물(`../portal/dist`)을 같은 출처의 정적 파일로 함께 제공한다. `portal`은 Vite로 빌드하는 프레임워크 없는 TypeScript 웹앱이며, `fetch`로는 같은 출처의 `/api/*`만 쿠키 인증으로 호출한다. 다만 승인 흐름에서는 브라우저를 `https://github.com/login/oauth/authorize`로 이동시키고, 화면에는 github.com 링크를 만든다.

두 앱은 세 지점에서 연결된다. 첫째, 런타임 경계는 HTTP API다. 권한 검사는 `control`이 수행하고, 포털의 버튼 표시 조건은 화면상의 제한일 뿐이다. 둘째, 빌드 산출물 경계가 있다. `control`은 `../portal/dist`를 정적 자산으로 제공하며, 그 응답 헤더(CSP 포함)는 포털의 `public/_headers`가 정한다. 따라서 포털을 먼저 빌드해야 `control`을 로컬에서 실행하거나 배포할 수 있다. 셋째, 시험 코드 경계가 있다. 포털 시험(`portal/src/labels.test.ts`)은 `control/src/run-types.ts`의 `STATES`와 `REASON_CODES`를 직접 import해 한국어 문구가 모든 상태와 사유 코드를 덮는지 확인한다. 제품 코드끼리는 서로 import하지 않는다.

## Subdirectories & Boundaries

- control: [./control/README.md](./control/README.md) - 제어 평면 Worker. GitHub 웹훅으로 실행을 시작하고, 이슈마다 하나인 Durable Object(`IssueRun`)가 상태 전환을 직렬화하며, 컨테이너 샌드박스에서 에이전트를 실행하고, 병합 여부를 프로그램(`decideMerge`)이 판정한다. D1 스키마는 [./control/migrations/README.md](./control/migrations/README.md)에 있다.
- portal: [./portal/README.md](./portal/README.md) - 포털 웹앱. 프로젝트, 실행 목록, 실행 상세(7단계 보드, 비용, 이벤트 재생)를 보여 주고, 운영자에게 실행 중지와 승인 동작을 제공한다.
