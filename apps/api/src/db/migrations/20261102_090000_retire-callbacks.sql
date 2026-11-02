-- listen-fire 0.13 retires callbacks and the 0.12 correlation map (rulings 7
-- and 8). Every run parked at this point was parked by a 0.12 or older engine,
-- whose park state the 0.13 engine refuses on resume. Each is failed here,
-- naming the release it was pinned to and the remedy, so that no wake throws
-- later. A run paused at a spending limit is parked too, and is failed the same
-- way. Asks those runs were waiting on are withdrawn, as a failed run's are.

SET search_path = automations, pg_catalog;

CREATE TEMP TABLE retired_park (run_id uuid PRIMARY KEY, release text NOT NULL) ON COMMIT DROP;

INSERT INTO retired_park (run_id, release)
SELECT r.id, coalesce('language release ' || v.language_version, 'an older language release')
FROM trigger_run r
LEFT JOIN movement_version v ON v.id = r.movement_version_id
WHERE r.status = 'parked';

UPDATE asks.ask a
SET state = 'expired', expired_at = now()
FROM adapter_await w
JOIN retired_park p ON p.run_id = w.run_id
WHERE w.adapter_type = 'ask'
  AND w.correlation_key = a.id::text
  AND a.state = 'open';

UPDATE trigger_run r
SET status = 'failed',
    failed_at = now(),
    failure_reason = 'This run was waiting under ' || p.release
      || ', and listen-fire 0.13 cannot resume a run parked by an older release. '
      || 'Upgrade its automation to 0.13, then run it again.',
    limit_pause = NULL,
    cancel_requested_at = NULL,
    cancel_reason = NULL
FROM retired_park p
WHERE r.id = p.run_id;

DELETE FROM parked_run WHERE run_id IN (SELECT run_id FROM retired_park);
DELETE FROM join_pending WHERE run_id IN (SELECT run_id FROM retired_park);
DELETE FROM join_branch_export WHERE run_id IN (SELECT run_id FROM retired_park);

DELETE FROM work
WHERE host = 'platform'
  AND (kind IN ('fire_callback', 'wake_await')
    OR (kind = 'resume_timer' AND payload->>'runId' IN (SELECT run_id::text FROM retired_park)));

DROP TABLE callback;

DROP TABLE adapter_await;
