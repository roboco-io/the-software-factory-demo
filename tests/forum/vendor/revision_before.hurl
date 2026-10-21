# fixtures/book-v1 상태에서 토론을 연다. revision_after.hurl이 book-v2 동기화 뒤 상태를 확인한다.
POST {{host}}/api/users
{
  "user": { "username": "rev_{{uid}}", "email": "rev_{{uid}}@test.com", "password": "password123" }
}
HTTP 201
[Captures]
token: jsonpath "$.user.token"

# ch01 s01: v2에서 장이 개정된다
POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": { "title": "개정될 절 {{uid}}", "body": "본문", "docId": "ch01", "anchor": "s01" }
}
HTTP 201
[Asserts]
jsonpath "$.topic.book.revision" == 11
jsonpath "$.topic.book.status" == "current"

# ch01 s02: v2에서 장 revision은 오르지만 이 절 본문은 그대로다
POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": { "title": "본문이 그대로인 절 {{uid}}", "body": "본문", "docId": "ch01", "anchor": "s02" }
}
HTTP 201
[Asserts]
jsonpath "$.topic.book.status" == "current"

# ch01 장 전체: 장 revision이 오르면 개정으로 본다
POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": { "title": "1장 전체 {{uid}}", "body": "본문", "docId": "ch01" }
}
HTTP 201
[Asserts]
jsonpath "$.topic.book.anchor" == null
jsonpath "$.topic.book.status" == "current"

# ch02 s02: v2에서 절이 사라진다
POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": { "title": "사라질 절 {{uid}}", "body": "본문", "docId": "ch02", "anchor": "s02" }
}
HTTP 201
[Asserts]
jsonpath "$.topic.book.revision" == 5
jsonpath "$.topic.book.status" == "current"

# patterns p01: v2에서도 그대로다
POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": { "title": "그대로인 패턴 {{uid}}", "body": "본문", "docId": "patterns", "anchor": "p01" }
}
HTTP 201
[Asserts]
jsonpath "$.topic.book.revision" == 4
jsonpath "$.topic.book.status" == "current"

# patterns p02: v2에서 이 패턴 본문이 바뀐다
POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": { "title": "개정될 패턴 {{uid}}", "body": "본문", "docId": "patterns", "anchor": "p02" }
}
HTTP 201
[Asserts]
jsonpath "$.topic.book.status" == "current"

# patterns 전체: 어느 패턴이든 revision이 오르면 개정으로 본다
POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": { "title": "패턴 전체 {{uid}}", "body": "본문", "docId": "patterns" }
}
HTTP 201
[Asserts]
jsonpath "$.topic.book.anchor" == null
jsonpath "$.topic.book.status" == "current"
