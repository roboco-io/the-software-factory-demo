-- Adds the reason code merged_outside_factory: a person merged the pull request while the
-- factory was still working on it. SQLite cannot change a CHECK constraint, so the events
-- table is rebuilt. Rows and event ids are kept. Runs that already ended with pr_closed are
-- not rewritten, because events are an append-only record.

DROP TRIGGER events_no_update;
DROP TRIGGER events_no_delete;

CREATE TABLE events_old AS SELECT * FROM events;
DROP TABLE events;

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs (id),
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'transition', 'cleanup')),
  from_state TEXT,
  to_state TEXT,
  reason_code TEXT CHECK (reason_code IN (
    'empty_change', 'too_many_files', 'total_too_large', 'file_too_large', 'forbidden_path',
    'absolute_path', 'path_traversal', 'symlink', 'submodule', 'special_file', 'path_not_utf8',
    'path_control_char', 'malformed_output', 'timeout', 'agent_failed', 'agent_timeout',
    'sandbox_lost', 'clone_failed', 'publish_failed', 'internal_error', 'cleanup_failed',
    'legacy_run', 'pr_closed', 'merged_outside_factory', 'base_not_default', 'head_changed',
    'policy_missing', 'policy_invalid', 'files_truncated', 'diff_too_large', 'review_failed',
    'review_invalid', 'changes_requested', 'check_failed', 'checks_timeout',
    'checks_permission_missing', 'operator_changes_requested', 'approval_timeout',
    'merge_refused', 'merge_conflict'
  ))
);

INSERT INTO events (id, run_id, ts, kind, from_state, to_state, reason_code)
  SELECT id, run_id, ts, kind, from_state, to_state, reason_code FROM events_old;
DROP TABLE events_old;

CREATE INDEX events_by_run ON events (run_id, id);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
