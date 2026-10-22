
SET search_path = automations, pg_catalog;

ALTER TABLE "work"
	DROP CONSTRAINT work_key_key;

CREATE TABLE delivery (
	id uuid NOT NULL,
	team_id uuid NOT NULL,
	subscription_id text NOT NULL,
	external_id text,
	received_at timestamp with time zone NOT NULL,
	source text NOT NULL,
	inline boolean NOT NULL,
	replay_of uuid,
	events jsonb NOT NULL,
	event_count integer NOT NULL
);


CREATE TABLE event_receipt (
	team_id uuid NOT NULL,
	listen text NOT NULL,
	"key" text NOT NULL,
	received_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE inbound_checkpoint (
	team_id uuid NOT NULL,
	subscription_id text NOT NULL,
	checkpoint jsonb NOT NULL,
	updated_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE module_processes (
	team_id uuid NOT NULL,
	processes jsonb NOT NULL,
	version bigint NOT NULL,
	updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE trigger_run
	ADD COLUMN "host" text DEFAULT 'platform'::text NOT NULL,
	ADD COLUMN returned json,
	ADD COLUMN delivery_id uuid;

ALTER TABLE "work"
	ADD COLUMN "host" text DEFAULT 'platform'::text NOT NULL,
	ADD COLUMN dead_at timestamp with time zone,
	ADD COLUMN dead_reason text;

ALTER TABLE delivery
	ADD CONSTRAINT delivery_pkey PRIMARY KEY (id);

ALTER TABLE event_receipt
	ADD CONSTRAINT event_receipt_pkey PRIMARY KEY (team_id, listen, key);

ALTER TABLE inbound_checkpoint
	ADD CONSTRAINT inbound_checkpoint_pkey PRIMARY KEY (team_id, subscription_id);

ALTER TABLE module_processes
	ADD CONSTRAINT module_processes_pkey PRIMARY KEY (team_id);

ALTER TABLE delivery
	ADD CONSTRAINT delivery_source_check CHECK ((source = ANY (ARRAY['webhook'::text, 'hook'::text, 'emit'::text, 'cli'::text])));

ALTER TABLE trigger_run
	ADD CONSTRAINT trigger_run_host_check CHECK ((host = ANY (ARRAY['platform'::text, 'lf'::text])));

ALTER TABLE "work"
	ADD CONSTRAINT work_host_check CHECK ((host = ANY (ARRAY['platform'::text, 'lf'::text])));

ALTER TABLE "work"
	ADD CONSTRAINT work_host_key_unique UNIQUE (host, key);

CREATE UNIQUE INDEX delivery_external_idx ON delivery USING btree (team_id, subscription_id, external_id) WHERE (external_id IS NOT NULL);

CREATE INDEX delivery_received_idx ON delivery USING btree (team_id, received_at);

CREATE INDEX trigger_run_delivery_id_idx ON trigger_run USING btree (delivery_id);

CREATE INDEX trigger_run_host_team_idx ON trigger_run USING btree (host, team_id, started_at);
