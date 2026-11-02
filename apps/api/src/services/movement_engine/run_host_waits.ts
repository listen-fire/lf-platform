// A run's waits on listenable edges, and the arrival log they read
// (listen-fire 0.13's `waits.*`, docs/contracts/store-slot.md), over
// automations.arrival, arrival_identity, wait_row and wait_seen. Ported from
// @lf/postgres-store (crates/lf/src/pg_store.rs) so the engine's
// store-waits cases hold both stores to one meaning.
//
// Every arrival a module reports is logged under a store-wide increasing seq;
// a wait reads those logged on its record's edge after the mark it opened at.
// Logging on a record's edge and parking a wait there take one lock
// (automations.lock_wait_key), so either the log sees the park and wakes it,
// or the park commits after the log and its read of the wait's arrivals sees
// the arrival.

import { sql } from 'kysely';
import { RunLeaseLost } from 'movement-engine/public/errors';

import type {
  DeliveryArrivals,
  DeliveryWait,
  ListedArrival,
  StrandedOf,
  StrandedWait,
  WaitWake,
} from 'movement-engine/public/run-host';

import { type Exec } from './run_host_queue';

/** Whose stranded waits a page reads: the platform's runs, or one team's lf runs. */
export type RunScope = { host: 'platform' } | { host: 'lf'; teamId: string };

/** An instant as `Date.toISOString` writes it, by the database's clock.
 *  `column` is always a constant of this module. */
