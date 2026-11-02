SET search_path = automations, pg_catalog;

CREATE TABLE delivery_request_read (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	team_id uuid NOT NULL,
	delivery_id uuid NOT NULL,
	read_by uuid NOT NULL,
	credential_id text,
	read_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE delivery_request_read
	ADD CONSTRAINT delivery_request_read_pkey PRIMARY KEY (id);

CREATE INDEX delivery_request_read_delivery_idx ON delivery_request_read USING btree (team_id, delivery_id);
