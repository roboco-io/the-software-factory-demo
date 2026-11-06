-- Stage 3: review and merge. Adds the states reviewing, awaiting_checks, awaiting_approval,
-- merged and needs_human, and their reason codes. SQLite cannot change a CHECK constraint,
-- so both tables are rebuilt. Rows and event ids are kept.
--
-- pr_opened used to be the final state. It is now a step before review, so every run
-- already in pr_opened becomes needs_human with the code legacy_run: its pull request was
-- opened before reviews existed and a person has to look at it. Without this those rows
-- would count as active forever.
--
-- Active means not merged, needs_human or failed. Capacity counts the active runs that
-- hold a sandbox or are about to; a run in awaiting_approval does not hold a slot.

DROP TRIGGER events_no_update;
DROP TRIGGER events_no_delete;

CREATE TABLE events_old AS SELECT * FROM events;
DROP TABLE events;

CREATE TABLE runs_new (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'cloning', 'implementing', 'publishing', 'pr_opened', 'reviewing', 'awaiting_checks', 'awaiting_approval', 'merged', 'needs_human', 'failed')),
  reason_code TEXT,
  pr_number INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO runs_new (id, repo, issue_number, state, reason_code, pr_number, created_at, updated_at)
  SELECT id, repo, issue_number,
         CASE WHEN state = 'pr_opened' THEN 'needs_human' ELSE state END,
         CASE WHEN state = 'pr_opened' THEN 'legacy_run' ELSE reason_code END,
         pr_number, created_at, updated_at
  FROM runs;

DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

-- One active run per issue, until it reaches a terminal state.
CREATE UNIQUE INDEX runs_one_active_per_issue
  ON runs (repo, issue_number)
  WHERE state NOT IN ('merged', 'needs_human', 'failed');

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
    'legacy_run', 'pr_closed', 'base_not_default', 'head_changed', 'policy_missing',
    'policy_invalid', 'files_truncated', 'diff_too_large', 'review_failed', 'review_invalid',
    'changes_requested', 'check_failed', 'checks_timeout', 'checks_permission_missing',
    'operator_changes_requested', 'approval_timeout', 'merge_refused', 'merge_conflict'
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
