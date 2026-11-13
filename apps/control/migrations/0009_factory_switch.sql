-- Stage 7: an operator stops and resumes the whole factory without a deploy.
--
-- One row per change. The latest row is in force; with no row the factory runs. The
-- RUNS_ENABLED variable stays above this switch: when it is not "true" nothing starts,
-- whatever the latest row says. Rows are never changed or removed, so the table is also
-- the record of who stopped or resumed the factory and when.

CREATE TABLE factory_switch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
);

CREATE TRIGGER factory_switch_no_update BEFORE UPDATE ON factory_switch
BEGIN
  SELECT RAISE(ABORT, 'factory_switch is append-only');
END;

CREATE TRIGGER factory_switch_no_delete BEFORE DELETE ON factory_switch
BEGIN
  SELECT RAISE(ABORT, 'factory_switch is append-only');
END;
