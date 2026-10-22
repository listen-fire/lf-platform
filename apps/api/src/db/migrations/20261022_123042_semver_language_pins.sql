-- A saved movement's language pin becomes text: a legacy id '1'..'4' (the
-- legacy packages, unchanged) or the semver of the language release it was
-- written against. The integer 5 meant "the installed language", which is the
-- 0.12 line, so it becomes '0.12.0'.

SET search_path = automations, pg_catalog;

ALTER TABLE movement
	ALTER COLUMN validity_checked_against TYPE text USING validity_checked_against::text,
	ALTER COLUMN language_version TYPE text USING language_version::text,
	ALTER COLUMN language_version SET DEFAULT '1'::text,
	ALTER COLUMN upgrade_checked_against TYPE text USING upgrade_checked_against::text;

ALTER TABLE movement_version
	ALTER COLUMN language_version TYPE text USING language_version::text;

UPDATE movement SET language_version = '0.12.0' WHERE language_version = '5';
UPDATE movement SET validity_checked_against = '0.12.0' WHERE validity_checked_against = '5';
UPDATE movement SET upgrade_checked_against = '0.12.0' WHERE upgrade_checked_against = '5';
UPDATE movement_version SET language_version = '0.12.0' WHERE language_version = '5';
