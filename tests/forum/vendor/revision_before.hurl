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

# p01 s01: v2에서도 그대로다
POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": { "title": "그대로인 절 {{uid}}", "body": "본문", "docId": "p01", "anchor": "s01" }
}
HTTP 201
[Asserts]
jsonpath "$.topic.book.revision" == 2
jsonpath "$.topic.book.status" == "current"