function iso(column: string) {
  return sql<string>`to_char(${sql.raw(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** A bigint column as the driver hands it back (text), as a number. */
function seqOf(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/** The latest seq logged (0 for none). Every log after this answer logs above it. */
export async function arrivalMark(exec: Exec): Promise<number> {
  const { rows } = await sql<{ mark: string }>`select coalesce(max(seq), 0)::text as mark from automations.arrival`.execute(exec);
  return seqOf(rows[0]?.mark ?? 0);
}

/** Each record's edge locked once, in one order, so two writers never wait on each other. */
async function lockEdges(exec: Exec, edges: ReadonlyArray<{ teamId: string; adapterType: string; edge: string; key: string }>): Promise<void> {
  const seen = new Map<string, (typeof edges)[number]>();
  for (const edge of edges) seen.set(JSON.stringify([edge.teamId, edge.adapterType, edge.edge, edge.key]), edge);
  for (const name of [...seen.keys()].sort()) {
    const edge = seen.get(name);
    if (edge === undefined) continue;
    await sql`select automations.lock_wait_key(${edge.teamId}::uuid, ${edge.adapterType}::text, ${edge.edge}::text, ${edge.key}::text)`.execute(exec);
  }
}

/** The edges of the run's waits among `waitIds`, locked as a log locks them. */
export async function lockWaitEdges(exec: Exec, runId: string, waitIds: readonly string[]): Promise<void> {
  if (waitIds.length === 0) return;
  const { rows } = await sql<{ team_id: string; adapter_type: string; edge: string; key: string }>`
    select team_id::text, adapter_type, edge, key from automations.wait_row
    where id::text = any(${[...waitIds]}::text[]) and run_id = ${runId}::uuid and key is not null`.execute(exec);
  await lockEdges(
    exec,
    rows.map((r) => ({ teamId: r.team_id, adapterType: r.adapter_type, edge: r.edge, key: r.key })),
  );
}

/**
 * `waits.log` inside the caller's transaction (a log's own, or a delivery's
 * keep); the wake rows are the caller's to queue. A repeat (its identity and
 * version logged on its record's edge within the re-send window) is skipped.
 * A gone arrival answers no wait: it strands the waits parked on its record,
 * once; any later report on the record clears that and wakes them.
 */
export async function logArrivalsIn(exec: Exec, log: DeliveryArrivals): Promise<{ wakes: WaitWake[]; stranded: StrandedWait[] }> {
  const { teamId, adapterType, arrivals, at, resendWindowMs } = log;
  await lockEdges(exec, arrivals.map((a) => ({ teamId, adapterType, edge: a.edge, key: a.key })));
  const wakes: WaitWake[] = [];
  let stranded: StrandedWait[] = [];
  for (const arrival of arrivals) {
    if (arrival.identity !== null) {
      const { rows: repeat } = await sql`
        select 1 from automations.arrival_identity
        where team_id = ${teamId}::uuid and adapter_type = ${adapterType}::text and edge = ${arrival.edge}::text and key = ${arrival.key}::text
          and identity = ${arrival.identity}::text and version is not distinct from ${arrival.version}::text and kept_until > ${at}::timestamptz`.execute(exec);
      if (repeat.length > 0) continue;
      await sql`
        insert into automations.arrival_identity (team_id, adapter_type, edge, key, identity, version, kept_until)
        values (${teamId}::uuid, ${adapterType}::text, ${arrival.edge}::text, ${arrival.key}::text, ${arrival.identity}::text,
                ${arrival.version}::text, ${at}::timestamptz + ${resendWindowMs}::int8 * interval '1 millisecond')`.execute(exec);
    }
    const landing = arrival.landing === null || arrival.landing === undefined ? null : JSON.stringify(arrival.landing);
    await sql`
      insert into automations.arrival (team_id, adapter_type, edge, key, identity, version, landing, gone, logged_at)
      values (${teamId}::uuid, ${adapterType}::text, ${arrival.edge}::text, ${arrival.key}::text, ${arrival.identity}::text,
              ${arrival.version}::text, ${landing}::text::json, ${arrival.gone}::bool, ${at}::timestamptz)`.execute(exec);
    if (arrival.gone) {
      const { rows } = await sql<StrandedRow>`
        update automations.wait_row w set stranded_at = date_trunc('milliseconds', ${at}::timestamptz)
        where w.team_id = ${teamId}::uuid and w.adapter_type = ${adapterType}::text and w.edge = ${arrival.edge}::text and w.key = ${arrival.key}::text
          and w.stranded_at is null and w.address is not null
          and exists (select 1 from automations.parked_run p where p.run_id = w.run_id and p.address = w.address)
        returning w.id::text as wait_id, w.run_id::text as run_id, w.adapter_type, w.edge, w.key, w.record_id, ${iso('w.stranded_at')} as at, true as parked`.execute(exec);
      stranded.push(...rows.map(strandedOf));
      continue;
    }
    // The newest report on a record wins: one after a gone one says the
    // record is back (or never went).
    const { rows: unstranded } = await sql<{ id: string }>`
      update automations.wait_row w set stranded_at = null
      where w.team_id = ${teamId}::uuid and w.adapter_type = ${adapterType}::text and w.edge = ${arrival.edge}::text and w.key = ${arrival.key}::text
        and w.stranded_at is not null
      returning w.id::text as id`.execute(exec);
    stranded = stranded.filter((wait) => !unstranded.some((r) => r.id === wait.waitId));
    // A wait whose park has finished needs no wake: its leaf is gone.
    const { rows: answered } = await sql<{ run_id: string; id: string; address: string }>`
      select w.run_id::text as run_id, w.id::text as id, w.address from automations.wait_row w
      where w.team_id = ${teamId}::uuid and w.adapter_type = ${adapterType}::text and w.edge = ${arrival.edge}::text and w.key = ${arrival.key}::text
        and w.address is not null
        and exists (select 1 from automations.parked_run p where p.run_id = w.run_id and p.address = w.address)
      order by w.run_id, w.id`.execute(exec);
    for (const row of answered) {
      if (!wakes.some((w) => w.waitId === row.id)) wakes.push({ runId: row.run_id, waitId: row.id, address: row.address });
    }
  }
  stranded.sort((a, b) => (a.at === b.at ? a.waitId.localeCompare(b.waitId) : a.at < b.at ? -1 : 1));
  return { wakes, stranded };
}

/**
 * A keyed wait is one per run and record's edge, a keyless one (its record
 * already gone) one per run and edge: opening either again is the first,
 * from its first mark, except that it takes the record id a delivery's open
 * left out (one it has is kept).
 */
export async function openWait(
  exec: Exec,
  input: { runId: string; teamId: string; adapterType: string; edge: string; key: string | null; recordId?: string; since: number },
): Promise<{ waitId: string }> {
  const { runId, teamId, adapterType, edge, key, since } = input;
  const recordId = input.recordId ?? null;
  await sql`
    insert into automations.wait_row (run_id, team_id, adapter_type, edge, key, since, record_id)
    values (${runId}::uuid, ${teamId}::uuid, ${adapterType}::text, ${edge}::text, ${key}::text, ${since}::int8, ${recordId}::text)
    on conflict do nothing`.execute(exec);
  await sql`
    update automations.wait_row set record_id = ${recordId}::text
    where run_id = ${runId}::uuid and team_id = ${teamId}::uuid and adapter_type = ${adapterType}::text and edge = ${edge}::text
      and key is not distinct from ${key}::text and record_id is null`.execute(exec);
  const { rows } = await sql<{ id: string }>`
    select id::text as id from automations.wait_row
    where run_id = ${runId}::uuid and team_id = ${teamId}::uuid and adapter_type = ${adapterType}::text and edge = ${edge}::text
      and key is not distinct from ${key}::text`.execute(exec);
  const row = rows[0];
  if (row === undefined) throw new Error(`run ${runId}'s wait on ${edge} of ${key ?? 'a record already gone'} was not kept`);
  return { waitId: row.id };
}

