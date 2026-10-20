-- @lf/postgres-store, migration 6: a run keeps what its movement returned,
-- as lf records it (`{value}`, `{truncated, bytes, preview}` or
-- `{unwritable}`, capped by lf). `json`, not `jsonb`: the value reads back
-- in the key order it was written in.
ALTER TABLE lf.trigger_run ADD COLUMN returned json;
