-- @lf/postgres-store, migration 4: the module processes the lfs on this
-- store started, one list per tenant, so the next lf stops what a killed one
-- left running. Written by compare-and-set on `version`, so two lfs on one
-- store never overwrite each other's entries.
CREATE TABLE lf.module_processes (
    team_id uuid PRIMARY KEY,
    processes jsonb NOT NULL,
    version bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
