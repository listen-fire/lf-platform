// The limiter's tables, in a schema of their own so they cannot collide with
// lf's store or anything else sharing the database. Every statement here is
// safe to run again, and safe to run from many hosts at once.

export const DEFAULT_SCHEMA = 'lf_postgres_limiter';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** `name` quoted for SQL; a schema name is never interpolated unchecked. */
export function schemaIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`schema "${name}": expected lowercase letters, digits and underscores, not starting with a digit`);
  return `"${name}"`;
}

/** Epoch milliseconds by the database's clock: every host shares one time, so
 *  a host with a drifting clock cannot hold or free capacity early. */
export const NOW_MS = '(extract(epoch from clock_timestamp()) * 1000)::float8';

export function schemaStatements(schema: string): string[] {
  const s = schemaIdentifier(schema);
  return [
    `create schema if not exists ${s}`,
    // One row per limit bucket: a rate limit's tokens, and the row concurrent
    // acquires lock on to count held permits without racing.
    `create table if not exists ${s}.buckets (key text primary key, tokens double precision not null, filled_at double precision not null)`,
    // A place held in a bucket; a permit holds one row per concurrent bucket.
    // Held places are counted from these rows (never a stored counter), so a
    // holder that crashes frees its places when `lapses_at` passes.
    `create table if not exists ${s}.permits (permit text not null, bucket text not null, lapses_at double precision not null, primary key (permit, bucket))`,
    `create index if not exists permits_bucket_lapses on ${s}.permits (bucket, lapses_at)`,
    `create table if not exists ${s}.throttles (key text primary key, until_at double precision not null)`,
  ];
}
