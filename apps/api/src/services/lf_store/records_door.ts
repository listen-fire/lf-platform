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
  /** The module the arrival came from; null on a fact kept before it was kept. */
  adapter: string | null;
  recordId: string | null;
  /** What landed, as its module reported it: `@lf/system` knows its own
   *  `Arrival Not Judged` events by it. */
  landing: unknown;
  reason: string;
  cause: string | null;
  at: string;
  /** 0 as delivered, one more for each replay of it through the listen. */
  attempt: number;
  /** Its listen waits on it: the host function its filter asks could not be
   *  reached, or an earlier arrival waits. Absent: it does not. */
  waiting?: boolean;
}

/** Kept once per listen, arrival and attempt: whether this is the first. */
export async function keepUnjudgedIn(exec: Exec, scope: LfTenant, fact: UnjudgedArrival): Promise<boolean> {
  const { rows } = await sql`
    insert into automations.arrival_unjudged
      (team_id, pipeline, arrival, file, movement, delivery_id, edge, adapter, record_id, landing, reason, cause, noted_at, attempt, waiting)
    values (${scope.tenant}::uuid, ${fact.pipeline}::text, ${fact.arrival}::text, ${fact.file}::text, ${fact.movement}::text,
            ${fact.deliveryId}::text, ${fact.edge}::text, ${fact.adapter}::text, ${fact.recordId}::text,
            ${fact.landing === null || fact.landing === undefined ? null : JSON.stringify(fact.landing)}::text::jsonb, ${fact.reason}::text, ${fact.cause}::text,
            date_trunc('milliseconds', ${fact.at}::timestamptz), ${fact.attempt}::int4, ${fact.waiting === true}::bool)
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

interface UnjudgedRow {
  pipeline: string;
  arrival: string;
  file: string;
  movement: string;
  delivery_id: string | null;
  edge: string;
  adapter: string | null;
  record_id: string | null;
  landing: unknown;
  reason: string;
  cause: string | null;
  at: string;
  attempt: number;
  waiting: boolean;
}

const UNJUDGED_COLUMNS = (alias: string) =>
  sql.raw(
    ['pipeline', 'arrival', 'file', 'movement', 'delivery_id', 'edge', 'adapter', 'record_id', 'landing', 'reason', 'cause', 'attempt', 'waiting']
      .map((column) => `${alias}.${column}`)
      .join(', '),
  );

function unjudgedOf(row: UnjudgedRow): UnjudgedArrival {
  return {
    pipeline: row.pipeline,
    arrival: row.arrival,
    file: row.file,
    movement: row.movement,
    deliveryId: row.delivery_id,
    edge: row.edge,
    adapter: row.adapter,
    recordId: row.record_id,
    landing: row.landing ?? null,
    reason: row.reason,
    cause: row.cause,
    at: row.at,
    attempt: row.attempt,
    waiting: row.waiting,
  };
}

/** The facts kept after the one `after` names (one no longer kept: from its
 *  `at` on), only the listen `pipeline`'s when it names one, only those that
 *  wait when `waiting` is, oldest first; those found at one instant in the
 *  order they were kept, which for arrivals held behind another is the order
 *  they came (their receipt keys as text are not: `m10` before `m9`). */
export async function unjudged(
  scope: LfTenant,
  input: {
    after: { at: string; pipeline: string; arrival: string; attempt: number } | null;
    pipeline: string | null;
    waiting?: boolean;
    limit: number;
  },
): Promise<UnjudgedArrival[]> {
  const { after } = input;
  const { rows } = await sql<UnjudgedRow>`
    select ${UNJUDGED_COLUMNS('u')}, ${iso('u.noted_at')} as at
    from automations.arrival_unjudged u
    where u.team_id = ${scope.tenant}::uuid and (${input.pipeline}::text is null or u.pipeline = ${input.pipeline}::text)
      and (not ${input.waiting === true}::bool or u.waiting)
      ${
        after === null
          ? sql``
          : sql`and (u.noted_at, u.kept_order) > (${after.at}::timestamptz, coalesce((
              select a.kept_order from automations.arrival_unjudged a
              where a.team_id = ${scope.tenant}::uuid and a.pipeline = ${after.pipeline}::text and a.arrival = ${after.arrival}::text and a.attempt = ${after.attempt}::int4
                and a.noted_at = ${after.at}::timestamptz), 0))`
      }
    order by u.noted_at, u.kept_order limit ${input.limit}::int8`.execute(pool());
  return rows.map(unjudgedOf);
}

// ── What a listen waits on ──────────────────────────────────────────────────

/** Which of `pipelines` wait on an arrival they could not judge yet. */
export async function waitingListens(scope: LfTenant, pipelines: readonly string[]): Promise<Set<string>> {
  if (pipelines.length === 0) return new Set();
  const { rows } = await sql<{ pipeline: string }>`
    select distinct u.pipeline from automations.arrival_unjudged u
    where u.team_id = ${scope.tenant}::uuid and u.pipeline = any(${[...pipelines]}::text[]) and u.waiting`.execute(pool());
  return new Set(rows.map((row) => row.pipeline));
}

/** What the listen `pipeline` waits on, oldest first: each arrival once, by
 *  the first fact that waits on it, in the order the facts were kept. */
export async function waitingLine(scope: LfTenant, pipeline: string): Promise<UnjudgedArrival[]> {
  const { rows } = await sql<UnjudgedRow>`
    select ${UNJUDGED_COLUMNS('f')}, ${iso('f.noted_at')} as at
    from (
      select distinct on (u.arrival) u.*
      from automations.arrival_unjudged u
      where u.team_id = ${scope.tenant}::uuid and u.pipeline = ${pipeline}::text and u.waiting
      order by u.arrival, u.noted_at, u.kept_order
    ) f
    order by f.noted_at, f.kept_order`.execute(pool());
  return rows.map(unjudgedOf);
}

/** The listen `pipeline` no longer waits on `arrivals` (each judged, or let
 *  go); none named, on anything. */
export async function stopWaiting(exec: Exec, scope: LfTenant, input: { pipeline: string; arrivals?: readonly string[] }): Promise<void> {
  const { arrivals } = input;
  if (arrivals !== undefined && arrivals.length === 0) return;
  await sql`
    update automations.arrival_unjudged set waiting = false
    where team_id = ${scope.tenant}::uuid and pipeline = ${input.pipeline}::text and waiting
      and (${arrivals === undefined}::bool or arrival = any(${arrivals === undefined ? [] : [...arrivals]}::text[]))`.execute(exec);
}

/** `unjudged.judged`: the listen `pipeline` judged `arrival` since, so none of
 *  its facts waits any more (each is kept, not waiting). */
export async function judgedUnjudged(scope: LfTenant, input: { pipeline: string; arrival: string }): Promise<null> {
  await stopWaiting(pool(), scope, { pipeline: input.pipeline, arrivals: [input.arrival] });
  return null;
}

/** The listen `pipeline` judged `arrivals` it waited on, each to run or not:
 *  their facts are forgotten, so what the team sees of each is its run, or
 *  nothing, never a judgement it no longer stands by. An arrival it never
 *  waited on keeps its facts (a replay's history). */
export async function forgetJudged(exec: Exec, scope: LfTenant, input: { pipeline: string; arrivals: readonly string[] }): Promise<void> {
  if (input.arrivals.length === 0) return;
  await sql`
    delete from automations.arrival_unjudged u
    where u.team_id = ${scope.tenant}::uuid and u.pipeline = ${input.pipeline}::text and u.arrival = any(${[...input.arrivals]}::text[])
      and exists (
        select 1 from automations.arrival_unjudged w
        where w.team_id = u.team_id and w.pipeline = u.pipeline and w.arrival = u.arrival and w.waiting)`.execute(exec);
}
