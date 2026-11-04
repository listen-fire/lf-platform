-- listen-fire 0.13's store tables (@lf/postgres-store migrations 9 and 11 to 16,
-- in the platform's schema): waits and the arrival log, arrival identities kept
-- for the re-send window, the write ledger, listen states, failed runs and
-- releases for the records door, unjudged arrivals, a delivery's request and
-- the `poll` source, and the run lease's arrival mark. The callback and
-- correlation tables stay while any automation is pinned to 0.12.

SET search_path = automations, pg_catalog;

ALTER TABLE delivery
	DROP CONSTRAINT delivery_source_check;

CREATE SEQUENCE arrival_seq_seq
	START WITH 1
	INCREMENT BY 1
	NO MAXVALUE
	NO MINVALUE
	CACHE 1;

CREATE SEQUENCE wait_seen_id_seq
	START WITH 1
	INCREMENT BY 1
	NO MAXVALUE
	NO MINVALUE
	CACHE 1;

CREATE TABLE arrival (
	seq bigint DEFAULT nextval('automations.arrival_seq_seq'::regclass) NOT NULL,
	team_id uuid NOT NULL,
	adapter_type text NOT NULL,
	edge text NOT NULL,
	"key" text NOT NULL,
	"identity" text,
	version text,
	landing json,
	gone boolean NOT NULL,
	logged_at timestamp with time zone NOT NULL
);


CREATE TABLE arrival_identity (
	team_id uuid NOT NULL,
	adapter_type text NOT NULL,
	edge text NOT NULL,
	"key" text NOT NULL,
	"identity" text NOT NULL,
	version text,
	kept_until timestamp with time zone NOT NULL
);


CREATE TABLE arrival_unjudged (
	team_id uuid NOT NULL,
	pipeline text NOT NULL,
	arrival text NOT NULL,
	attempt integer NOT NULL,
	file text NOT NULL,
	movement text NOT NULL,
	delivery_id text,
	edge text NOT NULL,
	record_id text,
	reason text NOT NULL,
	cause text,
	noted_at timestamp with time zone NOT NULL
);


