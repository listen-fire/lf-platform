-- The fire statement is judged at the door: an arrival its automation's fire
-- list does not let start a run is kept as a fact, and a writer's replay of
-- it, which the list does not judge, records who replayed.


SET search_path = automations, pg_catalog;

CREATE TABLE arrival_refused (
	team_id uuid NOT NULL,
	delivery_id uuid NOT NULL,
	pipeline text NOT NULL,
	arrival text NOT NULL,
	file text NOT NULL,
	movement text NOT NULL,
	edge text NOT NULL,
	adapter text NOT NULL,
	reason text NOT NULL,
	noted_at timestamp with time zone NOT NULL
);

ALTER TABLE arrival_refused
	ADD CONSTRAINT arrival_refused_pkey PRIMARY KEY (team_id, delivery_id, pipeline, arrival);

CREATE INDEX arrival_refused_at_idx ON arrival_refused USING btree (team_id, noted_at);

ALTER TABLE delivery
	ADD COLUMN replayed_by uuid,
	ADD COLUMN replayed_by_credential text;
