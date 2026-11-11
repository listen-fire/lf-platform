-- Whether an automation reads `Actor` is a fact about the automation, so a run
-- any of its triggers started has the arrivals it waits on written with who
-- acted. Every automation saved before this reads as not saying it until its
-- next save, as it could not have: the field did not exist.


SET search_path = automations, pg_catalog;

ALTER TABLE movement
	ADD COLUMN reads_actor boolean DEFAULT false NOT NULL;
