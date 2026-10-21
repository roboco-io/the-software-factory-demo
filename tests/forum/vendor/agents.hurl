# 사람이 에이전트를 등록하고, 에이전트가 토론·답글을 쓰고, 등록자가 토큰을 폐기한다.
POST {{host}}/api/users
{
  "user": { "username": "agh_{{uid}}", "email": "agh_{{uid}}@test.com", "password": "password123" }
}
HTTP 201
[Captures]
human: jsonpath "$.user.token"

POST {{host}}/api/agents
Authorization: Token {{human}}
{
  "agent": { "name": "reader-{{uid}}" }
}
HTTP 201
[Captures]
agent: jsonpath "$.agent.token"
[Asserts]
jsonpath "$.agent.name" == "reader-{{uid}}"
jsonpath "$.agent.owner" == "agh_{{uid}}"
jsonpath "$.agent.revoked" == false
jsonpath "$.agent.token" startsWith "sfa_"
jsonpath "$.agent.createdAt" matches "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}"

# 목록에는 토큰이 없다
GET {{host}}/api/agents
Authorization: Token {{human}}
HTTP 200
[Asserts]
jsonpath "$.agents" count == 1
jsonpath "$.agents[0].name" == "reader-{{uid}}"
jsonpath "$.agents[0].owner" == "agh_{{uid}}"
jsonpath "$.agents[0].token" not exists

# 사람의 글에는 human
POST {{host}}/api/topics
Authorization: Token {{human}}
{
  "topic": { "title": "사람의 토론 {{uid}}", "body": "본문" }
}
HTTP 201
[Captures]
topic_id: jsonpath "$.topic.id"
[Asserts]
jsonpath "$.topic.author.username" == "agh_{{uid}}"
jsonpath "$.topic.author.kind" == "human"
jsonpath "$.topic.author.owner" == null

# 에이전트의 답글에는 agent와 등록자
POST {{host}}/api/topics/{{topic_id}}/replies
Authorization: Token {{agent}}
{
  "reply": { "body": "에이전트의 요약 답글" }
}
HTTP 201
[Captures]
agent_reply: jsonpath "$.reply.id"
[Asserts]
jsonpath "$.reply.author.username" == "reader-{{uid}}"
jsonpath "$.reply.author.kind" == "agent"
jsonpath "$.reply.author.owner" == "agh_{{uid}}"

# 에이전트의 토론
POST {{host}}/api/topics
Authorization: Token {{agent}}
{
  "topic": { "title": "에이전트의 토론 {{uid}}", "body": "출처: 1장", "kind": "case" }
}
HTTP 201
[Captures]
agent_topic: jsonpath "$.topic.id"
[Asserts]
jsonpath "$.topic.author.kind" == "agent"
jsonpath "$.topic.author.owner" == "agh_{{uid}}"

# 목록과 단건 조회에도 같은 표시
GET {{host}}/api/topics/{{agent_topic}}
HTTP 200
[Asserts]
jsonpath "$.topic.author.kind" == "agent"

GET {{host}}/api/topics/{{topic_id}}/replies
HTTP 200
[Asserts]
jsonpath "$.replies[0].author.kind" == "agent"
jsonpath "$.replies[0].author.owner" == "agh_{{uid}}"

# 에이전트는 자기 글을 고칠 수 있다
PUT {{host}}/api/replies/{{agent_reply}}
Authorization: Token {{agent}}
{
  "reply": { "body": "고친 요약" }
}
HTTP 200
[Asserts]
jsonpath "$.reply.body" == "고친 요약"

# 사람은 에이전트의 답글을 추천할 수 있다
POST {{host}}/api/replies/{{agent_reply}}/vote
Authorization: Token {{human}}
HTTP 200
[Asserts]
jsonpath "$.reply.score" == 1

# 폐기
DELETE {{host}}/api/agents/reader-{{uid}}
Authorization: Token {{human}}
HTTP 204

GET {{host}}/api/agents
Authorization: Token {{human}}
HTTP 200
[Asserts]
jsonpath "$.agents[0].revoked" == true

POST {{host}}/api/topics
Authorization: Token {{agent}}
{
  "topic": { "title": "폐기 후", "body": "본문" }
}
HTTP 401
[Asserts]
jsonpath "$.errors.token[0]" == "is invalid"

# 이미 쓴 글은 남는다
GET {{host}}/api/topics/{{agent_topic}}
HTTP 200
[Asserts]
jsonpath "$.topic.author.username" == "reader-{{uid}}"
