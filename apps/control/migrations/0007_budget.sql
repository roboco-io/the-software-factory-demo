-- Stage 5: budget and engine switching.
--
-- Adds the state awaiting_engine: the pull request waits for a reviewing engine with budget
-- left (T2 and T3 when only one engine is left, or any tier when none is). Adds the reason
-- codes budget_exceeded (the agent stopped after the run or the month hit its spending limit)
-- and engine_wait_timeout. Records the implementing and the reviewing model of each run, so
-- the control plane can reserve budget for active runs. Adds budget_alerts: the one factory
-- issue per billing period when both accounts reached their limit. Adds run_inflight: the model
-- calls of each run that are still in flight, so the egress can cap how many run at once.
--
-- SQLite cannot change a CHECK constraint, so runs and events are rebuilt. run_usage refers
-- to runs and is rebuilt with them. Rows and ids are kept. A run in awaiting_engine holds no
-- sandbox and does not count against capacity (see CAPACITY_SQL in d1-repo.ts).

PRAGMA defer_foreign_keys = true;

DROP TRIGGER events_no_update;
DROP TRIGGER events_no_delete;

CREATE TABLE events_old AS SELECT * FROM events;
DROP TABLE events;
CREATE TABLE run_usage_old AS SELECT * FROM run_usage;
DROP TABLE run_usage;

CREATE TABLE runs_new (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'cloning', 'implementing', 'publishing', 'pr_opened', 'reviewing', 'awaiting_engine', 'awaiting_checks', 'awaiting_approval', 'merged', 'needs_human', 'failed')),
  reason_code TEXT,
  pr_number INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  title TEXT,
  tier TEXT,
  head_sha TEXT,
  implement_model TEXT,
  review_model TEXT,
  single_engine INTEGER
);

INSERT INTO runs_new (id, repo, issue_number, state, reason_code, pr_number, created_at, updated_at, title, tier, head_sha)
  SELECT id, repo, issue_number, state, reason_code, pr_number, created_at, updated_at, title, tier, head_sha
  FROM runs;

DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

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
    'legacy_run', 'pr_closed', 'merged_outside_factory', 'base_not_default', 'head_changed',
    'policy_missing', 'policy_invalid', 'files_truncated', 'diff_too_large', 'review_failed',
    'review_invalid', 'changes_requested', 'check_failed', 'checks_timeout',
    'checks_permission_missing', 'operator_changes_requested', 'approval_timeout',
    'merge_refused', 'merge_conflict', 'stopped_by_operator',
    'budget_exceeded', 'engine_wait_timeout'
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

INSERT INTO run_usage (id, run_id, phase, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ts)
  SELECT id, run_id, phase, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ts
  FROM run_usage_old;
DROP TABLE run_usage_old;

CREATE INDEX run_usage_by_run ON run_usage (run_id);
-- The monthly spend reads one billing period.
CREATE INDEX run_usage_by_ts ON run_usage (ts);

-- One row per model call in flight. Not tied to runs by a foreign key: a row of a crashed
-- call is ignored once it is older than the agent's time limit.
CREATE TABLE run_inflight (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  started_at INTEGER NOT NULL
);

CREATE INDEX run_inflight_by_run ON run_inflight (run_id, started_at);

CREATE TABLE budget_alerts (
  period TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  issue_number INTEGER
);
