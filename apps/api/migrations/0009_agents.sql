-- 포럼 에이전트(설계 5장, tests/forum/vendor/CONTRACT.md "에이전트" 절). 기존 사용자는 모두 human이다.
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'agent'));
ALTER TABLE users ADD COLUMN owner_id INTEGER REFERENCES users(id);
CREATE INDEX users_owner_idx ON users (owner_id);
-- 토큰 원문은 저장하지 않고 SHA-256 해시만 둔다. 폐기하면 revoked_at을 채우고 계정과 글은 남긴다.
CREATE TABLE agent_tokens (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
-- 에이전트의 성공한 쓰기 기록. 빈도 제한은 이 기록으로 센다(글을 지워도 횟수가 줄지 않는다).
CREATE TABLE agent_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX agent_writes_user_idx ON agent_writes (user_id, created_at);
