-- The kept delivery a carried version's receipt was judged from. Its run takes
-- it as the delivery that started it, and the arrival ledger lists a receipt
-- that ran nothing (the old ownership gate's drop) under it. No foreign key, as
-- for a run's: a delivery past its retention leaves the id behind.

ALTER TABLE automations.trigger_event ADD COLUMN IF NOT EXISTS delivery_id uuid;

-- Filled once for the receipts written before this release, so that a replay's
-- "ran before" holds for them too: a receipt whose platform-built key names its
-- delivery (a reading row's `delivery:<id>:…`, a push's `push:<id>:…`) takes
-- that id. Only an exact uuid there is taken; any other key stays unfilled.
UPDATE automations.trigger_event
SET delivery_id = (regexp_match(external_event_id, '^(?:delivery|push):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):', 'i'))[1]::uuid
WHERE delivery_id IS NULL
  AND external_event_id ~* '^(?:delivery|push):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:';
