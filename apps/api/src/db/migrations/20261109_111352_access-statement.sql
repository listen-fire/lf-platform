-- Access statements: who may read or write one automation, and who may
-- use one connection, beside the team's own read or write. Nothing is backfilled
-- here: until a thing has a statement, nobody passes a decision about it.


SET search_path = automations, pg_catalog;

CREATE TABLE access_statement (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	team_id uuid NOT NULL,
	thing text NOT NULL,
	thing_id uuid NOT NULL,
	verb text NOT NULL,
	grantee text NOT NULL,
	"value" text,
	created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE access_statement
	ADD CONSTRAINT access_statement_pkey PRIMARY KEY (id);

ALTER TABLE access_statement
	ADD CONSTRAINT access_statement_grantee_check CHECK ((grantee = ANY (ARRAY['team'::text, 'user'::text])));

ALTER TABLE access_statement
	ADD CONSTRAINT access_statement_thing_check CHECK ((thing = ANY (ARRAY['automation'::text, 'connection'::text])));

ALTER TABLE access_statement
	ADD CONSTRAINT access_statement_value_check CHECK (((value IS NULL) = (grantee = 'team'::text)));

ALTER TABLE access_statement
	ADD CONSTRAINT access_statement_verb_check CHECK ((verb = ANY (ARRAY['read'::text, 'write'::text, 'use'::text])));

ALTER TABLE access_statement
	ADD CONSTRAINT access_statement_verb_thing_check CHECK (((verb = 'use'::text) = (thing = 'connection'::text)));

CREATE UNIQUE INDEX access_statement_grant_key ON access_statement USING btree (thing, thing_id, verb, grantee, COALESCE(value, ''::text));

CREATE INDEX access_statement_team_idx ON access_statement USING btree (team_id, thing, verb);

CREATE TRIGGER access_statement_audit
	AFTER INSERT OR UPDATE OR DELETE ON access_statement
	FOR EACH ROW
	EXECUTE PROCEDURE automations.audit();
