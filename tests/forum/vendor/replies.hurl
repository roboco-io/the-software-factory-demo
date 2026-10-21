# Setup: 두 사용자
POST {{host}}/api/users
{
  "user": { "username": "rpa_{{uid}}", "email": "rpa_{{uid}}@test.com", "password": "password123" }
}
HTTP 201
[Captures]
token_a: jsonpath "$.user.token"

POST {{host}}/api/users
{
  "user": { "username": "rpb_{{uid}}", "email": "rpb_{{uid}}@test.com", "password": "password123" }
}
HTTP 201
[Captures]
token_b: jsonpath "$.user.token"

POST {{host}}/api/topics
Authorization: Token {{token_a}}
{
  "topic": { "title": "답글 시험 {{uid}}", "body": "본문" }
}
HTTP 201
[Captures]
topic_id: jsonpath "$.topic.id"

# 최상위 답글
POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{token_b}}
{
  "reply": { "body": "첫 답글" }
}
HTTP 201
[Captures]
root_id: jsonpath "$.reply.id"
[Asserts]
jsonpath "$.reply.id" isInteger
jsonpath "$.reply.topicId" == {{topic_id}}
jsonpath "$.reply.parentId" == null
jsonpath "$.reply.body" == "첫 답글"
jsonpath "$.reply.author.username" == "rpb_{{uid}}"
jsonpath "$.reply.score" == 0
jsonpath "$.reply.voted" == false
jsonpath "$.reply.deleted" == false
jsonpath "$.reply.createdAt" matches "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}"

# 답글에 답글
POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{token_a}}
{
  "reply": { "body": "답글의 답글", "parentId": {{root_id}} }
}
HTTP 201
[Captures]
child_id: jsonpath "$.reply.id"
[Asserts]
jsonpath "$.reply.parentId" == {{root_id}}

# 답글의 답글의 답글(깊이 제한 없음)
POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{token_b}}
{
  "reply": { "body": "세 번째 깊이", "parentId": {{child_id}} }
}
HTTP 201
[Captures]
grandchild_id: jsonpath "$.reply.id"

# 하위 답글이 없는 두 번째 최상위 답글
POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{token_a}}
{
  "reply": { "body": "두 번째 답글" }
}
HTTP 201
[Captures]
leaf_id: jsonpath "$.reply.id"

# 평면 목록, 기본은 작성순
GET {{host}}/api/topics/{{topic_id}}/replies
HTTP 200
[Asserts]
jsonpath "$.replies" count == 4
jsonpath "$.replies[0].id" == {{root_id}}
jsonpath "$.replies[1].id" == {{child_id}}
jsonpath "$.replies[1].parentId" == {{root_id}}
jsonpath "$.replies[2].id" == {{grandchild_id}}
jsonpath "$.replies[2].parentId" == {{child_id}}
jsonpath "$.replies[3].id" == {{leaf_id}}

GET {{host}}/api/topics/{{topic_id}}
HTTP 200
[Asserts]
jsonpath "$.topic.replyCount" == 4

# 수정
PUT {{host}}/api/replies/{{leaf_id}}
Authorization: Token {{token_a}}
{
  "reply": { "body": "고친 답글" }
}
HTTP 200
[Asserts]
jsonpath "$.reply.body" == "고친 답글"

# 하위 답글이 있는 답글을 지우면 자리만 남는다
DELETE {{host}}/api/replies/{{child_id}}
Authorization: Token {{token_a}}
HTTP 204

# 하위 답글이 없는 답글은 사라진다
DELETE {{host}}/api/replies/{{leaf_id}}
Authorization: Token {{token_a}}
HTTP 204

GET {{host}}/api/topics/{{topic_id}}/replies?sort=old
HTTP 200
[Asserts]
jsonpath "$.replies" count == 3
jsonpath "$.replies[1].id" == {{child_id}}
jsonpath "$.replies[1].deleted" == true
jsonpath "$.replies[1].body" == ""
jsonpath "$.replies[2].id" == {{grandchild_id}}
jsonpath "$.replies[2].parentId" == {{child_id}}

# 토론을 지우면 답글도 사라진다
DELETE {{host}}/api/topics/{{topic_id}}
Authorization: Token {{token_a}}
HTTP 204

GET {{host}}/api/topics/{{topic_id}}/replies
HTTP 404
[Asserts]
jsonpath "$.errors.topic[0]" == "not found"
