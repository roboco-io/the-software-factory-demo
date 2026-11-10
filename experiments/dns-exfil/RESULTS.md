# DNS 유출 실험 결과

실행: 2026-11-10 16:29-16:36 (KST). 버전: wrangler 4.158.0, 컨테이너 런타임 이미지 `cloudflare/sandbox:1.0.3`의 `sandbox-shim`, 기반 이미지 `node:24-trixie-slim`, dig 9.20.30. 인스턴스는 `basic`이다.

## 질문과 결론

설계 문서 6절은 샌드박스를 공개하기 전에 "DNS 이름 조회로 외부에 데이터가 나가지 않음"을 시험으로 확인하라고 요구한다. 이 실험은 에이전트 컨테이너와 같은 네트워크 구성에서 그 조건을 확인했다.

결론은 다음과 같다. 이 구성에서 컨테이너 안의 DNS 조회는 외부의 권한 있는 DNS 서버에 도달하지 않았다. 두 번의 실행에서 컨테이너가 로깅 도메인 아래로 보낸 표식 이름 37개(1회차 15개, 2회차 22개) 중 DNS 로깅 서버에 기록된 것은 0개였다. 같은 시간에 로컬 PC에서 보낸 대조 조회는 매번 기록되었다. 따라서 로깅 수단은 동작했고, 컨테이너의 조회만 밖으로 나가지 않았다고 판단한다. 이 결론은 현재 플랫폼 동작에 대한 관측이다. Cloudflare가 동작을 바꾸면 다시 확인해야 한다. 아래 "제안" 절에 재확인 방법을 적었다.

| 질문 | 답 | 근거 |
|---|---|---|
| 1. 컨테이너 안의 프로세스가 임의의 도메인 이름을 조회할 수 있는가 | A와 AAAA는 항상 답을 받는다. 다른 레코드 종류는 시간 초과다. | 어떤 이름이든 A는 `11.9.0.1`, AAAA는 `fd00::119:1`로 답한다. 존재하지 않는 최상위 도메인(`.invalid-tld-zz`)도 같다. 이 주소는 실제 주소가 아니라 플랫폼이 HTTP 가로채기로 보내기 위해 만든 가짜 주소다. TXT, MX, CNAME, NS, SRV, HTTPS, ANY는 모두 시간 초과였다. |
| 2. 그 조회가 컨테이너 밖의 권한 있는 DNS 서버에 도달하는가 | 도달하지 않았다. | dnslog.cn 로그에 컨테이너 표식 0건, 로컬 대조 조회는 2건 모두 기록(아래 "판정 방법"). 실제 답이 있는 이름(`o-o.myaddr.l.google.com` TXT, `whoami.cloudflare` CH TXT)도 답을 받지 못했다. 조회가 실제 리졸버로 전달되었다면 리졸버 주소가 돌아왔어야 한다. |
| 3. 직접 UDP/TCP 53, DoH, DoT가 막혀 있는가 | 막혀 있다. 단, UDP 53은 막히는 대신 플랫폼이 가로채서 가짜 답을 준다. | UDP 53은 목적지 IP가 1.1.1.1이든 8.8.8.8이든 A/AAAA에 가짜 주소로 답했고(응답에 `aa` 플래그), 외부 로그에는 남지 않았다. TCP 53, DoT(853)는 시간 초과. IP로 접속하는 DoH(`dig +https @1.1.1.1`)는 TLS 오류. 이름으로 접속하는 DoH(`cloudflare-dns.com`, `dns.google`)는 출구 핸들러에 도착해 거부되었다. |
| 4. 출구 핸들러가 DNS에 대해 어떤 보호를 하는가 | DNS 자체는 보호하지 않는다. DoH처럼 HTTP로 감싼 DNS만 막는다. | 출구 핸들러(`Outbound`)는 80, 443 트래픽만 받는다. 프로덕션의 `decideOutbound`는 `api.anthropic.com`, `api.openai.com`, `github.com` 외의 호스트를 `host_not_allowed`로 거부하므로 DoH 공급자에 닿지 않는다. 일반 DNS를 막는 것은 출구 핸들러가 아니라 `enableInternet: false`인 컨테이너 네트워크다. |

