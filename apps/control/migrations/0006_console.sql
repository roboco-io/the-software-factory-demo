-- Control console: run title, merge tier and head commit, and per-call model usage.
-- Existing rows keep NULL in the new columns.

ALTER TABLE runs ADD COLUMN title TEXT;
ALTER TABLE runs ADD COLUMN tier TEXT;
ALTER TABLE runs ADD COLUMN head_sha TEXT;

CREATE TABLE run_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs (id),
  phase TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX run_usage_by_run ON run_usage (run_id);
