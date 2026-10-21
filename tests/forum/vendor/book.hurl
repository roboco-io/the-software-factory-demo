# 책 목차: fixtures/book-v1로 동기화한 상태
GET {{host}}/api/book
HTTP 200
[Asserts]
jsonpath "$.documents" count == 4
jsonpath "$.documents[0].docId" == "preface"
jsonpath "$.documents[0].kind" == "preface"
jsonpath "$.documents[0].title" == "머리말"
jsonpath "$.documents[0].revision" == 3
jsonpath "$.documents[1].docId" == "ch01"
jsonpath "$.documents[1].kind" == "chapter"
jsonpath "$.documents[1].title" == "1장 시험용 첫 장"
jsonpath "$.documents[1].revision" == 11
jsonpath "$.documents[1].topicCount" isInteger
jsonpath "$.documents[2].docId" == "ch02"
jsonpath "$.documents[3].docId" == "p01"
jsonpath "$.documents[3].kind" == "pattern"
jsonpath "$.documents[3].title" == "P01 시험용 패턴"
jsonpath "$.syncedAt" matches "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}"

# 절: 현재 원고의 제목만, 원고 순서대로. 매니페스트에 없는 제목은 빠진다
GET {{host}}/api/book/ch01
HTTP 200
[Asserts]
jsonpath "$.document.docId" == "ch01"
jsonpath "$.document.title" == "1장 시험용 첫 장"
jsonpath "$.document.revision" == 11
jsonpath "$.document.sections" count == 2
jsonpath "$.document.sections[0].anchor" == "s01"
jsonpath "$.document.sections[0].heading" == "고객의 문제를 기준으로 삼는다"
jsonpath "$.document.sections[1].anchor" == "s02"
jsonpath "$.document.sections[1].heading" == "출처와 검토"
jsonpath "$.document.sections[0].topicCount" isInteger

# 없는 문서
GET {{host}}/api/book/ch99
HTTP 404
[Asserts]
jsonpath "$.errors.document[0]" == "not found"

# Setup: Register
POST {{host}}/api/users
{
  "user": {
    "username": "book_{{uid}}",
    "email": "book_{{uid}}@test.com",
    "password": "password123"
  }
}
HTTP 201
[Captures]
token: jsonpath "$.user.token"

# 절에 토론을 열면 절과 문서의 토론 수가 늘어난다(p01 s02는 이 파일만 쓴다)
POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": {
    "title": "해법 절에 대한 질문 {{uid}}",
    "body": "본문",
    "kind": "question",
    "docId": "p01",
    "anchor": "s02"
  }
}
HTTP 201

GET {{host}}/api/book/p01
HTTP 200
[Asserts]
jsonpath "$.document.sections[1].anchor" == "s02"
jsonpath "$.document.sections[1].topicCount" == 1
jsonpath "$.document.topicCount" >= 1
