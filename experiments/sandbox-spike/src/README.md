# sandbox-spike/src

## Overview

이 디렉터리는 단계 0 샌드박스 실험용 Cloudflare Worker `sfd-sandbox-spike`의 소스다. Worker는 bearer 토큰으로 보호된 HTTP 엔드포인트를 제공하고, 요청을 Durable Object `AgentSandbox`에 전달한다. `AgentSandbox`는 인터넷이 꺼진 컨테이너를 시작하고, 그 안에서 저장소 복제, 셸 명령, 에이전트(Claude Code 또는 pi) 작업을 실행한다. 컨테이너의 모든 HTTP와 HTTPS 요청은 `Outbound` 엔트리포인트를 거친다. `Outbound`는 호스트, 메서드, 경로 허용 목록을 적용하고 실제 LLM 키를 주입한다. 이 구조의 목적은 컨테이너에 실제 비밀 값이 들어가지 않는다는 것을 실험으로 확인하는 것이다. 실험 결과는 [../RESULTS.md](../RESULTS.md)에 있다.

이 코드는 일회성 실험이다. 제품 코드는 이 코드에 의존하지 않는다.

## Interface

### `index.ts` (Worker 진입점)

- `export default { fetch(request, env) }`: 모든 요청에 대해 `authorized()`로 `Authorization: Bearer <SPIKE_TOKEN>`을 확인한다. 실패하면 401을 반환한다.
- 경로는 `/s/<name>/<action>` 형식이다. `<name>`은 `nameRe`(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)를 만족해야 하며, 그렇지 않으면 404를 반환한다. `<name>`은 `env.SANDBOX.getByName(name)`으로 Durable Object 인스턴스를 고른다.
- 라우트 (`${method} ${action}` 기준):

| 라우트 | 호출 메서드 | 쿼리와 본문 |
|---|---|---|
| `POST start` | `AgentSandbox.start` | `instance` (기본 `basic`) |
| `POST clone` | `AgentSandbox.cloneRepository` | 본문: 저장소 URL, `dir` (기본 `/workspace/repo`) |
| `POST exec` | `AgentSandbox.exec` | 본문: 셸 스크립트, `t` (초, 기본 60) |
| `POST task` | `AgentSandbox.startTask` | `kind` (기본 `sh`), `model`, 본문: 입력. 응답 202, 이미 실행 중이면 409 |
| `GET task` | `AgentSandbox.readTask` | 없음 |
| `GET log` | `AgentSandbox.readLog` | `file` (기본 `stdout.log`), `tail` (바이트, 기본 20000) |
| `GET diff` | `AgentSandbox.readDiff` | 없음 |
| `GET leak` | `AgentSandbox.leakCheck` | 없음 |
| `POST destroy` | `AgentSandbox.destroy` | 없음 |

- `<action>`이 소문자 영문(`[a-z]+`)이 아니면 404, 일치하는 라우트가 없으면 405, 예외가 나면 500과 `{ error }`를 반환한다.
- 재수출: `Outbound`, `AgentSandbox`.

### `sandbox.ts` (`AgentSandbox extends DurableObject`)