/** The waits a delivery opens for the runs it queues, from the mark before
 *  its arrivals, each with its trigger's own arrival noted as judged and not
 *  matched when this write opened it. */
export async function openDeliveryWaits(
  exec: Exec,
  input: { teamId: string; adapterType: string; waits: readonly DeliveryWait[]; since: number },
): Promise<void> {
  for (const wait of input.waits) {
    const { rows } = await sql<{ id: string }>`
      insert into automations.wait_row (run_id, team_id, adapter_type, edge, key, since, fire_key)
      values (${wait.runId}::uuid, ${input.teamId}::uuid, ${input.adapterType}::text, ${wait.edge}::text, ${wait.key}::text,
              ${input.since}::int8, ${wait.fireKey}::text)
      on conflict do nothing returning id::text as id`.execute(exec);
    const opened = rows[0];
    if (opened !== undefined && wait.preNoted !== undefined) {
      await sql`
        insert into automations.wait_seen (wait_id, identity, version, matched, leaf)
        values (${opened.id}::uuid, ${wait.preNoted.identity}::text, ${wait.preNoted.version}::text, false, null)`.execute(exec);
    }
  }
}

/** The arrivals logged after the wait's mark on its record's edge that it has
 *  not noted, in seq order, the first of each identity and version; none gone.
 *  One statement, so the wait's existence and its arrivals are read at one
 *  instant. An unknown wait fails. */
export async function waitArrivals(exec: Exec, waitId: string): Promise<{ arrivals: ListedArrival[] }> {
  const { rows } = await sql<{ seq: string | null; identity: string | null; version: string | null; landing: unknown }>`
    select a.seq::text as seq, a.identity, a.version, a.landing
    from automations.wait_row w
    left join lateral (
      select a.seq, coalesce(a.identity, '#' || a.seq::text) as identity, a.version, a.landing
      from automations.arrival a
      where a.team_id = w.team_id and a.adapter_type = w.adapter_type and a.edge = w.edge and a.key = w.key and a.seq > w.since and not a.gone
        and not exists (select 1 from automations.wait_seen s
          where s.wait_id = w.id and s.identity = coalesce(a.identity, '#' || a.seq::text) and s.version is not distinct from a.version)
        and not exists (select 1 from automations.arrival b
          where b.team_id = a.team_id and b.adapter_type = a.adapter_type and b.edge = a.edge and b.key = a.key
            and b.seq > w.since and b.seq < a.seq and not b.gone and b.identity = a.identity and b.version is not distinct from a.version)
    ) a on true
    where w.id::text = ${waitId}::text
    order by a.seq`.execute(exec);
  if (rows.length === 0) throw new Error(`no wait ${waitId}`);
  const arrivals: ListedArrival[] = [];
  for (const row of rows) {
    if (row.seq === null || row.identity === null) continue;
    arrivals.push({ seq: seqOf(row.seq), identity: row.identity, version: row.version, landing: row.landing ?? null });
  }
  return { arrivals };
}