## 구조

Worker `sfd-dns-probe`가 Durable Object `ProbeSandbox`로 컨테이너 하나를 실행했다. 컨테이너 시작 방식은 프로덕션 `apps/control/src/agent-sandbox.ts`와 같다. `enableInternet: false`로 시작하고, `interceptAllOutboundHttp`와 `interceptOutboundHttps("*")`로 모든 80, 443 트래픽을 Worker의 `Outbound` 엔트리포인트로 보낸다. 실험의 `Outbound`는 프로덕션 허용 목록 대신 모든 요청을 403으로 거부하고, 응답 본문에 요청된 호스트 이름을 적는다(`src/deny.ts`, 시험은 `src/deny.test.ts`). 거부만 하므로 Worker는 요청된 호스트를 조회하거나 접속하지 않는다. 이미지는 프로덕션과 같은 기반 이미지에 `dnsutils`, `netcat-openbsd`, `iproute2`, `python3`을 더했고 에이전트와 키는 없다. Worker의 비밀 값은 무작위 접근 토큰 하나뿐이었다.

컨테이너 안에서 `probe.sh`를 실행했다. 각 프로브는 `p01-<실행 표식>.<로깅 도메인>`처럼 자기 번호를 이름에 넣는다. 그래서 로그에 이름이 남으면 어떤 프로브가 샌 것인지 알 수 있다. 실행 표식은 무작위 16진수 8자리(`ma294fe1a`, `mb8d93df7`)이며 비밀 값이 아니다. 19번 프로브는 데이터처럼 보이는 긴 라벨(문자열 "marker-not-a-secret"의 16진수)을 썼다.

## 판정 방법

외부 도달 여부는 공개 DNS 로깅 서비스 dnslog.cn으로 판단했다. 이 서비스는 가입 없이 하위 도메인(`qef71a.dnslog.cn`)을 주고, 그 아래 이름에 대한 권한 있는 서버 조회를 기록해 HTTP로 보여준다. 사용 전 로컬 PC에서 조회해 기록되는 것을 확인했다(16:29:10, 질의 출발지는 Google 공용 리졸버 주소).

각 실행 뒤 로컬 PC에서 같은 표식으로 `ctl-<실행 표식>` 이름을 조회한 다음 로그를 읽었다. 대조 조회가 기록되고 컨테이너 프로브 이름이 없으면 "컨테이너의 조회가 도달하지 않음"으로 판정한다.

| 실행 | 컨테이너 실행 시각 | 로그 확인 시각 | 컨테이너 표식 기록 | 대조 조회 기록 |
|---|---|---|---|---|
| 1 (`ma294fe1a`, 프로브 p01-p17) | 16:31:38 | 16:32:44, 16:35:20 | 0건 | 기록됨(16:32:58 조회) |
| 2 (`mb8d93df7`, 프로브 p01-p19) | 16:33:22 | 16:35:20 | 0건 | 기록됨(16:35:17 조회) |

dnslog.cn 화면의 시각은 KST보다 1시간 늦게 표시된다(서버 시간대 차이로 보인다). 사용 전 확인용 조회(16:29:10)는 16:32:44 이후 응답에서 사라졌다. 원인은 확인하지 못했다. 반면 각 실행의 대조 조회는 이후 응답에도 남아 있었다(1회차 대조 조회는 2분 넘게 유지). 그래서 로그 보존이 완전하다고 단정하지 않고, 각 실행 직후 같은 창 안에 넣은 대조 조회로 판정한다. 1회차는 실행 뒤 약 3분 40초까지, 2회차는 약 2분까지 확인했다. 그보다 늦게 도착하는 조회는 확인하지 못했다. 정리 과정에서 dnslog.cn 세션 쿠키를 지워 이후 기록은 더 읽을 수 없다.

