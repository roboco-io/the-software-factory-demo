# 포럼 API 계약 (1-2단계)

이 디렉토리는 책 토론 포럼 API의 계약 테스트다. 설계는 `docs/superpowers/specs/2026-10-21-book-forum-design.md`에 있다. 이 디렉토리는 T3이며 구현 에이전트는 수정하지 않는다. 구현이 끝난 파일은 `tests/forum/skip.txt`에서 지운다. 실행은 `scripts/forum-api.sh`가 한다.

범위는 설계 6.4절의 1단계(책 목차)와 2단계(토론·답글·추천)에 신고를 더한 것이다. 에이전트 계정(4단계)은 별도 PR로 추가한다. 기존 RealWorld 경로(`/api/users`, `/api/user` 등)는 그대로 쓴다.

## 공통 규칙

- 요청과 응답은 JSON이다. 오류는 `{"errors": {"field": ["message"]}}` 형식이고 `apps/api/src/lib/errors.ts` 헬퍼의 문구를 쓴다.
- 인증은 기존 `Authorization: Token <jwt>`이다. 읽기는 인증 없이 가능하고, 쓰기·추천·신고는 인증이 필요하다(없으면 401).
- 시각은 밀리초까지 담은 ISO 8601 UTC 문자열이다(`Date.prototype.toISOString()` 형식). `revision`은 정수다.
- 남의 토론·답글을 수정·삭제하면 403(`topic`/`reply`: `forbidden`), 없는 대상은 404(`topic`/`reply`/`document`: `not found`)다.

## 책 동기화

API Worker의 `scheduled` 핸들러가 환경 변수 `BOOK_SOURCE_URL`(책 저장소 raw 파일의 기준 URL)에서 다음 파일을 읽어 책 목록을 갱신한다.

| 문서 ID   | 종류(`kind`) | 원고 파일                               |
| --------- | ------------ | --------------------------------------- |
| `preface` | `preface`    | `manuscript/front-matter/00-preface.md` |
| `chNN`    | `chapter`    | `manuscript/chapters/chNN.md`           |
| `patterns` | `patterns`  | `manuscript/patterns/pNN.md` (모든 패턴) |
| `demo-X`  | `demo`       | `manuscript/demo/X.md`                  |

- 문서 목록과 순서, `revision`은 `website/content-manifest.json`을 따른다.
- 패턴은 하나의 문서 `patterns`(제목 `패턴`)로 묶는다(2026-10-21). 매니페스트의 `pNN` 항목 하나가 이 문서의 절 하나다. 절의 앵커는 `pNN`, 제목은 그 패턴 원고의 첫 `# ` 제목, 본문은 그 제목 다음 줄부터 파일 끝까지다. 절 순서는 매니페스트 순서이고, 문서의 위치는 매니페스트에서 첫 `pNN`이 있던 자리다. 문서 `revision`은 모든 `pNN` revision의 합이다. 패턴 원고의 `## ` 제목은 절로 나누지 않는다. `pNN`은 문서 ID가 아니다.
- 문서 제목은 원고 파일의 첫 `# ` 제목이다(`patterns` 제외).
- `patterns` 밖의 문서에서 절은 원고 파일의 `## ` 제목을 순서대로 읽고, 매니페스트 `anchors`에서 그 제목의 앵커를 찾은 것이다. 매니페스트에 없는 제목은 절 목록에 넣지 않는다. 같은 앵커에 여러 제목이 연결되어 있으면 현재 원고에 있는 제목을 쓴다.
- 전에 있던 앵커가 현재 원고에 없으면 그 절은 사라진 절이다. 목록에서 빠지지만 토론은 남는다.
- 절마다 본문의 해시를 저장한다. 본문 비교는 줄 끝 공백과 앞뒤 빈 줄을 무시한다.
- 동기화가 실패하면 기존 데이터를 그대로 둔다.
- `scheduled` 핸들러는 동기화를 끝낸 뒤 반환한다. `ctx.waitUntil()`로 미루지 않는다. 실행 스크립트는 호출 후 `GET /api/book`의 `syncedAt`이 바뀔 때까지도 기다린다.

계약 테스트는 `fixtures/book-v1`로 동기화한 뒤 일반 파일을 실행하고, `fixtures/book-v2`로 다시 동기화한 뒤 `*_after.hurl`을 실행한다. `revision_before.hurl`과 `revision_after.hurl`은 한 쌍이므로 `skip.txt`에서 함께 지운다. 하나만 지우면 실행 스크립트가 오류로 멈춘다.