interface StrandedRow {
  wait_id: string;
  run_id: string;
  adapter_type: string;
  edge: string;
  key: string | null;
  record_id: string | null;
  at: string;
  parked: boolean;
}

function strandedOf(row: StrandedRow): StrandedWait {
  return {
    waitId: row.wait_id,
    runId: row.run_id,
    adapterType: row.adapter_type,
    edge: row.edge,
    key: row.key,
    recordId: row.record_id,
    at: row.at,
    parked: row.parked,
  };
}

function ofScope(scope: RunScope) {
  return scope.host === 'platform' ? sql<boolean>`r.host = 'platform'` : sql<boolean>`(r.host = 'lf' and r.team_id = ${scope.teamId}::uuid)`;
}

/** The run's stranded waits, or every run's in scope a page at a time, oldest stranded first. */
export async function strandedWaits(exec: Exec, scope: RunScope, of: StrandedOf): Promise<StrandedWait[]> {
  const columns = sql`
    select w.id::text as wait_id, w.run_id::text as run_id, w.adapter_type, w.edge, w.key, w.record_id, ${iso('w.stranded_at')} as at,
      (w.address is not null and exists (select 1 from automations.parked_run p where p.run_id = w.run_id and p.address = w.address)) as parked
    from automations.wait_row w join automations.trigger_run r on r.id = w.run_id
    where w.stranded_at is not null and ${ofScope(scope)}`;
  const query =
    'runId' in of
      ? sql<StrandedRow>`${columns} and w.run_id = ${of.runId}::uuid order by w.stranded_at, w.id`
      : of.after === undefined
        ? sql<StrandedRow>`${columns} order by w.stranded_at, w.id limit ${of.limit}::int8`
        : sql<StrandedRow>`${columns} and (w.stranded_at, w.id) > (${of.after.at}::timestamptz, ${of.after.waitId}::uuid)
            order by w.stranded_at, w.id limit ${of.limit}::int8`;
  const { rows } = await query.execute(exec);
  return rows.map(strandedOf);
}

/**
 * The wait notes an arrival it judged, and whether its record matched. It
 * counts when it matched and its identity did not match at its last noted
 * arrival; one noted before answers false and changes nothing. A note under
 * a lapsed lease is refused (RunLeaseLost). Run in the caller's transaction:
 * the run's row is held before the wait's, as a park holds them.
 */
export async function noteArrivalIn(
  exec: Exec,
  input: { waitId: string; identity: string; version: string | null; matched: boolean; leaf?: string; fence?: string },
): Promise<boolean> {
  const { waitId, identity, version, matched } = input;
  const { rows: waiting } = await sql<{ run_id: string }>`
    select run_id::text as run_id from automations.wait_row where id::text = ${waitId}::text`.execute(exec);
  const runId = waiting[0]?.run_id;
  if (runId === undefined) throw new Error(`no wait ${waitId}`);
  if (input.fence !== undefined) {
    const { rows: held } = await sql`
      select id from automations.trigger_run where id = ${runId}::uuid and lease_token::text = ${input.fence}::text for update`.execute(exec);
    if (held.length === 0) throw new RunLeaseLost(runId);
  }
  // Two notes on one wait take turns.
  await sql`select id from automations.wait_row where id = ${waitId}::uuid for update`.execute(exec);
  const { rows: noted } = await sql`
    select 1 from automations.wait_seen
    where wait_id = ${waitId}::uuid and identity = ${identity}::text and version is not distinct from ${version}::text`.execute(exec);
  if (noted.length > 0) return false;
  const { rows: before } = await sql<{ matched: boolean }>`
    select matched from automations.wait_seen where wait_id = ${waitId}::uuid and identity = ${identity}::text order by id desc limit 1`.execute(exec);
  await sql`
    insert into automations.wait_seen (wait_id, identity, version, matched, leaf)
    values (${waitId}::uuid, ${identity}::text, ${version}::text, ${matched}::bool, ${input.leaf ?? null}::text)`.execute(exec);
  return matched && before[0]?.matched !== true;
}

