CREATE TABLE reply_votes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reply_id INTEGER NOT NULL REFERENCES replies(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, reply_id)
);
CREATE INDEX reply_votes_reply_idx ON reply_votes (reply_id);
