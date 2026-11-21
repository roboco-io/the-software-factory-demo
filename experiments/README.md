# experiments

## Overview

이 디렉터리에는 일회성 실험이 있다. 실험 코드는 pnpm 워크스페이스, ESLint(`eslint.config.js`), Prettier(`.prettierignore`) 대상에 포함하지 않으며, 제품 코드(`apps/`)는 이 디렉터리의 어떤 코드에도 의존하지 않는다. 실험의 결론은 제품 설계에 반영되었고, 실험용으로 배포했던 자원은 실험 뒤에 삭제했다(각 실험의 결과 문서 기준).

## Subdirectories & Boundaries

- sandbox-spike: [./sandbox-spike/README.md](./sandbox-spike/README.md) - 0단계 실험. 실제 비밀 값을 컨테이너에 넣지 않고, 허용 목록 기반 출구 핸들러(`Outbound`)가 LLM 키를 주입하는 구조로 Cloudflare Containers에서 코딩 에이전트(Claude Code, pi)를 실행할 수 있는지 확인했다. 결과는 [./sandbox-spike/RESULTS.md](./sandbox-spike/RESULTS.md)에 있다.