/**
 * Forget at most `limit` arrivals, oldest first, that no live wait reads and
 * that are at or below the floor: the lowest mark an unexpired run lease kept,
 * else the latest seq, never above the caller's `floor`. A wait its run opened
 * is live while it exists (it goes with its run); one a delivery opened is
 * live while its run exists or its `fire_event` row is queued, not buried.
 * Identities past their re-send window go in the same write.
 */
export async function sweepArrivalsIn(exec: Exec, input: { limit: number; floor?: number }): Promise<number> {
  const floor = input.floor ?? null;
  const result = await sql`
    delete from automations.arrival where seq in (
      select a.seq from automations.arrival a
      where a.seq <= coalesce((select min(lease_mark) from automations.trigger_run where lease_until > now() and lease_mark is not null),
                              (select coalesce(max(seq), 0) from automations.arrival))
        and (${floor}::int8 is null or a.seq <= ${floor}::int8)
        and not exists (select 1 from automations.wait_row w
          where w.team_id = a.team_id and w.adapter_type = a.adapter_type and w.edge = a.edge and w.key = a.key and w.since < a.seq
            and (w.fire_key is null or exists (select 1 from automations.trigger_run r where r.id = w.run_id)
                 or exists (select 1 from automations.work q where q.key = w.fire_key and q.dead_at is null)))
      order by a.seq limit ${input.limit}::int8)`.execute(exec);
  await sql`
    delete from automations.arrival_identity
    where ctid in (select ctid from automations.arrival_identity where kept_until < now() limit ${input.limit}::int8)`.execute(exec);
  return Number(result.numAffectedRows ?? 0);
}

/**
 * Park the run's wait at `address`, in the caller's transaction (which holds
 * its record's edge, `lockWaitEdges`). Parked on a record already gone (the
 * newest arrival on it after its mark is gone, or it has no key), it is
 * stranded as it parks. A run with no such wait writes nothing, and fails.
 */
export async function parkWaitIn(exec: Exec, input: { runId: string; waitId: string; address: string }): Promise<void> {
  const { rows } = await sql`
    update automations.wait_row set address = ${input.address}::text
    where id::text = ${input.waitId}::text and run_id = ${input.runId}::uuid
    returning id`.execute(exec);
  if (rows.length === 0) throw new Error(`run ${input.runId} has no wait ${input.waitId}`);
  await sql`
    update automations.wait_row w set stranded_at = date_trunc('milliseconds', now())
    where w.id = ${input.waitId}::uuid and w.stranded_at is null
      and (w.key is null or coalesce((select a.gone from automations.arrival a
        where a.team_id = w.team_id and a.adapter_type = w.adapter_type and a.edge = w.edge and a.key = w.key and a.seq > w.since
        order by a.seq desc limit 1), false))`.execute(exec);
}

/** Whatever parks at `address` now, no wait parked there before is; the notes
 *  a segment that resumed the leaf there made are kept with the park. */
export async function unparkWaitsAt(exec: Exec, input: { runId: string; address: string }): Promise<void> {
  await sql`update automations.wait_row set address = null where run_id = ${input.runId}::uuid and address = ${input.address}::text`.execute(exec);
  await keepNotesOf(exec, { runId: input.runId, leaf: input.address });
}

/** The notes the run's segment that resumed `leaf` made are kept: they no longer name it. */
export async function keepNotesOf(exec: Exec, input: { runId: string; leaf: string }): Promise<void> {
  await sql`
    update automations.wait_seen s set leaf = null from automations.wait_row w
    where s.wait_id = w.id and w.run_id = ${input.runId}::uuid and s.leaf = ${input.leaf}::text`.execute(exec);
}

/** The waits a delivery opened under `fireKey` for runs that never started. */
export async function dropUnstartedWaits(exec: Exec, fireKey: string): Promise<void> {
  await sql`
    delete from automations.wait_row w
    where w.fire_key = ${fireKey}::text and not exists (select 1 from automations.trigger_run r where r.id = w.run_id)`.execute(exec);
}
