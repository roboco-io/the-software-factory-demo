# Setup: Register
POST {{host}}/api/users
{
  "user": {
    "username": "srt_{{uid}}",
    "email": "srt_{{uid}}@test.com",
    "password": "password123"
  }
}
HTTP 201
[Captures]
token: jsonpath "$.user.token"

POST {{host}}/api/topics
Authorization: Token {{token}}
{
  "topic": { "title": "먼저 연 토론 {{uid}}", "body": "A" }
}
HTTP 201
[Captures]
first_id: jsonpath "$.topic.id"

POST {{host}}/api/topics
Authorization: Token {{token}}
[Options]
delay: 20
{
  "topic": { "title": "나중에 연 토론 {{uid}}", "body": "B" }
}
HTTP 201
[Captures]
second_id: jsonpath "$.topic.id"

# 답글이 없으면 최근 활동순도 생성 역순
GET {{host}}/api/topics?author=srt_{{uid}}
HTTP 200
[Asserts]
jsonpath "$.topics[0].id" == {{second_id}}
jsonpath "$.topics[1].id" == {{first_id}}

# 먼저 연 토론에 답글
POST {{host}}/api/topics/{{first_id}}/replies
Authorization: Token {{token}}
[Options]
delay: 20
{
  "reply": { "body": "활동" }
}
HTTP 201
[Captures]
reply_at: jsonpath "$.reply.createdAt"

GET {{host}}/api/topics/{{first_id}}
HTTP 200
[Asserts]
jsonpath "$.topic.replyCount" == 1
jsonpath "$.topic.lastActivityAt" == "{{reply_at}}"

# 기본 정렬은 최근 활동순
GET {{host}}/api/topics?author=srt_{{uid}}
HTTP 200
[Asserts]
jsonpath "$.topics[0].id" == {{first_id}}
jsonpath "$.topics[1].id" == {{second_id}}

GET {{host}}/api/topics?author=srt_{{uid}}&sort=activity
HTTP 200
[Asserts]
jsonpath "$.topics[0].id" == {{first_id}}

# 최신순은 생성 시각 기준
GET {{host}}/api/topics?author=srt_{{uid}}&sort=new
HTTP 200
[Asserts]
jsonpath "$.topics[0].id" == {{second_id}}
jsonpath "$.topics[1].id" == {{first_id}}
