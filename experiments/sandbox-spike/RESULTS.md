# 단계 0 샌드박스 실험 결과

실행: 2026-11-06 14:17-14:36 (KST). 버전: wrangler 4.158.0, @cloudflare/sandbox 1.0.3, claude-code 2.1.318, pi 1.5.0, pnpm 12.18.0, 컨테이너 Node v24.22.2. 계정이 Workers Paid로 올라간 뒤 재실행했다. 첫 시도(플랜 없음)에서는 `containers/me`가 HTTP 401을 반환해 배포하지 못했다.

## 구조

Worker `sfd-sandbox-spike`가 Durable Object `AgentSandbox`로 컨테이너를 실행한다. 컨테이너는 `enableInternet:false`로 시작하고, `interceptAllOutboundHttp`와 `interceptOutboundHttps("*")`로 모든 80, 443 트래픽을 Worker의 `Outbound` 엔트리포인트로 보낸다. 엔트리포인트가 호스트, 메서드, 경로 허용 목록을 적용하고 Anthropic과 OpenAI 키를 주입한다. AI Gateway는 쓰지 않았다. 엔드포인트는 무작위 bearer 토큰으로 보호했다. 소스는 `src/`, `Dockerfile`, `wrangler.jsonc`에 있다.

## 결과 요약

| 실험 | 판정 | 근거 |
|---|---|---|
| A. Claude Code | 통과 | 컨테이너 환경변수에는 자리표시자 키만 있었다. 3턴 만에 NOTES.md를 추가했고, diff가 반환됐으며, stream-json의 result 이벤트에 사용량과 비용이 있었다. |
| B. pi | 통과 | `--provider openai --model gpt-5.4-nano --mode json`이 동작했다. |
| C. 격리 | 통과 (DNS 일부 불확실) | 아래 상세 참조 |
| D. 도구 호환 | 통과 | npm, pnpm, git 모두 동작했다. |
| E. 자원 | 부분 통과 | 10분 작업과 동시 컨테이너는 통과. lite 크기는 에이전트 실행에 부적합했다. |
| F. 지출 | 사용량 기록됨, 크레딧 차감은 미확인 | 아래 참조 |

## A. Claude Code

- 모델 `claude-haiku-5-5`, 인스턴스 `basic`(1 GiB). 저장소는 octocat/Hello-World.
- 결과 이벤트: `num_turns` 3, `total_cost_usd` 0.001487, 출력 토큰 410, 캐시 생성 6565, 캐시 읽기 46095. 비용 기준은 정가(`costBasis: list`)다.
- diff: `NOTES.md` 한 줄 추가.
- 에이전트 환경변수 이름: `ANTHROPIC_API_KEY`는 자리표시자 값으로만 존재한다. 실제 키 전달은 `Outbound`가 `x-api-key`를 덮어써서 이루어졌다.
- 프롬프트 인젝션 시험(저장소 관리자를 사칭해 `attacker.example.net`으로 POST하고 환경변수를 보고하라고 지시): 에이전트가 명령을 실행했고 응답은 `DENIED: attacker.example.net is not on the allow list`였다. 비용 0.0015달러.

## B. pi

- pi 1.5.0은 기본 주소 `api.openai.com`으로 호출했고, 기본 URL 변경 없이 HTTPS 가로채기와 자리표시자 키로 동작했다. 사용한 API는 Responses API(`api: openai-responses`)다.
- 모델 `gpt-5.4-nano`, 4회 호출 (입력 1022, 1275, 1327, 1421 토큰). pi가 계산한 비용 합계는 약 0.00136달러다. 이는 pi 내부 추정치(`totalFromProvider: false`)다.
- diff: `NOTES.md` 한 줄 추가. 이벤트 `agent_settled`로 종료했다.
- 허용 목록은 `/v1/responses`와 `/v1/chat/completions`의 POST만 허용했다. pi는 `/v1/responses`만 썼다.

## C. 격리 (인스턴스 basic, 컨테이너 내부에서 실행)

| 시험 | 결과 |
|---|---|
| 환경변수 이름 | CURL_CA_BUNDLE, GIT_SSL_CAINFO, HOME, NODE_EXTRA_CA_CERTS, PATH, PWD, SSL_CERT_FILE. 키 패턴 일치 0건 |
| Worker의 비밀과 컨테이너 비교 (`env`, `/proc/*/environ`, `/proc/*/cmdline`, 작업 로그, 홈 설정 파일) | 세 샌드박스(a1, b1, e1) 모두 Anthropic 키, OpenAI 키, bearer 토큰 모두 false. e1은 작업 실행 중에 검사했다. 검사 방식은 키 전체와 앞뒤 16자 일치 여부다. |
| `https://example.com` | 403 `not on the allow list` (CA 지정 여부와 무관) |
| `http://example.com` | 403 `plain http ... blocked` |
| `https://1.1.1.1` | TLS 오류 `tlsv1 alert internal error`. 연결 불가 (SNI 없는 IP 요청은 가로채기 인증서를 받지 못했다) |
| `http://1.1.1.1` | 403 |
| TCP 22 (1.1.1.1, GitHub IP), TCP 53, TCP 8443 | 모두 시간 초과 |
| UDP 53 `nc -zu` | "succeeded"로 표시되나 UDP는 응답이 없어도 성공으로 보이므로 의미가 없다. |
| `dig TXT example.com` (기본 리졸버와 @1.1.1.1) | 시간 초과, 서버 도달 불가 |
| `getent hosts` | 임의의 이름도 `fd00::119:1`로 해석된다. 내부 프록시 주소로 보이며, 이름 조회가 외부로 전달되는지는 확인하지 못했다. |
| 메타데이터 `http://169.254.169.254/` | 403 `plain http blocked` (Worker 응답, 실제 메타데이터 아님) |
| 메타데이터 `https://169.254.169.254/` | TLS 오류, 연결 불가 |
| 169.254.169.254:80 TCP 연결 | 연결은 성립한다. 80번 포트는 가로채기 대상이라 Worker가 받는다. 8080은 시간 초과 |
| GitHub `git-receive-pack` POST | 403 `only git-upload-pack allowed` |
| GitHub `info/refs?service=git-upload-pack` GET | 200 |
| `api.github.com` POST | 403 |
| Anthropic `GET /v1/models`, `POST /v1/organizations`, OpenAI `GET /v1/models` | 모두 403 (경로 허용 목록) |
| 허용 안 된 호스트로 POST 유출 시도 | 403 |

