# 변경 기록

사용자·운영자·책 독자가 알아야 할 의미 있는 변경을 기록합니다. 기준과 작성 절차는 [project-changelog 스킬](.agents/skills/project-changelog/SKILL.md)에 있습니다. 버전 번호를 임의로 부여하지 않고, 통합·배포를 확인한 한국시간 날짜로 정리합니다.

아래 과거 항목은 확인 가능한 PR의 주요 이력을 요약한 것이며, 모든 커밋이나 릴리스를 나열한 목록은 아닙니다.

## 미출시 (Unreleased)

### 변경

- 토론의 개정 표시를 절 단위로 정확하게 바꿨습니다. 책 동기화가 원고의 절마다 본문 해시를 저장하고, 절에 연결된 토론은 연 시점의 절 본문이 실제로 바뀌었을 때만 "이 토론 이후 책이 개정됨"으로 표시됩니다. 같은 장의 다른 절만 고쳐졌으면 표시되지 않습니다. 장 전체 토론과 해시 기록이 없는 이전 토론은 지금처럼 장의 개정 번호로 판정합니다. D1 마이그레이션 `0012_section_hash.sql`이 추가되며, 배포 뒤 첫 동기화가 해시가 없는 문서를 모두 다시 읽어 채웁니다.

## 2026-10-21

### 수정

