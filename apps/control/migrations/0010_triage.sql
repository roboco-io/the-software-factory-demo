-- Stage 7: guest requests (docs/guest-demo.md). One row per triaged issue.
--
-- A guest opens an issue from a template. The control plane decides once per issue whether
-- the request is accepted (a run starts), rejected (closed with a fixed reason) or left to
-- the administrator. The row keeps the decision and fixed codes only: never the issue text
-- or the model's words. body_sha256 pins the text that was triaged, so a later edit of the
-- issue cannot change what was accepted. The unique key makes "one triage per issue" hold
-- when a webhook is delivered twice.

CREATE TABLE triage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'needs_admin', 'admin_rejected')),
  category TEXT,
  reason_code TEXT,
  model TEXT,
  body_sha256 TEXT NOT NULL,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (repo, issue_number)
);

-- The per-account limit counts an account's rows of the last day.
CREATE INDEX triage_by_author ON triage (author_id, created_at);
