-- @lf/postgres-store, migration 5: a work row that keeps failing gives up.
-- `attempts` (counted per claim) is capped by lf; a row past its cap is
-- marked dead with why, never claimed again, and kept for an operator to
-- read. Queued again under its key, it lives again.
ALTER TABLE lf.work ADD COLUMN dead_at timestamptz, ADD COLUMN dead_reason text;
