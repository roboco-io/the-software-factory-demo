-- 프로필 이미지 업로드. 테이블만 추가하며 기존 열·테이블은 건드리지 않는다.
CREATE TABLE images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX images_owner_idx ON images (owner_id);
