# sandbox-spike

## Overview

이 디렉터리는 단계 0 샌드박스 실험이다. 실험의 목적은 Cloudflare Containers에서 코딩 에이전트(Claude Code, pi)를 실행할 때, 컨테이너에 실제 비밀 값을 넣지 않고 외부 통신을 허용 목록으로 제한할 수 있는지 확인하는 것이다. 실험은 2026-11-06에 실행했고, 판정과 근거는 [RESULTS.md](./RESULTS.md)에 있다. 이 디렉터리는 일회성 실험이며 pnpm 워크스페이스에 포함되지 않는다. 제품 코드는 이 디렉터리에 의존하지 않는다.

RESULTS.md의 정리 기록에 따르면 Worker `sfd-sandbox-spike`, 컨테이너 애플리케이션, 원격 이미지는 실험 후 삭제됐다. 다시 실행하려면 새로 배포해야 한다.

이 디렉터리 자체에는 소스 파일이 없고, 다음 설정 파일이 있다.

| 파일 | 내용 |
|---|---|
| `package.json` | 패키지 `sfd-sandbox-spike`. 의존성 `@cloudflare/sandbox` 1.0.3, 개발 의존성 `wrangler` 4.158.0. 스크립트 없음 |
| `package-lock.json` | npm 잠금 파일. 이 실험은 pnpm 워크스페이스가 아니라 npm으로 의존성을 설치한다 |
| `RESULTS.md` | 2026-11-06 실행 결과, 판정, 정리 기록 |
| `wrangler.jsonc` | Worker 진입점 `src/index.ts`, Durable Object 바인딩 `SANDBOX`(`AgentSandbox`, SQLite 저장소), 컨테이너 이미지 `agent`(`./Dockerfile`), 필수 비밀 `SPIKE_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| `Dockerfile` | `node:24-trixie-slim` 기반. git, ripgrep, curl, dnsutils 등과 `@anthropic-ai/claude-code` 2.1.318, `pnpm` 12.18.0, `@earendil-works/pi-coding-agent` 1.5.0, `sandbox-shim`을 설치한다. `sleep infinity`로 계속 실행된다 |
| `.gitignore` | `node_modules/`, `.wrangler/`, `.secrets.json` 제외 |

## Subdirectories & Boundaries

- src: [./src/README.md](./src/README.md) - Worker 진입점(`index.ts`), 컨테이너를 관리하는 Durable Object `AgentSandbox`(`sandbox.ts`), 외부 통신 허용 목록과 키 주입을 맡는 `Outbound`(`outbound.ts`).

## Global Invariants

- 비밀 값은 Worker 비밀로만 존재한다. 컨테이너에는 자리표시자 키만 들어가고, 실제 키는 `Outbound`가 요청 헤더에 넣는다.
- 컨테이너의 외부 통신은 `Outbound`의 호스트, 메서드, 경로 허용 목록을 통과한 HTTPS 요청만 가능하다. GitHub에는 읽기(`git-upload-pack`)만 허용하지만 저장소는 가리지 않는다. 제품(`apps/control`)은 바인딩된 저장소 하나만 허용한다.
- 모든 Worker 엔드포인트는 `SPIKE_TOKEN` bearer 토큰을 요구한다.

## Global Side Effects

- 배포 시 Cloudflare 계정에 Worker, Durable Object, 컨테이너 애플리케이션과 이미지가 생긴다. RESULTS.md에 따르면 Workers Paid 플랜이 필요하다.
- 에이전트 작업은 Anthropic과 OpenAI API를 호출하므로 비용이 발생한다.

## Verification

- 자동화된 테스트가 없다. `package.json`에 `test` 스크립트가 없고, 루트의 `pnpm check` 대상도 아니다.
