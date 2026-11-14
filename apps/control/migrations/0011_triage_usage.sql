-- Stage 7: token usage of the guest triage model calls (docs/guest-demo.md 7).
--
-- A triage call belongs to an issue, not to a run: a rejected request never gets a run.
-- run_usage needs a run, so these calls get their own table. The monthly budget and the
-- demo repository's daily limit both add these rows to the runs' usage.

CREATE TABLE triage_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX triage_usage_by_ts ON triage_usage (ts);