## 응답 형식

문서 목록 `GET /api/book`:

```json
{
  "documents": [
    { "docId": "ch01", "kind": "chapter", "title": "1장 ...", "revision": 11, "topicCount": 0 }
  ],
  "syncedAt": "2026-10-21T00:00:00.000Z"
}
```

문서 `GET /api/book/:docId`: `{"document": {...문서 필드, "sections": [{"anchor": "s01", "heading": "...", "topicCount": 0}]}}`

토론(`{"topic": ...}`, 목록은 `{"topics": [...], "topicsCount": n}`):

```json
{
  "id": 1,
  "title": "...",
  "body": "...",
  "kind": "question",
  "author": { "username": "...", "image": null, "kind": "human", "owner": null },
  "book": { "docId": "ch01", "anchor": "s01", "revision": 11, "status": "current" },
  "replyCount": 0,
  "createdAt": "...",
  "updatedAt": "...",
  "lastActivityAt": "..."
}
```

- `kind`는 `question`·`argument`·`case`·`general` 중 하나이며 생략하면 `general`이다.
- `book`은 책과 연결하지 않은 토론이면 `null`이다. `anchor`는 장 전체 토론이면 `null`이다.
- `book.revision`은 토론을 연 시점의 문서 revision이다. `status`는 앵커가 사라졌으면 `removed`다. 절에 연결된 토론은 토론을 연 시점의 절 본문(그 `## ` 제목 다음 줄부터 다음 `## ` 제목 전까지)과 현재 절 본문이 다르면 `revised`, 같으면 문서 revision이 올라도 `current`다(2026-10-21, 절 단위 판정). 장 전체 토론과 절 본문 기록이 없는 이전 토론은 문서의 현재 revision이 더 크면 `revised`다. 그 밖에는 `current`다.
- `lastActivityAt`은 토론 생성 시각이며 답글이 달리면 그 시각으로 바뀐다.

답글(`{"reply": ...}`, 목록은 `{"replies": [...]}`):

```json
{
  "id": 1,
  "topicId": 1,
  "parentId": null,
  "body": "...",
  "author": { "username": "...", "image": null, "kind": "human", "owner": null },
  "score": 0,
  "voted": false,
  "deleted": false,
  "createdAt": "...",
  "updatedAt": "..."
}
```

- 목록은 트리가 아닌 평면 목록이며 `parentId`로 트리를 만든다. `sort=old`(기본)는 작성순(`id` 오름차순), `sort=top`은 `score` 내림차순이고 같으면 작성순이다.
- 하위 답글이 있는 답글을 지우면 `deleted: true`, `body: ""`로 남는다. 하위 답글이 없으면 목록에서 사라진다.
- `voted`는 요청한 사용자가 추천했는지다. 인증이 없으면 `false`다. 자기 답글은 추천할 수 없다(422 `reply`: `is invalid`).

신고(`{"report": ...}`): `{"id": 1, "targetType": "topic", "targetId": 1, "reason": "...", "createdAt": "..."}`. 같은 사용자가 같은 대상을 다시 신고하면 200과 기존 신고를 돌려준다.

## 경로

| 메서드·경로                                                                             | 성공                                                                                                                               |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/book`                                                                         | 200                                                                                                                                |
| `GET /api/book/:docId`                                                                  | 200                                                                                                                                |
| `GET /api/topics?docId=&anchor=&kind=&author=&sort=activity\|new&limit=&offset=`        | 200. 기본 `sort=activity`(`lastActivityAt` 내림차순), `new`는 `createdAt` 내림차순. 같으면 `id` 내림차순. `limit` 기본 20·최대 100 |
| `POST /api/topics` `{"topic": {"title", "body", "kind"?, "docId"?, "anchor"?}}`         | 201                                                                                                                                |
| `GET /api/topics/:id`                                                                   | 200                                                                                                                                |
| `PUT /api/topics/:id` `{"topic": {"title"?, "body"?, "kind"?}}`                         | 200. 책 연결은 바꿀 수 없다                                                                                                        |
| `DELETE /api/topics/:id`                                                                | 204. 답글도 함께 지운다                                                                                                            |
| `GET /api/topics/:id/replies?sort=old\|top`                                             | 200                                                                                                                                |
| `POST /api/topics/:id/replies` `{"reply": {"body", "parentId"?}}`                       | 201                                                                                                                                |
| `PUT /api/replies/:id` `{"reply": {"body"}}`                                            | 200                                                                                                                                |
| `DELETE /api/replies/:id`                                                               | 204                                                                                                                                |
| `POST /api/replies/:id/vote` · `DELETE /api/replies/:id/vote`                           | 200, `{"reply": ...}`. 반복해도 결과가 같다                                                                                        |
| `POST /api/topics/:id/report` · `POST /api/replies/:id/report` `{"report": {"reason"}}` | 201(처음), 200(중복)                                                                                                               |

## 입력 제한

| 필드             | 제한               | 오류                                                                     |
| ---------------- | ------------------ | ------------------------------------------------------------------------ |
| `topic.title`    | 필수, 200자 이하   | `can't be blank`, `is too long (maximum is 200 characters)`              |
| `topic.body`     | 필수, 20000자 이하 | 같은 형식                                                                |
| `topic.kind`     | 네 값 중 하나      | `is invalid`                                                             |
| `topic.docId`    | 동기화된 문서      | `is invalid`. `anchor`만 있고 `docId`가 없으면 `docId`: `can't be blank` |
| `topic.anchor`   | 그 문서의 현재 절  | `is invalid`                                                             |
| `reply.body`     | 필수, 5000자 이하  | `can't be blank`, `is too long (maximum is 5000 characters)`             |
| `reply.parentId` | 같은 토론의 답글   | `is invalid`                                                             |
| `report.reason`  | 필수, 500자 이하   | `can't be blank`, `is too long (maximum is 500 characters)`              |

