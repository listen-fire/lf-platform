import { sql } from 'kysely';

import { globalQb } from '../../lib/kysely';

// Raw SQL throughout the cache: a plain query on the shared pool, never inside a caller's
// transaction (a counter or cache write that rolled back with its request would defeat the point).

/**
 * The cache table is a plain table, so nothing expires rows on its own. Every writer sweeps at
 * most once a minute per process, which bounds the table without a scheduled job (the API may be
 * stopped between requests).
 */
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BATCH = 5000;

let lastSweepMs = 0;

export function sweepExpiredSoon(): void {
  const now = Date.now();
  if (now - lastSweepMs < SWEEP_INTERVAL_MS) return;
  lastSweepMs = now;
  void sql`
    DELETE FROM automations.cache_entry
    WHERE key IN (SELECT key FROM automations.cache_entry WHERE expires_at <= now() LIMIT ${SWEEP_BATCH})
  `
    .execute(globalQb)
    .catch(() => {
      lastSweepMs = 0;
    });
}

export function resetSweepForTests(): void {
  lastSweepMs = 0;
}
