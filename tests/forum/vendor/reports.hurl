# Setup
POST {{host}}/api/users
{
  "user": { "username": "rpta_{{uid}}", "email": "rpta_{{uid}}@test.com", "password": "password123" }
}
HTTP 201
[Captures]
token_a: jsonpath "$.user.token"

POST {{host}}/api/users
{
  "user": { "username": "rptb_{{uid}}", "email": "rptb_{{uid}}@test.com", "password": "password123" }
}
HTTP 201
[Captures]
token_b: jsonpath "$.user.token"

POST {{host}}/api/topics
Authorization: Token {{token_a}}
{
  "topic": { "title": "신고 시험 {{uid}}", "body": "본문" }
}
HTTP 201
[Captures]
topic_id: jsonpath "$.topic.id"

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{token_a}}
{
  "reply": { "body": "신고될 답글" }
}
HTTP 201
[Captures]
reply_id: jsonpath "$.reply.id"

# 토론 신고
POST {{host}}/api/topics/{{topic_id}}/report
Authorization: Token {{token_b}}
{
  "report": { "reason": "책과 관계없는 광고" }
}
HTTP 201
[Captures]
report_id: jsonpath "$.report.id"
[Asserts]
jsonpath "$.report.id" isInteger
jsonpath "$.report.targetType" == "topic"
jsonpath "$.report.targetId" == {{topic_id}}
jsonpath "$.report.reason" == "책과 관계없는 광고"
jsonpath "$.report.createdAt" matches "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}"

# 같은 대상을 다시 신고하면 기존 신고
POST {{host}}/api/topics/{{topic_id}}/report
Authorization: Token {{token_b}}
{
  "report": { "reason": "다시 신고" }
}
HTTP 200
[Asserts]
jsonpath "$.report.id" == {{report_id}}

# 답글 신고
POST {{host}}/api/replies/{{reply_id}}/report
Authorization: Token {{token_b}}
{
  "report": { "reason": "욕설" }
}
HTTP 201
[Asserts]
jsonpath "$.report.targetType" == "reply"
jsonpath "$.report.targetId" == {{reply_id}}

# 사유 필수
POST {{host}}/api/replies/{{reply_id}}/report
Authorization: Token {{token_a}}
{
  "report": { "reason": "" }
}
HTTP 422
[Asserts]
jsonpath "$.errors.reason[0]" == "can't be blank"

# 사유 500자 초과
POST {{host}}/api/replies/{{reply_id}}/report
Authorization: Token {{token_a}}
{
  "report": { "reason": "가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가" }
}
HTTP 422
[Asserts]
jsonpath "$.errors.reason[0]" == "is too long (maximum is 500 characters)"

# 인증 필요
POST {{host}}/api/topics/{{topic_id}}/report
{
  "report": { "reason": "익명" }
}
HTTP 401

# 없는 대상
POST {{host}}/api/topics/999999999/report
Authorization: Token {{token_b}}
{
  "report": { "reason": "없음" }
}
HTTP 404
[Asserts]
jsonpath "$.errors.topic[0]" == "not found"
