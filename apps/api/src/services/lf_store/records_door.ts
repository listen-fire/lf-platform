// What lf's records door reads beside the tenant's failed runs (runs.ts):
// the releases a cloud lf was opened under (`releases.*`) and the arrivals a
// listen could not judge (`unjudged.*`), ported from pg_store.rs over
// automations.release_seen and arrival_unjudged, one tenant's rows each.

import { sql } from 'kysely';

import { inTransaction, iso, pool, type Exec, type LfTenant } from './scope';

// ── Releases ────────────────────────────────────────────────────────────────

/** `true` when the release is new to the tenant (kept, first seen `at`). */
export async function noteRelease(scope: LfTenant, input: { version: string; at: string }): Promise<boolean> {
  const { rows } = await sql`
    insert into automations.release_seen (team_id, version, seen_at)
    values (${scope.tenant}::uuid, ${input.version}::text, date_trunc('milliseconds', ${input.at}::timestamptz))
    on conflict do nothing returning 1`.execute(pool());
  return rows.length === 1;
}

/** The releases kept after the one `after` names, oldest first (ties by version). */
export async function releases(
  scope: LfTenant,
  input: { after: { at: string; version: string } | null; limit: number },
): Promise<{ version: string; at: string }[]> {
  const columns = sql`select r.version, ${iso('r.seen_at')} as at from automations.release_seen r where r.team_id = ${scope.tenant}::uuid`;
  const { rows } =
    input.after === null
      ? await sql<{ version: string; at: string }>`${columns} order by r.seen_at, r.version limit ${input.limit}::int8`.execute(pool())
      : await sql<{ version: string; at: string }>`${columns} and (r.seen_at, r.version) > (${input.after.at}::timestamptz, ${input.after.version}::text)
          order by r.seen_at, r.version limit ${input.limit}::int8`.execute(pool());
  return rows;
}

// ── Arrivals a listen could not judge ───────────────────────────────────────

export interface UnjudgedArrival {
  pipeline: string;
  /** The arrival's receipt key. */
  arrival: string;
  file: string;
  movement: string;
  deliveryId: string | null;
  edge: string;
  recordId: string | null;
  reason: string;
  cause: string | null;
  at: string;
  /** 0 as delivered, one more for each replay of it through the listen. */
  attempt: number;
}

/** Kept once per listen, arrival and attempt: whether this is the first. */
export async function keepUnjudgedIn(exec: Exec, scope: LfTenant, fact: UnjudgedArrival): Promise<boolean> {
  const { rows } = await sql`
    insert into automations.arrival_unjudged
      (team_id, pipeline, arrival, file, movement, delivery_id, edge, record_id, reason, cause, noted_at, attempt)
    values (${scope.tenant}::uuid, ${fact.pipeline}::text, ${fact.arrival}::text, ${fact.file}::text, ${fact.movement}::text,
            ${fact.deliveryId}::text, ${fact.edge}::text, ${fact.recordId}::text, ${fact.reason}::text, ${fact.cause}::text,
            date_trunc('milliseconds', ${fact.at}::timestamptz), ${fact.attempt}::int4)
    on conflict do nothing returning 1`.execute(exec);
  return rows.length === 1;
}

/** One write: the facts found before `forgetBefore` forgotten, and this one kept. */
export function noteUnjudged(scope: LfTenant, input: UnjudgedArrival & { forgetBefore: string }): Promise<boolean> {
  const { forgetBefore, ...fact } = input;
  return inTransaction(async (trx) => {
    await sql`
      delete from automations.arrival_unjudged where team_id = ${scope.tenant}::uuid and noted_at < ${forgetBefore}::timestamptz`.execute(trx);
    return keepUnjudgedIn(trx, scope, fact);
  });
}

/** The facts kept after the one `after` names, only the listen `pipeline`'s
 *  when it names one, oldest first (ties by pipeline, arrival, attempt). */
export async function unjudged(
  scope: LfTenant,
  input: { after: { at: string; pipeline: string; arrival: string; attempt: number } | null; pipeline: string | null; limit: number },
): Promise<UnjudgedArrival[]> {
  const columns = sql`
    select u.pipeline, u.arrival, u.file, u.movement, u.delivery_id, u.edge, u.record_id, u.reason, u.cause, ${iso('u.noted_at')} as at, u.attempt
    from automations.arrival_unjudged u
    where u.team_id = ${scope.tenant}::uuid and (${input.pipeline}::text is null or u.pipeline = ${input.pipeline}::text)`;
  const order = sql`order by u.noted_at, u.pipeline, u.arrival, u.attempt limit ${input.limit}::int8`;
  const { after } = input;
  const { rows } = await sql<{
    pipeline: string;
    arrival: string;
    file: string;
    movement: string;
    delivery_id: string | null;
    edge: string;
    record_id: string | null;
    reason: string;
    cause: string | null;
    at: string;
    attempt: number;
  }>`${columns} ${
    after === null
      ? sql``
      : sql`and (u.noted_at, u.pipeline, u.arrival, u.attempt) > (${after.at}::timestamptz, ${after.pipeline}::text, ${after.arrival}::text, ${after.attempt}::int4)`
  } ${order}`.execute(pool());
  return rows.map((r) => ({
    pipeline: r.pipeline,
    arrival: r.arrival,
    file: r.file,
    movement: r.movement,
    deliveryId: r.delivery_id,
    edge: r.edge,
    recordId: r.record_id,
    reason: r.reason,
    cause: r.cause,
    at: r.at,
    attempt: r.attempt,
  }));
}
