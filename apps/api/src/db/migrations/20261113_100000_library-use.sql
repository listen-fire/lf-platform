-- Use on a library: a file that exports has a use list beside its read and
-- write lists, so `use` may now be stated about an automation. Whether a
-- library still stands (one of its writers holds use on each connection it
-- names) is kept per library and recomputed when a list or a membership changes.

SET search_path = automations, pg_catalog;

ALTER TABLE access_statement
	DROP CONSTRAINT access_statement_verb_thing_check;

ALTER TABLE access_statement
	ADD CONSTRAINT access_statement_verb_thing_check CHECK (((thing <> 'connection'::text) OR (verb = 'use'::text)));

CREATE TABLE library_standing (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	team_id uuid NOT NULL,
	movement_id uuid NOT NULL,
	lost_connection_id uuid,
	checked_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE library_standing
	ADD CONSTRAINT library_standing_pkey PRIMARY KEY (id);

ALTER TABLE library_standing
	ADD CONSTRAINT library_standing_movement_id_key UNIQUE (movement_id);

ALTER TABLE library_standing
	ADD CONSTRAINT library_standing_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES movement(id) ON DELETE CASCADE;

ALTER TABLE library_standing
	ADD CONSTRAINT library_standing_lost_connection_id_fkey FOREIGN KEY (lost_connection_id) REFERENCES external_service_credentials(id) ON DELETE SET NULL;

CREATE INDEX library_standing_team_idx ON library_standing USING btree (team_id);

CREATE TRIGGER library_standing_audit
	AFTER INSERT OR UPDATE OR DELETE ON library_standing
	FOR EACH ROW
	EXECUTE PROCEDURE automations.audit();
