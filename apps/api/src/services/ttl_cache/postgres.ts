import { sql } from 'kysely';

import type { TtlCache } from '.';
import { globalQb } from '../../lib/kysely';
import { sweepExpiredSoon } from './sweep';

// Raw SQL rather than the query builder: the generated table type brands its primary key, which
// a plain string key cannot satisfy without an assertion.
export const postgresTtlCache: TtlCache = {
  get: async (key) => {
    const { rows } = await sql<{ value: Buffer }>`
      SELECT value FROM automations.cache_entry WHERE key = ${key} AND expires_at > now()
    `.execute(globalQb);
    return rows[0]?.value ?? null;
  },

  set: async (key, value, ttlMs) => {
    sweepExpiredSoon();
    await sql`
      INSERT INTO automations.cache_entry (key, value, expires_at)
      VALUES (${key}, ${value}, now() + ${ttlMs} * interval '1 millisecond')
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value, counter = 0, expires_at = EXCLUDED.expires_at
    `.execute(globalQb);
  },

  take: async (key) => {
    const { rows } = await sql<{ value: Buffer; live: boolean }>`
      DELETE FROM automations.cache_entry WHERE key = ${key} RETURNING value, expires_at > now() AS live
    `.execute(globalQb);
    const row = rows[0];
    return row?.live ? row.value : null;
  },

  delete: async (key) => {
    await sql`DELETE FROM automations.cache_entry WHERE key = ${key}`.execute(globalQb);
  },
};
