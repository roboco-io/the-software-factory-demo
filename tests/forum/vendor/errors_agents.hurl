# 에이전트 오류와 제한
POST {{host}}/api/users
{
  "user": { "username": "aga_{{uid}}", "email": "aga_{{uid}}@test.com", "password": "password123" }
}
HTTP 201
[Captures]
owner: jsonpath "$.user.token"

POST {{host}}/api/users
{
  "user": { "username": "agb_{{uid}}", "email": "agb_{{uid}}@test.com", "password": "password123" }
}
HTTP 201
[Captures]
stranger: jsonpath "$.user.token"

# 인증 필요
POST {{host}}/api/agents
{
  "agent": { "name": "anon-{{uid}}" }
}
HTTP 401

# 이름 검증
POST {{host}}/api/agents
Authorization: Token {{owner}}
{
  "agent": { "name": "" }
}
HTTP 422
[Asserts]
jsonpath "$.errors.name[0]" == "can't be blank"

POST {{host}}/api/agents
Authorization: Token {{owner}}
{
  "agent": { "name": "Has Space" }
}
HTTP 422
[Asserts]
jsonpath "$.errors.name[0]" == "is invalid"

POST {{host}}/api/agents
Authorization: Token {{owner}}
{
  "agent": { "name": "ab" }
}
HTTP 422
[Asserts]
jsonpath "$.errors.name[0]" == "is invalid"

# 사람 사용자 이름과 겹치면 안 된다(에이전트 이름 규칙에 맞는 사람 이름으로 시험)
POST {{host}}/api/users
{
  "user": { "username": "agc{{uid}}", "email": "agc_{{uid}}@test.com", "password": "password123" }
}
HTTP 201

POST {{host}}/api/agents
Authorization: Token {{owner}}
{
  "agent": { "name": "agc{{uid}}" }
}
HTTP 409
[Asserts]
jsonpath "$.errors.name[0]" == "has already been taken"

POST {{host}}/api/agents
Authorization: Token {{owner}}
{
  "agent": { "name": "limited-{{uid}}" }
}
HTTP 201
[Captures]
agent: jsonpath "$.agent.token"

# 같은 이름으로 다시 등록할 수 없다
POST {{host}}/api/agents
Authorization: Token {{owner}}
{
  "agent": { "name": "limited-{{uid}}" }
}
HTTP 409
[Asserts]
jsonpath "$.errors.name[0]" == "has already been taken"

# 사람이 에이전트 이름으로 가입할 수 없다
POST {{host}}/api/users
{
  "user": { "username": "limited-{{uid}}", "email": "dup_{{uid}}@test.com", "password": "password123" }
}
HTTP 409
[Asserts]
jsonpath "$.errors.username[0]" == "has already been taken"

# 에이전트는 계정 정보를 바꿀 수 없다(비밀번호를 정해 로그인하면 토큰 폐기를 우회할 수 있다)
PUT {{host}}/api/user
Authorization: Token {{agent}}
{
  "user": { "password": "password123" }
}
HTTP 403
[Asserts]
jsonpath "$.errors.agent[0]" == "forbidden"

# 에이전트는 RealWorld 쓰기 경로를 쓸 수 없다
POST {{host}}/api/articles
Authorization: Token {{agent}}
{
  "article": { "title": "에이전트 글", "description": "d", "body": "b" }
}
HTTP 403
[Asserts]
jsonpath "$.errors.agent[0]" == "forbidden"

# 에이전트는 다른 에이전트를 등록할 수 없다
POST {{host}}/api/agents
Authorization: Token {{agent}}
{
  "agent": { "name": "child-{{uid}}" }
}
HTTP 403
[Asserts]
jsonpath "$.errors.agent[0]" == "forbidden"

# 남의 에이전트는 폐기할 수 없다
DELETE {{host}}/api/agents/limited-{{uid}}
Authorization: Token {{stranger}}
HTTP 403
[Asserts]
jsonpath "$.errors.agent[0]" == "forbidden"

DELETE {{host}}/api/agents/none-{{uid}}
Authorization: Token {{owner}}
HTTP 404
[Asserts]
jsonpath "$.errors.agent[0]" == "not found"

# 에이전트는 추천할 수 없다
POST {{host}}/api/topics
Authorization: Token {{owner}}
{
  "topic": { "title": "제한 시험 {{uid}}", "body": "본문" }
}
HTTP 201
[Captures]
topic_id: jsonpath "$.topic.id"

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{owner}}
{
  "reply": { "body": "사람의 답글" }
}
HTTP 201
[Captures]
reply_id: jsonpath "$.reply.id"

POST {{host}}/api/replies/{{reply_id}}/vote
Authorization: Token {{agent}}
HTTP 403
[Asserts]
jsonpath "$.errors.agent[0]" == "forbidden"

# 쓰기 빈도 제한: 10분에 20회. 20회까지는 된다.

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 1" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 2" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 3" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 4" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 5" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 6" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 7" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 8" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 9" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 10" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 11" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 12" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 13" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 14" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 15" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 16" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 17" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 18" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 19" }
}
HTTP 201

POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 20" }
}
HTTP 201

# 21번째는 거절된다
POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트 쓰기 21" }
}
HTTP 429
[Asserts]
jsonpath "$.errors.agent[0]" == "too many requests"

# 사람은 제한을 받지 않는다
POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{owner}}
{
  "reply": { "body": "사람은 계속 쓸 수 있다" }
}
HTTP 201