- `start(instance)`: 컨테이너를 준비하고 `{ running, instance }`를 반환한다.
- `cloneRepository(repository, directory)`, `exec(script, timeoutSec)`: 컨테이너를 준비한 뒤 명령을 실행하고 `{ exitCode, stdout, stderr }`를 반환한다.
- `startTask(kind, input, model)`: `"started"` 또는 `"busy"`를 반환한다. 실행할 명령은 `agentCommand`가 정한다. `kind`가 `claude`이면 `claude --print --output-format stream-json --verbose --dangerously-skip-permissions --no-session-persistence --max-turns 6 --max-budget-usd 0.2 --model <model> -- <input>`을 실행하고, 환경변수로 Anthropic 자리표시자 키, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `IS_SANDBOX=1`을 넣는다. `pi`이면 `pi --mode json --no-session --provider openai --model <model> -- <input>`을 실행하고, OpenAI 자리표시자 키, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`을 넣는다. 그 외에는 `/bin/sh -c <input>`을 실행한다. 작업 디렉터리는 `sh`일 때 `/workspace`, 그 외에는 `/workspace/repo`다.
- `readTask()`: `{ state: "none" | "running" | "finished" | "lost", exitCode? }`를 반환한다.
- `readLog(file, tail)`: 작업 디렉터리의 로그 파일 끝부분을 반환한다. `file` 값은 검사 없이 `${taskDirectory}/$0` 경로에 들어가므로 `../`로 작업 디렉터리 밖의 파일을 읽을 수 있다. 이 엔드포인트는 `SPIKE_TOKEN` 소지자만 호출할 수 있다.
- `readDiff()`: `/workspace/repo`에서 `git add --intent-to-add .`를 실행한 뒤 `git diff HEAD`를 반환한다. 새 파일도 diff에 나오게 하려는 것이며, 이 때문에 저장소 인덱스가 바뀐다.
- `leakCheck()`: 컨테이너 안에서 Worker 비밀 값의 흔적을 찾는다. 각 비밀 값의 전체, 앞 16자, 뒤 16자 가운데 8자 이상인 것을 검색어로 쓴다. 비밀 값 자체는 반환하지 않고 불리언 4개(`anthropicKeyFound`, `openaiKeyFound`, `spikeTokenFound`, `envHasAnthropicNameOnly`)와 검사한 바이트 수(`scannedBytes`)를 반환한다.
- `destroy()`: 컨테이너를 종료하고 작업 상태를 지운다.
- `alarm()`: 컨테이너가 꺼져 있으면 아무것도 하지 않는다. 컨테이너가 켜져 있고 작업이 실행 중이면 60초 뒤 알람을 다시 예약하고, 끝났으면 저장소의 `task` 키를 지운다.

### `outbound.ts` (`Outbound extends WorkerEntrypoint`)

- `fetch(request)`: 컨테이너의 모든 80, 443 요청을 받는다. 허용 목록은 다음과 같고, 그 외는 403 `DENIED: ...`이다.

| 호스트 | 허용 요청 | 처리 |
|---|---|---|
| `api.anthropic.com` | `POST /v1/messages`, `POST /v1/messages/count_tokens` | `authorization` 제거, `x-api-key`에 `ANTHROPIC_API_KEY` 주입 |
| `api.openai.com` | `POST /v1/responses`, `POST /v1/chat/completions` | `authorization`에 `Bearer OPENAI_API_KEY` 주입 |
| `github.com` | `GET .../info/refs?service=git-upload-pack`, `POST .../git-upload-pack` | 그대로 전달 (읽기 전용 git) |
| `registry.npmjs.org` | `GET`, `HEAD` | 그대로 전달 |

## Invariants

- HTTPS가 아닌 요청은 호스트와 무관하게 거부한다 (`outbound.ts`: `url.protocol !== "https:"`).
- 호스트는 정확히 일치해야 한다. 하위 도메인이나 패턴 일치는 허용하지 않는다.
- 컨테이너에는 실제 LLM 키가 들어가지 않는다. claude 작업은 `ANTHROPIC_API_KEY`만, pi 작업은 `OPENAI_API_KEY`만 받으며, 값은 `"placeholder-injected-by-worker"`다. 실제 키는 `Outbound`가 요청 헤더에 넣는다 (`agentCommand`).
- GitHub 허용 규칙은 저장소를 가리지 않는다. 어떤 저장소 경로든 `git-upload-pack`이면 통과한다. 제품(`apps/control`)은 바인딩된 저장소 하나만 허용하므로 이 점이 다르다.
- 컨테이너는 `enableInternet: false`로 시작하고, `interceptAllOutboundHttp`와 `interceptOutboundHttps("*")`가 성공해야 사용한다. 가로채기 설정이 실패하면 컨테이너를 파괴하고 오류를 던진다 (`setUpSandbox`).
- 한 샌드박스에서 동시에 실행되는 작업은 하나다. `startTask`는 `blockConcurrencyWhile` 안에서 실행 중인 작업을 확인하고, 있으면 `"busy"`를 반환한다.
- 작업 상태 판정(`taskStatus`)은 먼저 `exit-code` 파일을 본다. 파일이 있으면 `finished`다. pid 파일이 있으면 기록된 pid와 `boot_id`를 함께 확인하며(`taskRunningScript`), 컨테이너가 재시작되어 `boot_id`가 다르면 실행 중으로 보지 않는다. 프로세스가 없으면 `exit-code`를 한 번 더 읽고, 그래도 없으면 `lost`다. pid 파일이 아직 없고 `task` 키가 있으면 `boot_id` 확인 없이 `running`으로 본다.
- 컨테이너가 꺼져 있는데 저장소에 `task` 키가 남아 있으면 상태는 `lost`다 (`readTask`). 다만 `setUpSandbox`는 꺼진 컨테이너를 시작할 때 `task` 키를 지운다. 그래서 `start`, `clone`, `exec`, `log`, `diff`, `leak` 중 하나가 먼저 컨테이너를 다시 시작하면 `readTask`는 `lost` 대신 `none`을 보고한다.
- 컨테이너 CA는 시스템 신뢰 저장소에 없다. 복제, `exec`, 작업 실행에는 `trustEnv`(`NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `SSL_CERT_FILE`)를 넣어야 한다.
- `leakCheck`는 비밀 값 자체를 응답에 넣지 않는다.

## Side Effects

- Cloudflare Containers: 컨테이너를 시작하고 파괴한다. 비활성 제한 시간은 30분이다 (`inactivityTimeout`).
- Durable Object 저장소: `ctx.storage.kv`의 `task` 키를 쓰고 지운다. `ctx.storage.setAlarm`으로 60초 간격 알람을 예약한다.
- 컨테이너 파일 시스템: `/workspace/repo`(복제 대상)를 만들지만 코드가 지우지는 않는다. `/workspace/task`(pid, `exit-code`, `exit-code.tmp`, `stdout.log`, `stderr.log`)는 만들고 지운다. `readDiff`는 `/workspace/repo`의 git 인덱스를 바꾼다.
- 외부 네트워크: `Outbound`가 허용된 요청을 `api.anthropic.com`, `api.openai.com`, `github.com`, `registry.npmjs.org`로 전달한다. LLM 호출은 비용이 발생한다.
- 로그: `Outbound`는 모든 외부 요청의 메서드, 호스트, 경로를 `console.log`로 남긴다. Worker 진입점(`index.ts`)은 요청 처리 중 예외를 `console.error("request failed", ...)`로 남긴다.

## Verification

- 자동화된 테스트가 없다. `package.json`에 `test` 스크립트가 없다.
- 실험 절차와 판정 결과는 [../RESULTS.md](../RESULTS.md)를 본다.
