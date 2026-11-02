SET search_path = automations, pg_catalog;

ALTER TABLE trigger_run
	ADD COLUMN chain text[] DEFAULT '{}'::text[] NOT NULL;
