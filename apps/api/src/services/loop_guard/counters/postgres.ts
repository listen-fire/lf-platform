import { sql } from 'kysely';

import { globalQb } from '../../../lib/kysely';
import { sweepExpiredSoon } from '../../ttl_cache/sweep';
import type { BucketBackend } from './backend';

/**
 * Counters in the shared cache table, for when no Redis is configured: unlike process memory they
 * are exact across API instances and survive a stop between requests. One statement per dispatch;
 * it costs a database round trip where Redis costs a pipelined one.
 */
/** A stalled database must not stall a dispatch: past this the caller fails open. */
const OP_TIMEOUT_MS = 1000;

async function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('loop_guard postgres op timed out')),
          OP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const postgresBucketBackend: BucketBackend = {
  addAndRead: async ({ bucketKey, amount, ttlSeconds, readKeys }) => {
    sweepExpiredSoon();
    // The data-modifying CTE and the outer SELECT share one snapshot, so the outer read cannot see
    // the bucket just written; the CTE returns it instead, and the read excludes it.
    const { rows } = await withTimeout(
      sql<{ key: string; counter: string }>`
      WITH bumped AS (
        INSERT INTO automations.cache_entry AS c (key, counter, expires_at)
        VALUES (${bucketKey}, ${amount}, now() + ${ttlSeconds} * interval '1 second')
        ON CONFLICT (key) DO UPDATE SET
          counter = CASE WHEN c.expires_at > now() THEN c.counter + EXCLUDED.counter ELSE EXCLUDED.counter END,
          expires_at = EXCLUDED.expires_at
        RETURNING key, counter
      )
      SELECT key, counter FROM bumped
      UNION ALL
      SELECT key, counter FROM automations.cache_entry
      WHERE key = ANY(${readKeys}::text[]) AND key <> ${bucketKey} AND expires_at > now()
    `.execute(globalQb),
    );
    const byKey = new Map(rows.map((row) => [row.key, Number(row.counter)]));
    return readKeys.map((key) => byKey.get(key) ?? 0);
  },

  remove: async (keys) => {
    if (keys.length === 0) return;
    await sql`DELETE FROM automations.cache_entry WHERE key = ANY(${keys}::text[])`.execute(
      globalQb,
    );
  },
};
