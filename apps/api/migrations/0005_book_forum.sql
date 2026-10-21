CREATE TABLE book_documents (
  doc_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE book_sections (
  doc_id TEXT NOT NULL REFERENCES book_documents(doc_id) ON DELETE CASCADE,
  anchor TEXT NOT NULL,
  heading TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (doc_id, anchor)
);
CREATE TABLE book_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  synced_at TEXT NOT NULL
);
CREATE TABLE topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general',
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id TEXT,
  anchor TEXT,
  doc_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);
CREATE INDEX topics_doc_idx ON topics (doc_id, anchor);
CREATE INDEX topics_author_idx ON topics (author_id);
CREATE INDEX topics_activity_idx ON topics (last_activity_at, id);