- 스모크·배포 장애 이슈를 닫으면 자동 포스트모템이 사후 분석을 실행합니다. 닫힌 이슈 이벤트는 장애 종류를 이슈 라벨(`source:smoke`·`source:deploy`·`source:error`)로 정하고, 어느 라벨도 없을 때만 정체로 봅니다. 이전에는 `source:error`가 아닌 이슈를 모두 정체로 넘겨, 스모크 장애 [#66](https://github.com/roboco-io/the-software-factory-demo/issues/66)을 닫았을 때 분석 없이 건너뛰었습니다.
- 팩토리가 봇 PR을 병합하려면 head에서 실행된 모든 체크가 통과해야 합니다. 에이전트가 "사람 조치 필요"를 선언했거나 리뷰가 에이전트가 고칠 수 없는 지적을 남기면 사람에게 넘깁니다. 이전 리뷰 라운드의 미해결 지적은 다음 리뷰가 해소 여부를 답해야 승인되고, 트리아지는 요청이 깨뜨릴 보호 계약을 미리 알립니다. 이전에는 사이트 이름 변경(PR #65)이 스모크가 깨진다는 에이전트 보고와 리뷰 지적이 있었는데도 병합됐습니다.
- 팩토리가 만든 T2(인증·마이그레이션·의존성) PR도 교차 리뷰가 변경을 요청하면 T1과 같은 수정 라운드를 거칩니다. 사람 승인 대기로는 리뷰가 승인한 뒤에 넘어옵니다. 이전에는 리뷰 판정보다 먼저 사람에게 넘어가서, 리뷰가 지적한 결함이 고쳐지지 않은 채 승인을 기다렸습니다(PR #69).
- 팩토리가 만든 T0·T1 PR은 PR 프리뷰에서 프로덕션 읽기 전용 스모크까지 통과해야 자동 병합됩니다. 스모크가 실패하면 병합하지 않고 사람에게 넘깁니다. 배포·프리뷰 확인은 사이트 이름 대신 빌드 커밋 SHA로 새 빌드 반영을 확인합니다. 이전에는 사이트 이름 변경(PR #65)이 스모크 계약을 깬 채 병합되어 프로덕션 스모크가 27회 연속 실패했습니다([#66](https://github.com/roboco-io/the-software-factory-demo/issues/66)).
- 프로덕션 스모크가 실패하면 `source:smoke` 이슈 본문과 반복 실패 코멘트에 실패한 Hurl·Playwright 출력의 끝부분(각 40줄 이내)을 코드 블록으로 싣습니다. 같은 원문을 런 기록에도 남겨 주간 자기개선 리포트의 smoke 후보가 "(원문 없음)" 대신 실제 실패 원문을 대표 원문으로 보여 줍니다. 이전에는 run 링크만 있어서, 개선 에이전트가 이름 변경 후 옛 기대값(`conduit`)이 남은 원인([이슈 #66](https://github.com/roboco-io/the-software-factory-demo/issues/66))을 잘못 추정한 개선 PR을 만들었습니다. [PR #74](https://github.com/roboco-io/the-software-factory-demo/pull/74)

### 추가

- 에이전트가 읽을 수 있는 포럼 안내를 추가했습니다. API가 `GET /api/openapi.json`으로 포럼 경로의 OpenAPI 3.1 명세를 제공하고(경로 목록이 실제 라우터와 같은지 테스트로 확인), 웹 루트의 `llms.txt`가 포럼의 목적, 책과 연결하는 방법(`docId`·`anchor`, 개정 표시), 에이전트 토큰과 참여 규칙(출처 표시, 사람 행세 금지, 추천 불가, 빈도 제한)을 설명합니다.
- 포럼에 에이전트 계정을 추가했습니다. 로그인한 사람이 `POST /api/agents`로 에이전트를 등록하면 `sfa_` 토큰을 한 번 받고(서버는 해시만 저장), 에이전트는 그 토큰으로 토론·답글·신고를 씁니다. 모든 글의 작성자에 사람·에이전트 구분과 등록자가 붙고 웹에는 "에이전트" 배지와 등록자가 보입니다. 에이전트는 추천·계정 변경·RealWorld 쓰기·에이전트 등록을 할 수 없고, 최근 10분 동안 성공한 쓰기 20회까지만 할 수 있습니다. 등록자는 `GET /api/agents`로 목록을 보고 `DELETE /api/agents/<이름>`으로 토큰을 폐기합니다. 등록자는 자기 에이전트의 답글을 추천할 수 없습니다. D1 마이그레이션 `0009_agents.sql`이 `users`에 `kind`·`owner_id` 열을 더하고 `agent_tokens`·`agent_writes`(빈도 제한용 쓰기 기록) 테이블을 만듭니다. 에이전트 계정은 JWT로 인증할 수 없고, 사람은 `@agents.invalid` 이메일로 가입할 수 없습니다. 에이전트 계약 2개가 활성화되었습니다.
- 웹에 토론 화면(`#/topic/<id>`)과 작성 화면(`#/new`)을 추가했습니다. 토론 화면은 마크다운 본문, 연결된 장·절과 개정 표시, 답글과 답글의 답글(4단계까지 들여쓰기), 작성순·추천순 정렬, 추천, 신고, 자기 글의 수정·삭제를 제공합니다. 장 화면의 "이 절에서 토론 열기"로 장·절이 미리 채워진 작성 화면을 열 수 있고, 헤더에 "새 토론" 링크가 생겼습니다. 토론 목록에는 문서 ID 대신 문서 제목이 보입니다. 토론과 답글을 지울 때는 확인을 묻습니다.
- 웹 홈을 책 토론 포럼 화면으로 바꿨습니다. 홈은 최근 활동순 토론 목록과 책 목차(문서별 토론 수, 마지막 동기화 시각)를 보여 주고, 새 장 화면(`#/book/<문서>`)은 절 목록과 절별 토론, 책 원문 링크(factory.roboco.io)를 보여 줍니다. 토론에는 유형(질문·반론·사례·일반)과, 토론 이후 책이 개정되었거나 절이 사라졌다는 표시가 붙습니다. 기존 글 화면은 작성자 프로필에서 계속 볼 수 있습니다. 로컬 E2E는 포트를 `E2E_WEB_PORT`·`E2E_API_PORT`·`E2E_BOOK_PORT`로 바꿀 수 있습니다.
- 포럼 API에 토론·답글 신고를 추가했습니다(`POST /api/topics/:id/report`, `/api/replies/:id/report`). 로그인한 사용자가 사유(500자 이하)와 함께 신고하면 `reports` 테이블에 기록되고, 같은 대상을 다시 신고하면 기존 신고를 돌려줍니다. 첫 공개에서는 신고 접수만 제공하며, 숨김은 운영자가 데이터베이스에서 처리합니다. D1 마이그레이션 `0008_reports.sql`이 추가됩니다. [#90](https://github.com/roboco-io/the-software-factory-demo/issues/90)
- 포럼 API에 답글 추천을 추가했습니다. 로그인한 사용자는 남의 답글을 한 번 추천하고 취소할 수 있으며(반복해도 결과가 같음), 답글 목록을 `sort=top`으로 추천순 정렬할 수 있습니다. 답글 응답의 `score`와 `voted`가 실제 값을 돌려줍니다. D1 마이그레이션 `0007_reply_votes.sql`이 추가됩니다. [#89](https://github.com/roboco-io/the-software-factory-demo/issues/89)
- 포럼 API에 답글과 답글의 답글(스레드)을 추가했습니다(`/api/topics/:id/replies`, `/api/replies/:id`). 하위 답글이 있는 답글을 지우면 빈 본문의 삭제 표시로 자리만 남고, 답글이 달리면 토론 목록의 최근 활동순 정렬에 반영됩니다. D1 마이그레이션 `0006_replies.sql`이 추가됩니다. [PR #92](https://github.com/roboco-io/the-software-factory-demo/pull/92)
- 포럼 API에 책 목차와 토론을 추가했습니다. API Worker의 `scheduled` 핸들러와 Cron Trigger가 `BOOK_SOURCE_URL`의 매니페스트를 동기화하고(revision이 바뀐 문서만 원고를 다시 읽음, 실패하면 기존 데이터 유지), `GET /api/book`·`/api/book/:docId`와 장·절에 연결하는 토론 CRUD(`/api/topics`)를 제공합니다. 책이 개정되었거나 절이 사라지면 토론의 `book.status`가 `revised`·`removed`로 표시됩니다. D1 마이그레이션 `0005_book_forum.sql`이 추가됩니다.
- 책 토론 포럼으로 전환하기 위한 포럼 API 계약 스위트(`tests/forum/vendor/`)와 필수 체크 `forum-api`를 추가했습니다. 계약은 책 목차 동기화, 토론·답글·추천, 신고를 다루며 [계약 설명](tests/forum/vendor/CONTRACT.md)에 정리했습니다. 처음에는 모든 계약 파일을 건너뜀 목록(`tests/forum/skip.txt`)에 두고 기능을 구현할 때마다 지웠으며, 2026-10-21 기준 12개 모두 활성화되었습니다. 봇 구현 PR이 건너뜀 목록에 줄을 추가하는 것은 RealWorld와 같이 금지합니다. 프로덕션 웹 스모크는 "Global Feed" 문구 대신 홈 목록의 로딩 완료 표식을 확인하도록 바꿔, 홈 화면이 바뀌어도 스모크가 깨지지 않게 했습니다. 설계는 [책 토론 포럼 전환 설계](docs/superpowers/specs/2026-10-21-book-forum-design.md)에 있습니다.
- 프로필 이미지 업로드를 추가했습니다. 로그인한 사용자가 PNG·JPEG·GIF·WebP(최대 1MB)를 올리면 아바타가 갱신됩니다. 이미지는 새 `images` 테이블(D1 마이그레이션)에 저장되고, 본문 크기는 스트림을 읽는 동안 제한해 Content-Length가 없는 초과 요청도 거부합니다(PR #69, 이슈 #67).
- 데모 앱과 팩토리 대시보드에 Google Analytics 4를 추가했습니다. `roboco.io`에서 방문자가 동의 배너에서 동의한 뒤에만 GA를 불러오고, "통계 설정"에서 동의를 철회하면 수집을 끄고 데모 전용 GA 쿠키를 지웁니다. 로컬 실행과 PR 프리뷰에서는 배너와 GA를 불러오지 않습니다. [PR #68](https://github.com/roboco-io/the-software-factory-demo/pull/68)
- 프로덕션 장애와 요청 정체를 자동으로 분석하는 포스트모템을 추가했습니다. 장애가 감지되거나 복구되면 팩토리가 타임라인을 모아 원인을 분석하고, 비난 없는 형식의 기록을 장애 이슈에 남깁니다. 실패 원문이 있고 인용이 원인 PR의 변경과 겹치는 등 확신 조건을 모두 충족하면 원인 PR을 되돌리는 PR을 열어 T0·T1은 자동 병합하고 T2·T3는 사람 승인을 기다립니다. 복구가 확인되면 원인 PR의 요청 이슈를 다시 열고, 사실로 확인된 원인이 있으면 개선 PR을 위임합니다. 정책과 예산은 `factory/postmortem-policy.yml`에서 바꾸며(장애당 분석 2회, 회당 2 USD, 하루 10 USD), 운영 방법은 [운영 문서](docs/operations.md)에 있습니다. [PR #78](https://github.com/roboco-io/the-software-factory-demo/pull/78)

### 변경

- RealWorld 전용 D1 테이블(`articles`, `comments`, `tags`, `article_tags`, `favorites`)을 삭제했습니다(마이그레이션 `0011_drop_realworld_tables.sql`, 되돌릴 수 없음). 삭제 전에 프로덕션에서 옮기지 않은 행이 없음을 확인했고(글 12개·댓글 0개 모두 이전), D1 Time Travel 북마크와 전체 내보내기 백업을 남겼습니다.
- RealWorld API 경로(글·댓글·태그·즐겨찾기·팔로우·피드)와 글 화면(글 보기·글 편집기·글 목록)을 제거했습니다. 이 경로는 이제 404 `route: not found`를 돌려줍니다. 계정(`/users`, `/user`)과 프로필(`/profiles/:username`) 경로는 남고, 프로필 화면은 그 사용자가 작성한 토론을 보여 줍니다. 헤더의 "New Article" 링크도 없앴습니다. 옛 글과 댓글은 이미 토론과 답글로 옮겨져 있고(마이그레이션 0010), 원본 테이블은 아직 남아 있습니다.
- RealWorld 공식 Hurl 계약 스위트를 은퇴시켰습니다. 필수 체크 `realworld-api`와 CI job, `tests/realworld/`, `scripts/realworld-api.sh`·`vendor-realworld.sh`, 관련 보호 경로(T3)·CODEOWNERS 항목을 제거했고, 봇 구현 PR이 건너뜀 목록에 줄을 추가하지 못하게 하는 규칙(F21)은 이제 포럼 건너뜀 목록에만 적용됩니다. 구현 요청의 수용 기준과 에이전트 프롬프트도 포럼 계약 기준으로 바꿨습니다. RealWorld 기준 데모 리허설 문서에는 그대로 재현할 수 없다는 안내를 붙였습니다. 이전 Hurl 테스트의 MIT 고지는 git 이력에 남습니다.
- 프로덕션 스모크(`tests/smoke/readonly.hurl`)와 배포 직후 검사가 RealWorld 글·태그 목록 대신 포럼의 책 목차(`/api/book`)와 토론 목록(`/api/topics`)을 확인합니다. RealWorld 경로를 지우기 전에 스모크의 의존을 먼저 옮긴 것입니다(설계 6.3절).
- 기존 RealWorld 글을 책과 연결하지 않은 일반 토론으로, 댓글을 최상위 답글로 옮겼습니다(D1 마이그레이션 `0010_legacy_articles_to_topics.sql`). 글의 요약은 토론 본문 첫 문단이 되고, 태그와 즐겨찾기는 옮기지 않습니다. 원본 테이블은 남겨 두며, 이전 결과를 프로덕션에서 확인한 뒤 별도로 지웁니다. 배포 전 프로덕션 데이터 사본(글 12개, 댓글 0개)으로 로컬에서 적용해 12개가 모두 옮겨지는 것을 확인했습니다.
- 웹 홈 화면에 표시되는 사이트 이름을 `conduit`에서 `conveyor`로 변경했습니다(이름 변경 PR #65는 2026-10-14 병합, 스모크 기대값 갱신 PR #64는 2026-10-21 병합). 이름 변경 후 프로덕션 스모크·배포 확인·PR 프리뷰 확인이 옛 이름을 찾아 실패하던 문제도 새 이름 기준으로 고쳤습니다. [PR #65](https://github.com/roboco-io/the-software-factory-demo/pull/65), [PR #64](https://github.com/roboco-io/the-software-factory-demo/pull/64)
- 사람이 연 PR의 승인 절차를 정했습니다. 1인 조직이라 작성자가 자기 PR을 병합해야 하는데, GitHub은 자기 PR 승인을 막습니다. 그래서 CODEOWNER가 로컬 세션에서 승인을 요청하면 독립 리뷰 에이전트가 PR diff를 한 번 리뷰하고, 통과하면 리뷰 결과를 PR 코멘트로 남긴 뒤 병합합니다. 절차는 [AGENTS.md](AGENTS.md)에 있습니다. [PR #80](https://github.com/roboco-io/the-software-factory-demo/pull/80)

## 2026-10-14

### 변경

- 저장소 이름과 공개 링크를 `the-software-factory-demo`로 변경했습니다. 데모 문서·런 기록·팩토리 기본 주소를 맞추고, 책 집필 프로젝트의 72개 공개 링크도 갱신했습니다. [데모 PR #61](https://github.com/roboco-io/the-software-factory-demo/pull/61), [책 PR #1](https://github.com/roboco-io/the-software-factory/pull/1)
- README에 로보코가 제안하는 소프트웨어 팩토리의 구현체라는 이름의 의미와 책 『The Software Factory』와의 관계를 설명하고, 개발자·운영자 상세 안내를 [별도 문서](docs/operations.md)로 분리했습니다.

### 추가

- 변경 기록 파일과 기록·제외 기준을 적용하는 프로젝트 스킬을 추가했습니다. 기능·운영 정책·공개 사용법의 실질적 변화는 기록하고, 포맷·반복 실행·상태 로그는 제외합니다.

## 2026-10-13

### 추가

- 요청별 처리 타임라인, 자가 개선의 관찰 근거, 에이전트 도구·실제 모델별 실행 결과를 대시보드에 제공합니다. 비용 누락, 표본 부족, 관찰 범위 밖의 데이터를 구분하고 체험·리포지토리 링크를 안내합니다. [PR #60](https://github.com/roboco-io/the-software-factory-demo/pull/60)
- 병렬 로컬 작업에 별도 브랜치와 워크트리를 사용하도록 개발 지침을 명시합니다. [PR #57](https://github.com/roboco-io/the-software-factory-demo/pull/57)

### 변경

- 비개발자가 개념을 이해하고 직접 체험하도록 README에 실행 절차, 권한과 자가 개선 PoC를 안내합니다. [PR #57](https://github.com/roboco-io/the-software-factory-demo/pull/57), [PR #58](https://github.com/roboco-io/the-software-factory-demo/pull/58)
- 프로젝트 자체 코드·문서·설정에 Apache-2.0을 적용하고, RealWorld의 MIT 고지를 보존합니다. [PR #56](https://github.com/roboco-io/the-software-factory-demo/pull/56)

## 2026-10-12

### 추가

- 반복되는 오류 응답 형식 지적을 자동 검사 규칙과 평가 케이스로 전환하는 자가 개선 실험을 검증했습니다. [PR #47](https://github.com/roboco-io/the-software-factory-demo/pull/47)

### 수정

- 이미 개선 규칙으로 처리한 과거 실패가 같은 개선 후보로 다시 선정되지 않게 합니다. [PR #51](https://github.com/roboco-io/the-software-factory-demo/pull/51)
- 후속 배포가 성공하면 대체된 배포 실행에 연결된 이슈의 완료 상태도 반영합니다. [PR #52](https://github.com/roboco-io/the-software-factory-demo/pull/52)
