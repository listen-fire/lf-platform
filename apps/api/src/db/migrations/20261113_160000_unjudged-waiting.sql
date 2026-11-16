-- A listen whose filter asks a host function the host cannot reach keeps the
-- arrival waiting, and every later arrival it would run waits behind it, in
-- the order they came, until a retry judges them. `waiting` marks the facts a
-- retry still owes a judgement; `kept_order` orders facts noted in one
-- instant, as one delivery's arrivals are, in the order they were kept.

ALTER TABLE automations.arrival_unjudged ADD COLUMN waiting boolean NOT NULL DEFAULT false;
ALTER TABLE automations.arrival_unjudged ADD COLUMN kept_order bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX arrival_unjudged_waiting_idx ON automations.arrival_unjudged (team_id, pipeline, noted_at, kept_order) WHERE waiting;
