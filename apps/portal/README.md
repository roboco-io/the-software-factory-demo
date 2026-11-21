# @factory/portal

## Overview

포털은 소프트웨어 팩토리가 관리하는 프로젝트와 실행(run) 상태를 보여 주는 웹앱이다. Vite로 정적 파일을 빌드하고, 빌드 결과(`dist/`)는 제어 평면 Worker(`apps/control`)가 정적 자산으로 함께 제공한다. 따라서 포털과 API는 같은 출처에서 서비스되며, 포털은 쿠키 인증으로 `/api/*`를 호출한다.

이 디렉터리에는 빌드 설정과 HTML 진입점, 정적 응답 헤더가 있고, 앱 코드는 `src/`에 있다.

## Interface

- [src](./src/README.md) - 앱 코드. 라우팅, 화면, API 클라이언트, 표시용 계산 모듈.
- `index.html` - `<div id="app">`과 `/src/main.ts` 모듈 스크립트를 담은 진입점. JavaScript가 꺼져 있으면 `<noscript>` 안내를 보여 준다.
- `vite.config.ts` - `build.assetsInlineLimit: 0`. CSP가 `data:` URL을 허용하지 않으므로 자산을 스크립트나 스타일에 인라인하지 않는다.
- `public/_headers` - Workers 정적 자산 계층이 포털의 모든 파일에 붙이는 응답 헤더. API 응답 헤더는 Worker가 따로 설정한다.
- `package.json` 스크립트: `dev`(vite), `build`(vite build), `typecheck`(tsc --noEmit), `test`(vitest run).

## Invariants

- `public/_headers`의 CSP는 `default-src`, `script-src`, `style-src`, `img-src`, `font-src`, `connect-src`, `form-action`을 모두 `'self'`로, `object-src`, `base-uri`, `frame-ancestors`를 `'none'`으로 지정한다. `src/safety.test.ts`가 이 값들과 `index.html`에 인라인 스크립트·스타일·`on*=` 속성이 없음을 시험으로 강제한다. 인라인 스크립트, 인라인 스타일, `data:` 자산은 차단되므로, 앱 코드는 인라인 이벤트 핸들러와 `style` 속성을 쓰지 않는다(`src/dom.ts:h`가 이를 거부한다).
- 같은 파일이 `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`도 지정한다.
- `vite.config.ts`의 `assetsInlineLimit: 0`은 위 CSP를 지키기 위한 설정이므로 바꾸면 안 된다.
- `tsconfig.json`은 저장소 루트의 `tsconfig.base.json`을 상속하고 `src`만 검사한다. `types: ["vite/client"]`는 `safety.test.ts`의 `?raw` import와 `import.meta.glob`에 필요하다.

## Side Effects

- `pnpm --filter @factory/portal build`는 `dist/`에 빌드 결과를 쓴다.
- 런타임 부수 효과(네트워크, DOM, 히스토리, 타이머)는 [src](./src/README.md)에 정리되어 있다.

## Verification

- Run: `pnpm --filter @factory/portal test`
- 저장소 전체 검사: `pnpm check` (포맷, 린트, 타입 검사, 테스트, 빌드)
