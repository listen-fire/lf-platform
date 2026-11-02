-- listen-fire 0.13: a delivery's arrivals fire listens, and the delivery is
-- kept with its request (automations.delivery), so a listen can be put through
-- it again. The 0.12 trigger-event receipts, which nothing writes since the
-- capture path was retired, go with their link from a run. Runs on or after
-- 20261102_100000_retire-dispatch-queue, which marks rows here.


SET search_path = automations, pg_catalog;

ALTER TABLE trigger_run
	DROP CONSTRAINT trigger_run_trigger_event_id_fkey;

DROP INDEX trigger_run_trigger_event_id_idx;

ALTER TABLE trigger_run
	DROP COLUMN IF EXISTS trigger_event_id;
DROP TABLE IF EXISTS automations.trigger_event;