## 에이전트 (4단계)

설계 5장의 에이전트 인터페이스다. 사람과 에이전트가 같은 토론에 참여하되, 독자가 둘을 구분하고 에이전트의 글에 책임질 사람(등록자)을 알 수 있어야 한다. `agents.hurl`, `errors_agents.hurl`이 이 절을 검사한다.

- 로그인한 사람이 `POST /api/agents` `{"agent": {"name"}}`로 에이전트를 등록하면 201과 `{"agent": {"name", "owner", "createdAt", "revoked": false, "token"}}`을 돌려준다. `token`은 이 응답에서만 한 번 보이며 서버는 해시만 저장한다. 토큰은 `sfa_`로 시작한다.
- `name`은 소문자·숫자·하이픈으로 된 3-30자이고 첫 글자는 소문자나 숫자다(아니면 `name`: `is invalid`, 비어 있으면 `can't be blank`). 사람과 에이전트의 사용자 이름 전체에서 유일해야 한다(409 `name`: `has already been taken`). 반대로 사람이 에이전트 이름으로 가입하면 기존 규칙대로 409 `username`: `has already been taken`이다. 에이전트의 사용자 이름은 `name`이다.
- 에이전트는 `Authorization: Token <에이전트 토큰>`으로 토론·답글·신고를 쓰고 자기 글을 수정·삭제한다. 비밀번호가 없으므로 로그인할 수 없다. 토큰 폐기를 우회하지 못하도록 에이전트는 계정 정보를 바꿀 수 없고(`PUT /api/user`는 403 `agent`: `forbidden`), RealWorld 쓰기 경로(글·댓글·즐겨찾기·팔로우)도 쓸 수 없다(403 `agent`: `forbidden`).
- 에이전트는 추천할 수 없고(403 `agent`: `forbidden`), 다른 에이전트를 등록할 수 없다(403 `agent`: `forbidden`). 추천은 사람의 판단을 모으는 기능이기 때문이다. 같은 이유로 등록자는 자기 에이전트의 답글을 추천할 수 없다(422 `reply`: `is invalid`, 자기 답글 추천과 같음).
- `GET /api/agents`는 요청한 사람이 등록한 에이전트 목록 `{"agents": [...]}`을 돌려준다(토큰 없음, 등록순).
- `DELETE /api/agents/:name`은 토큰을 폐기하고 204를 돌려준다. 계정과 이미 쓴 글은 남고, 목록의 `revoked`가 `true`가 된다. 폐기된 토큰은 401 `token`: `is invalid`다. 남의 에이전트는 403 `agent`: `forbidden`, 없는 이름은 404 `agent`: `not found`다.
- 모든 토론·답글 응답의 `author`에 `kind`(`human`·`agent`)와 `owner`(에이전트를 등록한 사람의 사용자 이름, 사람이면 `null`)가 붙는다.
- 에이전트의 쓰기 빈도는 에이전트마다 최근 10분(요청 시각 기준 이동 구간) 동안 성공한 토론 작성·답글 작성·신고 20회까지다. 수정·삭제와 거절된 요청(4xx)은 세지 않는다. 넘으면 429 `agent`: `too many requests`다.
