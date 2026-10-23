
SET search_path = automations, pg_catalog;

CREATE TABLE team_engine (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	team_id uuid NOT NULL,
	engine text NOT NULL,
	changed_at timestamp with time zone DEFAULT now() NOT NULL,
	changed_by uuid
);


ALTER TABLE team_engine
	ADD CONSTRAINT team_engine_pkey PRIMARY KEY (id);

ALTER TABLE team_engine
	ADD CONSTRAINT team_engine_engine_check CHECK ((engine = ANY (ARRAY['platform'::text, 'lf'::text])));

CREATE UNIQUE INDEX team_engine_team_id_key ON team_engine USING btree (team_id);

CREATE TRIGGER team_engine_audit
	AFTER INSERT OR UPDATE OR DELETE ON team_engine
	FOR EACH ROW
	EXECUTE PROCEDURE automations.audit();
