-- A delivery is kept as it arrives, before any version reads it. This says when
-- the platform's own version finished reading it: a retry of a delivery kept
-- but not yet judged reads it again rather than taking it for a duplicate.
-- Rows from before this column were kept in one write with their judging.
ALTER TABLE automations.delivery ADD COLUMN IF NOT EXISTS judged_at timestamptz;
UPDATE automations.delivery SET judged_at = received_at WHERE judged_at IS NULL;
