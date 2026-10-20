// @lf/postgres-limiter: the limiter slot kept in Postgres, so every host
// sharing the database shares one count. Each acquire is one transaction that
// locks the rows of the buckets it names (in a fixed order, so two acquires
// cannot deadlock), reads the database's own clock, decides (windowing.ts) and
// writes the result before any other acquire on those buckets can read.

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { LimitGrant, Limiter, LimitRequest } from 'movement-engine/public/limiter';
import { NOW_MS, schemaIdentifier, schemaStatements } from './schema';
import { decide, freshTokens, type BucketState, type HeldState } from './windowing';

export class PostgresLimiter implements Limiter {
  private readonly s: string;

  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    schema: string,
  ) {
    this.s = schemaIdentifier(schema);
  }

  /** Create the tables if they are not there; many hosts may do this at once. */
  async setup(schema: string): Promise<void> {
    await this.transaction(async (db) => {
      await db.query('select pg_advisory_xact_lock(hashtext($1))', [`lf-postgres-limiter:${schema}`]);
      for (const statement of schemaStatements(schema)) await db.query(statement);
    });
  }

  async acquire(request: LimitRequest): Promise<LimitGrant> {
    return this.transaction(async (db) => {
      // One row per distinct bucket, locked in key order; the upsert both
      // creates a missing bucket and takes the lock, so no read-then-write gap.
      const stored = new Map<string, BucketState>();
      const limitOf = new Map(request.limits.map((limit) => [limit.key, limit]));
      for (const key of [...limitOf.keys()].sort()) {
        const limit = limitOf.get(key);
        if (limit === undefined) continue;
        const row = await db.query<{ tokens: number; filled_at: number }>(
          `insert into ${this.s}.buckets (key, tokens, filled_at) values ($1, $2, ${NOW_MS})
           on conflict (key) do update set key = excluded.key returning tokens, filled_at`,
          [key, freshTokens(limit)],
        );
        const bucket = row.rows[0];
        if (bucket !== undefined) stored.set(key, { tokens: bucket.tokens, filledAt: bucket.filled_at });
      }

      // After the locks: waiting for them must not age the instant decided on.
      const now = await this.now(db);
      const throttle = await db.query<{ until_at: number }>(`select until_at from ${this.s}.throttles where key = $1`, [request.key]);
      const until = throttle.rows[0]?.until_at;
      if (until !== undefined) {
        if (until > now) return refused(until);
        await db.query(`delete from ${this.s}.throttles where key = $1 and until_at <= $2`, [request.key, now]);
      }

      const concurrent = request.limits.filter((limit) => limit.concurrent !== undefined).map((limit) => limit.key);
      const held = new Map<string, HeldState>();
      if (concurrent.length > 0) {
        await db.query(`delete from ${this.s}.permits where bucket = any($1::text[]) and lapses_at <= $2`, [concurrent, now]);
        const counts = await db.query<{ bucket: string; count: string; soonest: number }>(
          `select bucket, count(*) as count, min(lapses_at) as soonest from ${this.s}.permits where bucket = any($1::text[]) group by bucket`,
          [concurrent],
        );
        for (const row of counts.rows) held.set(row.bucket, { count: Number(row.count), soonestLapse: row.soonest });
      }

      const decision = decide({ request, buckets: stored, held, now });
      if (!decision.granted) return refused(decision.retryAt);

      const keys = [...decision.buckets.keys()];
      await db.query(
        `update ${this.s}.buckets b set tokens = u.tokens, filled_at = u.filled_at
         from unnest($1::text[], $2::float8[], $3::float8[]) as u(key, tokens, filled_at) where b.key = u.key`,
        [keys, keys.map((key) => decision.buckets.get(key)?.tokens ?? 0), keys.map((key) => decision.buckets.get(key)?.filledAt ?? now)],
      );
      const permit = randomUUID();
      if (decision.holds.length > 0) {
        await db.query(`insert into ${this.s}.permits (permit, bucket, lapses_at) select $1, bucket, $3 from unnest($2::text[]) as bucket`, [
          permit,
          [...new Set(decision.holds)],
          now + request.holdMs,
        ]);
      }
      return { granted: true, permit };
    });
  }

  async release(permit: string): Promise<void> {
    await this.query(`delete from ${this.s}.permits where permit = $1`, [permit]);
  }

  async throttle(input: { key: string; until: string }): Promise<void> {
    const until = Date.parse(input.until);
    if (!Number.isFinite(until)) throw new Error(`throttle until ${JSON.stringify(input.until)}: not an instant`);
    // The later of two throttles stands; lapsed ones of other keys are swept here.
    await this.transaction(async (db) => {
      await db.query(
        `insert into ${this.s}.throttles (key, until_at) values ($1, $2)
         on conflict (key) do update set until_at = greatest(${this.s}.throttles.until_at, excluded.until_at)`,
        [input.key, until],
      );
      await db.query(`delete from ${this.s}.throttles where until_at <= ${NOW_MS}`);
    });
  }

  private async now(db: PoolClient): Promise<number> {
    const row = await db.query<{ now: number }>(`select ${NOW_MS} as now`);
    const now = row.rows[0]?.now;
    if (now === undefined) throw new Error('the database gave no time');
    return now;
  }

  private async query(text: string, values: unknown[]): Promise<void> {
    const db = await this.pool.connect();
    try {
      await db.query(text, values);
    } finally {
      db.release();
    }
  }

  private async transaction<T>(body: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('begin');
      const result = await body(db);
      await db.query('commit');
      return result;
    } catch (error) {
      await db.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  }
}

function refused(retryAt: number): LimitGrant {
  return { granted: false, retryAt: new Date(Math.ceil(retryAt)).toISOString() };
}
