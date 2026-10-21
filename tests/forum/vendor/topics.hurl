# Setup: Register
POST {{host}}/api/users
{
  "user": {
    "username": "top_{{uid}}",
    "email": "top_{{uid}}@test.com",
    "password": "password123"
  }
}
HTTP 201
[Captures]
token: jsonpath "$.user.token"

# 절에 연결한 토론
POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": {
    "title": "읽는 순서에 대한 반론 {{uid}}",
    "body": "책의 **주장**에 대한 반론",
    "kind": "argument",
    "docId": "preface",
    "anchor": "s01"
  }
}
HTTP 201
[Captures]
topic_id: jsonpath "$.topic.id"
[Asserts]
jsonpath "$.topic.id" isInteger
jsonpath "$.topic.title" == "읽는 순서에 대한 반론 {{uid}}"
jsonpath "$.topic.body" == "책의 **주장**에 대한 반론"
jsonpath "$.topic.kind" == "argument"
jsonpath "$.topic.author.username" == "top_{{uid}}"
jsonpath "$.topic.book.docId" == "preface"
jsonpath "$.topic.book.anchor" == "s01"
jsonpath "$.topic.book.revision" == 3
jsonpath "$.topic.book.status" == "current"
jsonpath "$.topic.replyCount" == 0
jsonpath "$.topic.createdAt" matches "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}"
jsonpath "$.topic.updatedAt" matches "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}"
jsonpath "$.topic.lastActivityAt" matches "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}"

# 장 전체 토론(앵커 없음)
POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": {
    "title": "2장 전체에 대한 사례 {{uid}}",
    "body": "사례",
    "kind": "case",
    "docId": "ch02"
  }
}
HTTP 201
[Asserts]
jsonpath "$.topic.book.docId" == "ch02"
jsonpath "$.topic.book.anchor" == null
jsonpath "$.topic.book.revision" == 5

# 책과 연결하지 않은 토론, kind 생략
POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": {
    "title": "일반 토론 {{uid}}",
    "body": "자유 주제"
  }
}
HTTP 201
[Captures]
general_id: jsonpath "$.topic.id"
[Asserts]
jsonpath "$.topic.kind" == "general"
jsonpath "$.topic.book" == null

# 읽기는 인증 없이
GET {{host}}/api/topics/{{topic_id}}
HTTP 200
[Asserts]
jsonpath "$.topic.id" == {{topic_id}}
jsonpath "$.topic.book.status" == "current"

# 목록 필터: 작성자
GET {{host}}/api/topics?author=top_{{uid}}
HTTP 200
[Asserts]
jsonpath "$.topicsCount" == 3
jsonpath "$.topics" count == 3

# 목록 필터: 작성자 + 종류
GET {{host}}/api/topics?author=top_{{uid}}&kind=case
HTTP 200
[Asserts]
jsonpath "$.topicsCount" == 1
jsonpath "$.topics[0].kind" == "case"

# 목록 필터: 문서 + 절
GET {{host}}/api/topics?docId=preface&anchor=s01&author=top_{{uid}}
HTTP 200
[Asserts]
jsonpath "$.topicsCount" == 1
jsonpath "$.topics[0].id" == {{topic_id}}

# 목록 필터: 문서(절 무관)
GET {{host}}/api/topics?docId=ch02&author=top_{{uid}}
HTTP 200
[Asserts]
jsonpath "$.topicsCount" == 1
jsonpath "$.topics[0].book.docId" == "ch02"

# 페이지
GET {{host}}/api/topics?author=top_{{uid}}&limit=2&offset=2
HTTP 200
[Asserts]
jsonpath "$.topicsCount" == 3
jsonpath "$.topics" count == 1

# 수정: 책 연결은 그대로
PUT {{host}}/api/topics/{{topic_id}}
Authorization: Token {{token}}
{
  "topic": {
    "title": "고친 제목 {{uid}}",
    "kind": "question"
  }
}
HTTP 200
[Asserts]
jsonpath "$.topic.title" == "고친 제목 {{uid}}"
jsonpath "$.topic.body" == "책의 **주장**에 대한 반론"
jsonpath "$.topic.kind" == "question"
jsonpath "$.topic.book.docId" == "preface"
jsonpath "$.topic.book.anchor" == "s01"

# 삭제
DELETE {{host}}/api/topics/{{general_id}}
Authorization: Token {{token}}
HTTP 204

GET {{host}}/api/topics/{{general_id}}
HTTP 404
[Asserts]
jsonpath "$.errors.topic[0]" == "not found"
