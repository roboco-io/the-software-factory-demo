-- Runs and their append-only event log. Events hold only fixed codes: no agent
-- output, no issue text, no secrets.

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'cloning', 'implementing', 'publishing', 'pr_opened', 'failed')),
  reason_code TEXT,
  pr_number INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One active run per issue.
CREATE UNIQUE INDEX runs_one_active_per_issue
  ON runs (repo, issue_number)
  WHERE state NOT IN ('pr_opened', 'failed');

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs (id),
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'transition', 'cleanup')),
  from_state TEXT,
  to_state TEXT,
  reason_code TEXT CHECK (reason_code IN (
    'empty_change', 'too_many_files', 'total_too_large', 'file_too_large', 'forbidden_path',
    'absolute_path', 'path_traversal', 'symlink', 'submodule', 'special_file',
    'path_not_utf8', 'path_control_char', 'malformed_output', 'timeout', 'agent_failed',
    'agent_timeout', 'sandbox_lost', 'clone_failed', 'publish_failed', 'internal_error',
    'cleanup_failed'
  ))
);

CREATE INDEX events_by_run ON events (run_id, id);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