원본 출력은 `evidence/`에 있다. `run*-container.txt`는 컨테이너 출력, `run*-dnslog.json`은 그 시점의 로그 응답이다.

## 프로브별 결과

| 프로브 | 방법 | 결과 |
|---|---|---|
| 환경 | `/etc/resolv.conf`, 경로 | `nameserver 1.1.1.1`, `9.9.9.9`, `2606:4700:4700::1111`. 인터페이스 `cfeth0` 하나(10.0.0.1/24, fd00::11/8), 기본 경로 10.0.0.254와 fd00::22 |
| p01 | `getent ahosts` | `fd00::119:1`, `11.9.0.1` |
| p02 | `dig A`(기본 리졸버) | `11.9.0.1`, 응답 서버는 1.1.1.1로 표시, `aa` 플래그 |
| p03 | `dig TXT` | 세 리졸버 모두 시간 초과 |
| p04 | `dig +tcp A` | 시간 초과 |
| p05 | `dig AAAA @1.1.1.1` | `fd00::119:1` |
| p06 | 존재하지 않는 최상위 도메인 | `fd00::119:1`, `11.9.0.1` |
| p07 | 실제 답이 있는 TXT 이름 | 시간 초과 |
| p08 | `dig @1.1.1.1`, `dig @8.8.8.8` | 둘 다 `11.9.0.1`. 목적지와 무관하게 UDP 53을 플랫폼이 가로챈다. |
| p09 | `dig +tcp @1.1.1.1` | 시간 초과 |
| p10 | DoT `dig +tls @1.1.1.1` | 시간 초과 |
| p11 | DoH `dig +https @1.1.1.1` | TLS 오류 |
| p12 | DoH `https://cloudflare-dns.com/dns-query` | `DENIED-BY-OUTBOUND host=cloudflare-dns.com` |
| p13 | DoH `https://dns.google/resolve` | `DENIED-BY-OUTBOUND host=dns.google` |
| p14 | `https://<표식 이름>/` | 출구 핸들러에 도착, 거부. 외부 DNS 기록 없음 |
| p15 | `http://<표식 이름>/` | 출구 핸들러에 도착, 거부. 외부 DNS 기록 없음 |
| p16 | Python `socket.getaddrinfo` | `fd00::119:1`, `11.9.0.1` |
| p17 | `nc -u` 로 UDP 53에 임의 바이트 | 종료 코드 0. UDP라 의미 있는 판정이 아니다. |
| p18 | MX, CNAME, NS, SRV, HTTPS, ANY | 모두 시간 초과 |
| p19 | 긴 16진수 라벨 A 조회 | `11.9.0.1` |

p14와 p15는 HTTP 가로채기 경로가 이름을 외부에서 조회하는지 확인하기 위한 것이다. 조회 기록이 없었으므로 플랫폼은 HTTPS의 SNI와 HTTP의 Host 헤더로 호스트를 알아내 Worker에 넘기며, 그 과정에서 이름을 외부에 조회하지 않는다고 판단한다.

## 공식 문서와의 비교

2026-11-10에 확인한 Cloudflare 문서의 설명은 관측과 대체로 맞는다. Containers 문서(developers.cloudflare.com/containers/configuration/outbound-traffic/)는 DNS 조회가 공용 리졸버에 닿지 않고, 가로채기 대상 이름에만 Worker로 가는 자리표시 주소로 답한다고 설명한다. Sandbox SDK 문서(developers.cloudflare.com/sandbox/sdk/guides/outbound-traffic/)는 `enableInternet: false`에서도 DNS는 Cloudflare DNS 서버로만 간다고 적고 있다. 이 문장은 조회가 Cloudflare 리졸버를 거쳐 권한 있는 서버까지 갈 수 있다는 뜻으로도 읽힌다. 이번 관측에서는 그런 전달이 없었다. 두 문서의 표현이 다르므로 문서만으로 판단하지 않고 이 실험의 관측을 근거로 삼는다.

