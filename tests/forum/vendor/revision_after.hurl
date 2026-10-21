# fixtures/book-v2로 다시 동기화한 상태. revision_before.hurl이 연 토론을 확인한다.
GET {{host}}/api/book
HTTP 200
[Asserts]
jsonpath "$.documents" count == 5
jsonpath "$.documents[1].docId" == "ch01"
jsonpath "$.documents[1].revision" == 12
jsonpath "$.documents[4].docId" == "ch03"
jsonpath "$.documents[4].title" == "3장 새로 추가된 장"
jsonpath "$.documents[4].revision" == 1

# 사라진 절은 목록에서 빠진다
GET {{host}}/api/book/ch02
HTTP 200
[Asserts]
jsonpath "$.document.revision" == 6
jsonpath "$.document.sections" count == 2
jsonpath "$.document.sections[0].anchor" == "s01"
jsonpath "$.document.sections[1].anchor" == "s03"

# 본문이 바뀐 절의 토론
GET {{host}}/api/topics?author=rev_{{uid}}&docId=ch01&anchor=s01
HTTP 200
[Asserts]
jsonpath "$.topicsCount" == 1
jsonpath "$.topics[0].book.revision" == 11
jsonpath "$.topics[0].book.status" == "revised"

# 장 revision은 올랐지만 본문이 그대로인 절의 토론
GET {{host}}/api/topics?author=rev_{{uid}}&docId=ch01&anchor=s02
HTTP 200
[Asserts]
jsonpath "$.topicsCount" == 1
jsonpath "$.topics[0].book.status" == "current"

# 장 전체 토론은 장 revision으로 판정한다
GET {{host}}/api/topics?author=rev_{{uid}}&docId=ch01&sort=new
HTTP 200
[Asserts]
jsonpath "$.topicsCount" == 3
jsonpath "$.topics[0].book.anchor" == null
jsonpath "$.topics[0].book.status" == "revised"

# 사라진 절의 토론은 남아 있고 removed로 표시된다
GET {{host}}/api/topics?author=rev_{{uid}}&docId=ch02
HTTP 200
[Asserts]
jsonpath "$.topicsCount" == 1
jsonpath "$.topics[0].book.anchor" == "s02"
jsonpath "$.topics[0].book.status" == "removed"

# 그대로인 절
GET {{host}}/api/topics?author=rev_{{uid}}&docId=p01
HTTP 200
[Asserts]
jsonpath "$.topicsCount" == 1
jsonpath "$.topics[0].book.status" == "current"

# 사라진 절에는 새 토론을 열 수 없다
POST {{host}}/api/users
{
  "user": { "username": "rv2_{{uid}}", "email": "rv2_{{uid}}@test.com", "password": "password123" }
}
HTTP 201
[Captures]
token: jsonpath "$.user.token"

POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": { "title": "사라진 절", "body": "본문", "docId": "ch02", "anchor": "s02" }
}
HTTP 422
[Asserts]
jsonpath "$.errors.anchor[0]" == "is invalid"