CREATE TABLE listen_state (
	team_id uuid NOT NULL,
	pipeline text NOT NULL,
	"state" jsonb NOT NULL,
	lease_token uuid,
	lease_until timestamp with time zone,
	updated_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE release_seen (
	team_id uuid NOT NULL,
	version text NOT NULL,
	seen_at timestamp with time zone NOT NULL
);


CREATE TABLE wait_row (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	run_id uuid NOT NULL,
	team_id uuid NOT NULL,
	adapter_type text NOT NULL,
	edge text NOT NULL,
	"key" text,
	since bigint NOT NULL,
	address text,
	created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	stranded_at timestamp with time zone,
	fire_key text,
	record_id text
);


CREATE TABLE wait_seen (
	id bigint DEFAULT nextval('automations.wait_seen_id_seq'::regclass) NOT NULL,
	wait_id uuid NOT NULL,
	"identity" text NOT NULL,
	version text,
	matched boolean NOT NULL,
	leaf text
);


CREATE TABLE write_ledger (
	team_id uuid NOT NULL,
	adapter text NOT NULL,
	record_type text NOT NULL,
	external_id text NOT NULL,
	run_id text NOT NULL,
	"depth" integer NOT NULL,
	"at" timestamp with time zone NOT NULL
);


ALTER TABLE delivery
	ADD COLUMN request jsonb;

ALTER TABLE trigger_run
	ADD COLUMN lease_mark bigint;

ALTER SEQUENCE arrival_seq_seq
	OWNED BY automations.arrival.seq;

ALTER SEQUENCE wait_seen_id_seq
	OWNED BY automations.wait_seen.id;

CREATE OR REPLACE FUNCTION delete_waits_of_run() RETURNS pg_catalog.trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM automations.wait_row WHERE run_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION lock_wait_key(team uuid, adapter_type text, edge text, "key" text) RETURNS void
    LANGUAGE sql
    AS $$ SELECT pg_advisory_xact_lock(hashtextextended(concat_ws(chr(31), team::text, adapter_type, edge, key), 0)) $$;

ALTER TABLE arrival
	ADD CONSTRAINT arrival_pkey PRIMARY KEY (seq);

ALTER TABLE arrival_unjudged
	ADD CONSTRAINT arrival_unjudged_pkey PRIMARY KEY (team_id, pipeline, arrival, attempt);

ALTER TABLE listen_state
	ADD CONSTRAINT listen_state_pkey PRIMARY KEY (team_id, pipeline);

ALTER TABLE release_seen
	ADD CONSTRAINT release_seen_pkey PRIMARY KEY (team_id, version);

ALTER TABLE wait_row
	ADD CONSTRAINT wait_row_pkey PRIMARY KEY (id);

ALTER TABLE wait_seen
	ADD CONSTRAINT wait_seen_pkey PRIMARY KEY (id);

ALTER TABLE delivery
	ADD CONSTRAINT delivery_source_check CHECK ((source = ANY (ARRAY['webhook'::text, 'hook'::text, 'emit'::text, 'cli'::text, 'poll'::text])));

ALTER TABLE wait_row
	ADD CONSTRAINT wait_row_edge_unique UNIQUE (run_id, team_id, adapter_type, edge, key);

ALTER TABLE wait_seen
	ADD CONSTRAINT wait_seen_wait_id_fkey FOREIGN KEY (wait_id) REFERENCES automations.wait_row(id) ON DELETE CASCADE;

CREATE INDEX arrival_key_idx ON arrival USING btree (team_id, adapter_type, edge, key, seq);

CREATE INDEX arrival_logged_idx ON arrival USING btree (logged_at);

CREATE INDEX arrival_identity_of_idx ON arrival_identity USING btree (team_id, adapter_type, edge, key, identity);

CREATE INDEX arrival_identity_until_idx ON arrival_identity USING btree (kept_until);

CREATE INDEX arrival_unjudged_at_idx ON arrival_unjudged USING btree (team_id, noted_at, pipeline, arrival, attempt);

CREATE INDEX release_seen_at_idx ON release_seen USING btree (team_id, seen_at, version);

CREATE INDEX trigger_run_failed_idx ON trigger_run USING btree (team_id, failed_at, id) WHERE (status = 'failed'::text);

CREATE INDEX trigger_run_lease_mark_idx ON trigger_run USING btree (lease_until) WHERE (lease_mark IS NOT NULL);

CREATE INDEX wait_row_fire_key_idx ON wait_row USING btree (fire_key) WHERE (fire_key IS NOT NULL);

CREATE INDEX wait_row_key_idx ON wait_row USING btree (team_id, adapter_type, edge, key);

CREATE UNIQUE INDEX wait_row_keyless_unique ON wait_row USING btree (run_id, team_id, adapter_type, edge) WHERE (key IS NULL);

CREATE INDEX wait_row_run_id_idx ON wait_row USING btree (run_id);

CREATE INDEX wait_row_stranded_idx ON wait_row USING btree (stranded_at, id) WHERE (stranded_at IS NOT NULL);

CREATE INDEX wait_seen_identity_idx ON wait_seen USING btree (wait_id, identity);

CREATE INDEX work_settle_race_run_idx ON "work" USING btree (((payload ->> 'runId'::text))) WHERE (kind = 'settle_race'::text);

CREATE INDEX write_ledger_at_idx ON write_ledger USING btree (team_id, at);

CREATE INDEX write_ledger_record_idx ON write_ledger USING btree (team_id, adapter, record_type, external_id, at);

CREATE TRIGGER trigger_run_deletes_its_waits
	AFTER DELETE ON trigger_run
	FOR EACH ROW
	EXECUTE PROCEDURE automations.delete_waits_of_run();
