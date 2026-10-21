# 프로덕션 읽기 전용 스모크(spec 7.1.3). 데이터를 만들거나 바꾸는 요청을 넣지 않는다.
# 실행: hurl --test --variable "api=https://sfd-api.roboco.workers.dev/api" tests/smoke/readonly.hurl
# 포럼 전환(설계 6.3절): RealWorld 경로(/articles, /tags)는 제거 전에 이 검사에서 먼저 뺐다.
# 토론이 0건이거나 책 동기화 전이어도 통과하도록 응답 형식만 검사한다.
GET {{api}}/health
HTTP 200
[Asserts]
jsonpath "$.status" == "ok"

GET {{api}}/book
HTTP 200
[Asserts]
jsonpath "$.documents" isCollection

GET {{api}}/topics?limit=1
HTTP 200
[Asserts]
jsonpath "$.topicsCount" isInteger
jsonpath "$.topics" isCollection