## 범위 밖과 남은 위험

이 실험은 DNS 경로만 확인했다. 허용된 HTTP 목적지를 통한 유출은 별도 문제다. 예를 들어 에이전트가 LLM 요청 본문에 데이터를 넣으면 그 데이터는 Anthropic이나 OpenAI에 도달한다. 이 경로는 공격자가 직접 읽을 수 없는 곳으로 가지만, 6절의 다른 조건(허용 목록, 저장소 범위)으로 따로 판단해야 한다.

플랫폼이 UDP 53을 가로채 가짜 답을 주는 동작은 문서화된 보장과 관측에 의존한다. 이 저장소의 코드가 강제하는 것이 아니다. `enableInternet`을 `true`로 바꾸거나, 가로채기 대신 Sandbox SDK의 `allowedHosts` 방식으로 옮기거나, `@cloudflare/sandbox`와 wrangler를 올리면 동작이 달라질 수 있다.

## 제안

유출은 관측되지 않았으므로 컨테이너 DNS 설정을 바꿀 필요는 없다. 컨테이너의 `/etc/resolv.conf`를 바꿔도 UDP 53은 목적지와 무관하게 플랫폼이 가로채므로 효과가 없다. 대신 다음을 제안한다.

첫째, 에이전트 컨테이너는 계속 `enableInternet: false`와 `interceptAllOutboundHttp`, `interceptOutboundHttps("*")` 조합으로 시작한다. 이 조합을 바꾸는 변경은 이 실험을 다시 실행한 뒤에만 병합한다.

둘째, 7단계 공개 직전과 `@cloudflare/sandbox`, wrangler, 컨테이너 이미지의 판을 올릴 때 이 실험을 다시 실행한다. 실행 방법은 아래에 있다. 판정 기준은 "대조 조회는 기록되고 컨테이너 표식은 0건"이다.

셋째, 공개 전 점검 목록(설계 6절)의 DNS 항목은 이 결과로 충족된 것으로 보되, 위 재확인 조건을 함께 적는다.

## 다시 실행하는 방법

실험용 Worker 배포는 사람의 승인을 받는다. 순서는 다음과 같다. `npm install` 후 무작위 토큰을 권한 600 파일에 만들고, `PROBE_TOKEN=<토큰>` 한 줄을 담은 임시 파일로 `wrangler deploy --secrets-file <파일>`을 실행한 뒤 그 파일을 지운다. dnslog.cn의 `getdomain.php`로 하위 도메인을 받고(쿠키 저장), `probe.sh` 앞에 `set -- <표식> <도메인>`을 붙여 `POST /exec?t=280`의 본문으로 보낸다. 인증 헤더는 파일로 넘긴다(`curl -H @파일`). 실행 뒤 로컬에서 `ctl-<표식>.<도메인>`을 조회하고 `getrecords.php`를 읽는다. 끝나면 `POST /destroy`, `wrangler delete`, `wrangler containers delete`, `wrangler containers images delete`, `docker rmi`로 정리한다.

## 정리 확인 (2026-11-10 16:36 KST)

- Worker `sfd-dns-probe`: `wrangler delete`로 삭제. 주소가 404를 반환하고, 배포 목록 API가 "This Worker does not exist"(코드 10007)를 반환한다.
- 컨테이너 애플리케이션 `sfd-dns-probe-probesandbox`: 삭제. `wrangler containers list`에 0건.
- 원격 이미지 `sfd-dns-probe-probesandbox-probe`: 삭제. `wrangler containers images list`에 0건.
- 로컬 Docker 이미지: `docker rmi`로 삭제.
- 접근 토큰 파일과 인증 헤더 파일: 삭제. `evidence/`에 토큰이 없음을 검색으로 확인했다.
- 같은 계정의 다른 컨테이너와 이미지(`hivemind-*`), 프로덕션 Worker는 건드리지 않았다.
