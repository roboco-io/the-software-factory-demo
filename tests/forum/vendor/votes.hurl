# Setup: 작성자 A, 추천자 B·C
POST {{host}}/api/users
{
  "user": { "username": "vta_{{uid}}", "email": "vta_{{uid}}@test.com", "password": "password123" }
}
HTTP 201
[Captures]
token_a: jsonpath "$.user.token"

POST {{host}}/api/users
{
  "user": { "username": "vtb_{{uid}}", "email": "vtb_{{uid}}@test.com", "password": "password123" }
}
HTTP 201
[Captures]
token_b: jsonpath "$.user.token"

POST {{host}}/api/users
{
  "user": { "username": "vtc_{{uid}}", "email": "vtc_{{uid}}@test.com", "password": "password123" }
}
HTTP 201
[Captures]
token_c: jsonpath "$.user.token"

POST {{host}}/api/topics
Authorization: Token {{token_a}}
{
  "topic": { "title": "추천 시험 {{uid}}", "body": "본문" }
}
HTTP 201
[Captures]
topic_id: jsonpath "$.topic.id"

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{token_a}}
{
  "reply": { "body": "먼저 쓴 답글" }
}
HTTP 201
[Captures]
early_id: jsonpath "$.reply.id"

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{token_a}}
{
  "reply": { "body": "나중에 쓴 답글" }
}
HTTP 201
[Captures]
late_id: jsonpath "$.reply.id"

# 추천
POST {{host}}/api/replies/{{late_id}}/vote
Authorization: Token {{token_b}}
HTTP 200
[Asserts]
jsonpath "$.reply.id" == {{late_id}}
jsonpath "$.reply.score" == 1
jsonpath "$.reply.voted" == true

# 같은 사람이 다시 추천해도 점수는 그대로
POST {{host}}/api/replies/{{late_id}}/vote
Authorization: Token {{token_b}}
HTTP 200
[Asserts]
jsonpath "$.reply.score" == 1

POST {{host}}/api/replies/{{late_id}}/vote
Authorization: Token {{token_c}}
HTTP 200
[Asserts]
jsonpath "$.reply.score" == 2

POST {{host}}/api/replies/{{early_id}}/vote
Authorization: Token {{token_c}}
HTTP 200
[Asserts]
jsonpath "$.reply.score" == 1

# 추천순 정렬
GET {{host}}/api/topics/{{topic_id}}/replies?sort=top
Authorization: Token {{token_b}}
HTTP 200
[Asserts]
jsonpath "$.replies[0].id" == {{late_id}}
jsonpath "$.replies[0].score" == 2
jsonpath "$.replies[0].voted" == true
jsonpath "$.replies[1].id" == {{early_id}}
jsonpath "$.replies[1].voted" == false

# 인증 없이 읽으면 voted는 false
GET {{host}}/api/topics/{{topic_id}}/replies?sort=top
HTTP 200
[Asserts]
jsonpath "$.replies[0].voted" == false

# 추천 취소(반복해도 같은 결과)
DELETE {{host}}/api/replies/{{late_id}}/vote
Authorization: Token {{token_b}}
HTTP 200
[Asserts]
jsonpath "$.reply.score" == 1
jsonpath "$.reply.voted" == false

DELETE {{host}}/api/replies/{{late_id}}/vote
Authorization: Token {{token_b}}
HTTP 200
[Asserts]
jsonpath "$.reply.score" == 1

DELETE {{host}}/api/replies/{{late_id}}/vote
Authorization: Token {{token_c}}
HTTP 200
[Asserts]
jsonpath "$.reply.score" == 0

# 점수가 같으면 작성순
GET {{host}}/api/topics/{{topic_id}}/replies?sort=top
HTTP 200
[Asserts]
jsonpath "$.replies[0].id" == {{early_id}}
jsonpath "$.replies[1].id" == {{late_id}}

# 자기 답글은 추천할 수 없다
POST {{host}}/api/replies/{{early_id}}/vote
Authorization: Token {{token_a}}
HTTP 422
[Asserts]
jsonpath "$.errors.reply[0]" == "is invalid"

# 인증 필요
POST {{host}}/api/replies/{{early_id}}/vote
HTTP 401

# 없는 답글
POST {{host}}/api/replies/999999999/vote
Authorization: Token {{token_b}}
HTTP 404
[Asserts]
jsonpath "$.errors.reply[0]" == "not found"
