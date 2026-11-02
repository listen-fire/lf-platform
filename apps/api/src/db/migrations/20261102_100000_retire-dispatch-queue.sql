-- listen-fire 0.13 retires the queue of events captured under 0.12
-- (`dispatch_event` work rows): an event no longer fires a listen; a delivery's
-- arrivals do. A row still queued at this deploy would otherwise be deleted
-- with its retired kind, and its event would never run, silently. Each is
-- failed here by name instead: the run it had queued, or a failed run made for
-- it when it had queued none, so the automation's activity shows it, and its
-- stored event is marked failed with the same reason.

SET search_path = automations, pg_catalog;

CREATE TEMP TABLE pending_dispatch (
  work_id uuid PRIMARY KEY,
  team_id uuid NOT NULL,
  trigger_id text NOT NULL,
  trigger_type text NOT NULL,
  run_id uuid,
  stored_event_id uuid
) ON COMMIT DROP;

INSERT INTO pending_dispatch (work_id, team_id, trigger_id, trigger_type, run_id, stored_event_id)
SELECT w.id,
       coalesce(w.team_id, (w.payload->>'teamId')::uuid),
       w.payload->>'triggerId',
       coalesce(w.payload->'triggerEvent'->>'triggerType', 'webhook'),
       nullif(w.payload->>'runId', '')::uuid,
       nullif(w.payload->>'storedEventId', '')::uuid
FROM work w
WHERE w.host = 'platform'
  AND w.kind = 'dispatch_event'
  AND w.payload->>'triggerId' IS NOT NULL
  AND coalesce(w.team_id::text, w.payload->>'teamId') IS NOT NULL;

UPDATE trigger_run r
SET status = 'failed',
    failed_at = now(),
    failure_reason = 'This event was still queued when the platform upgraded to listen-fire 0.13, '
      || 'which runs no event queued under an earlier release: it was not run. '
      || 'Upgrade the automation to 0.13, then send the event again.'
FROM pending_dispatch p
WHERE r.id = p.run_id
  AND r.status = 'running'
  AND r.last_heartbeat_at IS NULL;

INSERT INTO trigger_run (team_id, trigger_id, trigger_type, status, started_at, failed_at, failure_reason)
SELECT p.team_id, p.trigger_id, p.trigger_type, 'failed', now(), now(),
       'This event was still queued when the platform upgraded to listen-fire 0.13, '
       || 'which runs no event queued under an earlier release: it was not run. '
       || 'Upgrade the automation to 0.13, then send the event again.'
FROM pending_dispatch p
WHERE p.run_id IS NULL;

UPDATE trigger_event e
SET status = 'failed',
    failure_reason = 'Still queued at the upgrade to listen-fire 0.13: not run.'
FROM pending_dispatch p
WHERE e.id = p.stored_event_id
  AND e.status <> 'dispatched';

DELETE FROM work WHERE id IN (SELECT work_id FROM pending_dispatch);
