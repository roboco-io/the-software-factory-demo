-- Stage 5: budget limits an operator changes without a deploy.
--
-- One row per change. The latest row is in force; with no row the control plane uses the
-- BUDGET_ANTHROPIC_USD, BUDGET_OPENAI_USD and RUN_BUDGET_USD variables. Rows are never
-- changed or removed, so the table is also the record of who set which limits and when.

CREATE TABLE budget_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  anthropic_usd REAL NOT NULL CHECK (anthropic_usd >= 0),
  openai_usd REAL NOT NULL CHECK (openai_usd >= 0),
  run_cap_usd REAL NOT NULL CHECK (run_cap_usd >= 0)
);

CREATE TRIGGER budget_limits_no_update BEFORE UPDATE ON budget_limits
BEGIN
  SELECT RAISE(ABORT, 'budget_limits are append-only');
END;

CREATE TRIGGER budget_limits_no_delete BEFORE DELETE ON budget_limits
BEGIN
  SELECT RAISE(ABORT, 'budget_limits are append-only');
END;
