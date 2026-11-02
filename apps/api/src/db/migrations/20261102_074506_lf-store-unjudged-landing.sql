
SET search_path = automations, pg_catalog;

ALTER TABLE arrival_unjudged
	ADD COLUMN adapter text,
	ADD COLUMN landing jsonb;