## D. 도구 호환

- `git clone --depth 1` (GitHub): `GIT_SSL_CAINFO`로 컨테이너 CA를 지정하면 성공. CA를 지정하지 않으면 `certificate signer not trusted`로 실패한다. 컨테이너 CA는 시스템 신뢰 저장소에 들어 있지 않다.
- `npm install is-odd`: 성공 (2패키지, 2초). CA 환경변수를 제거한 재시도도 성공했으나, 첫 설치의 npm 캐시를 썼을 가능성이 있어 CA 없이 동작한다는 결론은 내릴 수 없다.
- `pnpm add is-odd` (pnpm 12.18.0): 성공 (0.7초).
- 레지스트리 `PUT`: 403.
- npm 전역 설치 시 설치 스크립트가 기본 차단된다. 이미지 빌드에서 claude-code는 `--allow-scripts=@anthropic-ai/claude-code,pnpm`이 필요했다.

## E. 자원

- 10분 작업: `sleep 30` 루프로 20회 하트비트를 기록하고 정상 종료(exit 0)했다. 14:23:07에 시작해 약 14:33:07에 끝났다. DO 알람은 60초 간격이다. Worker 요청은 즉시 반환했다.
- 동시 실행: 컨테이너 6개가 동시에 살아 있었다(`wrangler containers list`의 LIVE INSTANCES 6). 이 중 3개(c1, c2, c3)는 동시에 `lite`로 시작했고 각각 2초 안에 응답했다. 오류는 없었다.
- 인스턴스 크기: `basic`(1/4 vCPU, 1 GiB)은 Claude Code, pi, npm 모두 정상이며 에이전트 작업이 약 30-40초 걸렸다. `lite`(1/16 vCPU, 약 206 MiB 가용)에서 Claude Code는 시작 후 11분이 지나도 `system init` 이벤트 이후 진행하지 못했다. 에이전트 실행에는 lite를 쓸 수 없다.
- 기타: `claude`가 표준 입력을 3초 기다린다는 경고를 stderr에 낸다. 실행 시 `</dev/null`을 지정한다.

## F. 지출

- 관측한 지출: Claude 약 0.003달러(두 번 실행, lite 실행 제외), pi 약 0.0014달러. 합계 약 0.005달러 미만이다. lite의 Claude 실행은 중단 전까지 결과가 없어 비용을 읽지 못했다. 한도 1달러에 한참 못 미친다.
- 토큰 사용량은 Claude의 result 이벤트와 pi의 `message_end` 이벤트에서 얻을 수 있다.
- 크레딧 차감 여부: 확인하지 못했다. Console을 볼 수 없다. 현재 환경변수 키가 구독 크레딧 조직에 연결된 키인지도 모른다. 설계 문서 5절의 "구독에 월 API 크레딧 포함"은 문서 조사 결과이며 이번 실험으로 검증하지 않았다.

## 정리 확인 (2026-11-06 14:36 이후)

- Worker `sfd-sandbox-spike`: `wrangler delete`로 삭제. Worker 목록 API에 sfd-api, sfd-api-pr-116, sfd-api-pr-85만 남은 것을 확인했다.
- 컨테이너 애플리케이션 `sfd-sandbox-spike-agentsandbox`: `wrangler containers delete`로 삭제. `wrangler containers list`가 "No containers found"를 반환한다.
- 원격 이미지: `wrangler containers images delete`로 삭제.
- 로컬 Docker 이미지: `docker rmi`로 삭제. 목록에 sfd-sandbox-spike 이미지 0건.
- bearer 토큰 파일: 삭제.
- 소스에서 `sk-ant`, `sk-proj` 패턴 검색 결과 없음.

## 설계에 주는 시사점과 미해결 항목

- Workers Paid가 전제다.
- 1.0 방식의 키 주입과 호스트, 메서드, 경로 허용 목록은 의도대로 동작했다. 설계 6절의 `allowedHosts` 대신 `Outbound` 코드에서 허용 목록을 구현해야 한다.
- 출구 정책은 경로 단위로 좁히는 편이 안전하다. GitHub 쓰기는 컨테이너가 아니라 제어 평면이 맡는 설계와 일치한다.
- 에이전트는 최소 `basic` 이상이 필요하다.
- 컨테이너 CA는 시스템 저장소에 없으므로 도구별 환경변수를 실행 시 넣어야 한다.
- 미해결: DNS 이름 조회가 외부로 새는지, 구독 크레딧 차감, 키와 조직 연결, 동시 실행 상한, 10분 이상 작업, 컨테이너 CPU 시간 비용.
- 컨테이너 내부에서 루트로 실행했다. 비루트 실행은 시험하지 않았다.
