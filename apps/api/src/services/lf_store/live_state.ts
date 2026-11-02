// An lf run's live state (parks.*, joins.*, leases.*, sources.*), ported from
// pg_store.rs over the platform's tables of the same shapes; a wait's park and
// notes are the in-process store's own statements (run_host_waits.ts). The run
// lease is a fence on every live-state write: a write naming the token it
// holds lands only while the run is still leased to it. Every statement
// reaches a row only through a run that is one of the tenant's lf runs.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { sql } from 'kysely';
import {
  RESUME_TIMER_WORK_KIND,
  SETTLE_RACE_WORK_KIND,
  settleRaceWorkKey,
  timerWorkKey,
  type WaitWake,
} from 'movement-engine/public/run-host';
import { neverAsAny } from 'movement-engine/public/types';
import { z } from 'zod';

import { queueWake } from '../movement_engine/run_host_queue';
import { keepNotesOf, lockWaitEdges, parkWaitIn, unparkWaitsAt, waitArrivals } from '../movement_engine/run_host_waits';
import { markParked, settleRunIn, type RunSettle } from './runs';
import { enqueueRow, lfWorkOf, storedKey } from './work';
import {
  inTransaction,
  iso,
  leasedTo,
  lfRunOf,
  lfRunRow,
  namesTenant,
  notThisTenantsRun,
  notWritten,
  pool,
  refuseAnotherTenant,
  type Exec,
  type LfTenant,
} from './scope';

/** Who holds a run lease this process took: informational (the token fences). */
const LEASE_OWNER = `lf-store:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

// ── Parks ───────────────────────────────────────────────────────────────────

export interface PutLeaf {
  runId: string;
  address: string;
  reason: string;
  wakeAt: string | null;
  state: unknown;
  fence: string | null;
}

export async function putLeaf(exec: Exec, scope: LfTenant, input: PutLeaf): Promise<null> {
  const { rows } = await sql<{ id: string }>`
    insert into automations.parked_run (run_id, address, status, park_reason, wake_at, state)
    select r.id, ${input.address}::text, 'parked', ${input.reason}::text, ${input.wakeAt}::timestamptz, ${JSON.stringify(input.state)}::text::jsonb
    from automations.trigger_run r
    where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')} and (${input.fence}::text is null or ${leasedTo('r', input.fence ?? '')})
    on conflict (run_id, address) do update set
      state = excluded.state, status = 'parked', park_reason = excluded.park_reason, wake_at = excluded.wake_at
    returning id::text`.execute(exec);
  if (rows.length === 0) throw notWritten(input.runId, input.fence);
  return null;
}

export async function claimLeaf(
  scope: LfTenant,
  input: { runId: string; address: string; reason: string | null },
): Promise<{ reason: string; state: unknown } | null> {
  // Claiming the leaf drops the notes a segment that resumed it before made
  // and never kept (it died), so their arrivals are read again.
  const { rows } = await sql<{ reason: string; state: unknown }>`
    with claimed as (
      update automations.parked_run p set status = 'resuming', updated_at = now()
      where p.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'p.run_id')} and p.address = ${input.address}::text and p.status = 'parked'
        and (${input.reason}::text is null or p.park_reason = ${input.reason}::text)
      returning p.park_reason as reason, coalesce(p.state, 'null'::jsonb) as state
    ), dropped as (
      delete from automations.wait_seen s using automations.wait_row w
      where s.wait_id = w.id and w.run_id = ${input.runId}::uuid and s.leaf = ${input.address}::text and exists (select 1 from claimed)
    )
    select reason, state from claimed`.execute(pool());
  const row = rows[0];
  return row === undefined ? null : { reason: row.reason, state: row.state };
}

/** The leaf a segment resumed is over: deleted if resuming, and the notes the
 *  segment made kept. */
async function finishLeafIn(exec: Exec, input: { runId: string; address: string }): Promise<void> {
  await sql`
    delete from automations.parked_run where run_id = ${input.runId}::uuid and address = ${input.address}::text and status = 'resuming'`.execute(exec);
  await keepNotesOf(exec, { runId: input.runId, leaf: input.address });
}

/** The tenant's lf run held for the transaction, under `fence` when given: the
 *  lease cannot change hands between the check and the writes. */
async function holdRun(exec: Exec, scope: LfTenant, runId: string, fence: string | null): Promise<boolean> {
  const { rows } = await sql`
    select r.id from automations.trigger_run r
    where r.id = ${runId}::uuid and ${lfRunRow(scope, 'r')} and (${fence}::text is null or ${leasedTo('r', fence ?? '')}) for update`.execute(exec);
  return rows.length > 0;
}

export async function finishLeaf(scope: LfTenant, input: { runId: string; address: string; fence: string | null }): Promise<null> {
  await inTransaction(async (trx) => {
    if (await holdRun(trx, scope, input.runId, input.fence)) await finishLeafIn(trx, input);
  });
  return null;
}

export async function leaves(
  scope: LfTenant,
  input: { runId: string; parkedOnly: boolean; reason: string | null; dueBy: string | null },
): Promise<{ address: string; reason: string; status: string; wakeAt: string | null }[]> {
  const { rows } = await sql<{ address: string; reason: string; status: string; wake_at: string | null }>`
    select p.address, p.park_reason as reason, p.status, ${iso('p.wake_at')} as wake_at from automations.parked_run p
    where p.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'p.run_id')}
      and (not ${input.parkedOnly}::bool or p.status = 'parked') and (${input.reason}::text is null or p.park_reason = ${input.reason}::text)
      and (${input.dueBy}::text is null or (p.park_reason = 'timer' and p.wake_at <= ${input.dueBy}::timestamptz))
    order by p.created_at, p.address`.execute(pool());
  return rows.map((r) => ({ address: r.address, reason: r.reason, status: r.status, wakeAt: r.wake_at }));
}

export async function deleteLeaves(scope: LfTenant, input: { runId: string; addresses: string[] }): Promise<null> {
  if (input.addresses.length === 0) return null;
  await sql`
    delete from automations.parked_run p
    where p.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'p.run_id')} and p.address = any(${input.addresses}::text[])`.execute(pool());
  return null;
}

export type ParkKind = { kind: 'timer'; wakeAt: string } | { kind: 'wait'; waitId: string } | { kind: 'limit' };

/**
 * One park's leaf and what wakes it, in the caller's transaction (which holds
 * the run, and the edges of the waits it parks). Whatever parks at the
 * address now, no wait parked there before is, and the notes the segment
 * that resumed the leaf there made are kept; a timer arms the run's
 * `resume_timer` row; a wait is parked there (stranded as it parks when its
 * record is already gone; a run without the wait fails, writing nothing).
 */
async function parkIn(exec: Exec, scope: LfTenant, input: { runId: string; address: string; state: unknown; park: ParkKind }): Promise<void> {
  const { runId, address, state, park } = input;
  const reason = park.kind === 'wait' ? 'await' : park.kind;
  await putLeaf(exec, scope, { runId, address, reason, wakeAt: park.kind === 'timer' ? park.wakeAt : null, state, fence: null });
  await unparkWaitsAt(exec, { runId, address });
  switch (park.kind) {
    case 'timer':
      // The leaf is the truth; the work row only says when to look.
      await enqueueRow(exec, { kind: RESUME_TIMER_WORK_KIND, key: timerWorkKey(runId), payload: { runId }, dueAt: park.wakeAt, teamId: scope.tenant });
      return;
    case 'wait':
      await parkWaitIn(exec, { runId, waitId: park.waitId, address });
      return;
    case 'limit':
      return;
    default:
      neverAsAny(park);
  }
}

function waitsOf(parks: readonly { park: ParkKind }[]): string[] {
  return parks.flatMap(({ park }) => (park.kind === 'wait' ? [park.waitId] : []));
}

/**
 * One park, kept as one with what wakes it, and the run marked parked. A
 * fenced one holds the run's row for the transaction; a lost fence writes
 * nothing. A wait's park takes its record's edge as a log does, so the two
 * never interleave.
 */
export async function commitPark(
  scope: LfTenant,
  input: { runId: string; address: string; state: unknown; fence: string | null; park: ParkKind },
): Promise<null> {
  const { runId, fence } = input;
  await inTransaction(async (trx) => {
    if (!(await holdRun(trx, scope, runId, fence))) throw notWritten(runId, fence);
    await lockWaitEdges(trx, runId, waitsOf([input]));
    await parkIn(trx, scope, input);
    await markParked(trx, scope, runId);
  });
  return null;
}

export interface SegmentCommit {
  runId: string;
  teamId: string;
  fence: string | null;
  resumed: string | null;
  joins: { frameAddress: string; pending: number }[];
  parks: { address: string; state: unknown; park: ParkKind }[];
  settle: RunSettle | null;
  owedRaces: { frameAddress: string; state: unknown }[];
  settledRace: string | null;
}

/**
 * A segment's held writes in one: its joins, its parks, the end of the leaf
 * it resumed (unless it parks there again), the run marked parked, its
 * settle, the race it settled and the races it owes. Each wait it parks whose
 * arrivals are unread, read in the write, gets a wake: the wakes it answers.
 */
export async function commitSegment(scope: LfTenant, input: SegmentCommit): Promise<WaitWake[]> {
  const { runId, fence, resumed, parks } = input;
  refuseAnotherTenant(scope, input.teamId);
  return inTransaction(async (trx) => {
    if (!(await holdRun(trx, scope, runId, fence))) throw notWritten(runId, fence);
    await lockWaitEdges(trx, runId, waitsOf(parks));
    for (const join of input.joins) await recordJoinIn(trx, scope, { runId, ...join, fence: null });
    for (const park of parks) await parkIn(trx, scope, { runId, ...park });
    if (resumed !== null && !parks.some((park) => park.address === resumed)) await finishLeafIn(trx, { runId, address: resumed });
    if (parks.length > 0) await markParked(trx, scope, runId);
    if (input.settle !== null) await settleRunIn(trx, scope, { runId, ...input.settle });
    if (input.settledRace !== null) {
      await sql`
        delete from automations.work work
        where ${lfWorkOf(scope, 'work')} and work.key = ${storedKey(scope.tenant, settleRaceWorkKey(runId, input.settledRace))}::text`.execute(trx);
    }
    for (const race of input.owedRaces) {
      await enqueueRow(trx, {
        kind: SETTLE_RACE_WORK_KIND,
        key: settleRaceWorkKey(runId, race.frameAddress),
        payload: { runId, frameAddress: race.frameAddress, state: race.state },
        dueAt: null,
        teamId: scope.tenant,
      });
    }
    // Read in the write: an arrival logged before it is read here, and one
    // logged after it finds the wait parked.
    const wakes: WaitWake[] = [];
    for (const { address, park } of parks) {
      if (park.kind !== 'wait') continue;
      const { arrivals } = await waitArrivals(trx, park.waitId);
      if (arrivals.length === 0) continue;
      const wake = { runId, waitId: park.waitId, address };
      await queueWake(trx, scope.tenant, wake);
      wakes.push(wake);
    }
    return wakes;
  });
}

const OwedRacePayload = z.object({ runId: z.string(), frameAddress: z.string(), state: z.unknown() });

/** The run's `settle_race` rows' payloads, oldest first. */
export async function owedRaces(scope: LfTenant, input: { runId: string }): Promise<{ frameAddress: string; state: unknown }[]> {
  const { rows } = await sql<{ payload: unknown }>`
    select work.payload from automations.work work
    where ${lfWorkOf(scope, 'work')} and work.kind = ${SETTLE_RACE_WORK_KIND}::text and work.payload->>'runId' = ${input.runId}::text
    order by work.created_at, work.key`.execute(pool());
  return rows.map(({ payload }) => {
    const race = OwedRacePayload.parse(payload);
    return { frameAddress: race.frameAddress, state: race.state ?? null };
  });
}

// ── Joins ───────────────────────────────────────────────────────────────────

export async function recordJoin(
  scope: LfTenant,
  input: { runId: string; frameAddress: string; pending: number; fence: string | null },
): Promise<null> {
  await recordJoinIn(pool(), scope, input);
  return null;
}

async function recordJoinIn(
  exec: Exec,
  scope: LfTenant,
  input: { runId: string; frameAddress: string; pending: number; fence: string | null },
): Promise<void> {
  const { rows } = await sql<{ run_id: string }>`
    insert into automations.join_pending (run_id, frame_address, pending)
    select r.id, ${input.frameAddress}::text, ${input.pending}::int from automations.trigger_run r
    where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')} and (${input.fence}::text is null or ${leasedTo('r', input.fence ?? '')})
    on conflict (run_id, frame_address) do update set pending = excluded.pending, updated_at = now()
    returning run_id::text`.execute(exec);
  if (rows.length === 0) throw notWritten(input.runId, input.fence);
}

/** Whether the run is one of the tenant's lf runs. A run's team and host never
 *  change, so a transaction may ask once and write by the run id after. */
async function isLfRun(exec: Exec, scope: LfTenant, runId: string): Promise<boolean> {
  const { rows } = await sql`select 1 from automations.trigger_run r where r.id = ${runId}::uuid and ${lfRunRow(scope, 'r')}`.execute(exec);
  return rows.length > 0;
}

/** The mark-closed decrement: each branch claims its one decrement against
 *  its own export row, and the closer's address is kept on the frame, so a
 *  retry of the closer closes again and a sibling never does. */
export async function decrementJoin(
  scope: LfTenant,
  input: { runId: string; frameAddress: string; branchAddress: string; leafAddress: string },
): Promise<{ closed: boolean }> {
  const { runId, frameAddress, branchAddress, leafAddress } = input;
  return inTransaction(async (trx) => {
    if (!(await isLfRun(trx, scope, runId))) return { closed: false };
    const { rows: claimed } = await sql`
      update automations.join_branch_export set decremented = true
      where run_id = ${runId}::uuid and frame_address = ${frameAddress}::text and branch_address = ${branchAddress}::text and decremented = false
      returning 1`.execute(trx);
    if (claimed.length > 0) {
      const { rows: updated } = await sql<{ pending: number }>`
        update automations.join_pending set pending = pending - 1, updated_at = now()
        where run_id = ${runId}::uuid and frame_address = ${frameAddress}::text and pending > 0
        returning pending`.execute(trx);
      const left = updated[0];
      if (left !== undefined) {
        if (left.pending > 0) return { closed: false };
        await sql`
          update automations.join_pending set closed_by_address = ${leafAddress}::text
          where run_id = ${runId}::uuid and frame_address = ${frameAddress}::text`.execute(trx);
        return { closed: true };
      }
    }
    const { rows } = await sql<{ closed_by_address: string | null }>`
      select closed_by_address from automations.join_pending where run_id = ${runId}::uuid and frame_address = ${frameAddress}::text`.execute(trx);
    return { closed: rows[0]?.closed_by_address === leafAddress };
  });
}

/** The conflict update never touches `decremented`: a re-persist would
 *  otherwise reset the branch's decrement claim. */
export async function persistBranchExport(
  scope: LfTenant,
  input: { runId: string; frameAddress: string; branchAddress: string; branchIndex: number; exports: unknown },
): Promise<null> {
  const { rows } = await sql`
    insert into automations.join_branch_export (run_id, frame_address, branch_address, branch_index, exports)
    select r.id, ${input.frameAddress}::text, ${input.branchAddress}::text, ${input.branchIndex}::int, ${JSON.stringify(input.exports)}::text::jsonb
    from automations.trigger_run r where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')}
    on conflict (run_id, frame_address, branch_address) do update set
      exports = excluded.exports, branch_index = excluded.branch_index, updated_at = now()
    returning 1`.execute(pool());
  if (rows.length === 0) throw notThisTenantsRun(input.runId);
  return null;
}

export async function collectBranchExports(
  scope: LfTenant,
  input: { runId: string; frameAddress: string },
): Promise<{ branchAddress: string; branchIndex: number; exports: unknown }[]> {
  const { rows } = await sql<{ branch_address: string; branch_index: number; exports: unknown }>`
    select e.branch_address, e.branch_index, e.exports from automations.join_branch_export e
    where e.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'e.run_id')} and e.frame_address = ${input.frameAddress}::text
    order by e.branch_index`.execute(pool());
  return rows.map((r) => ({ branchAddress: r.branch_address, branchIndex: r.branch_index, exports: r.exports }));
}

export async function hasPendingJoins(scope: LfTenant, input: { runId: string }): Promise<boolean> {
  const { rows } = await sql`
    select 1 from automations.join_pending j
    where j.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'j.run_id')} and j.pending > 0 limit 1`.execute(pool());
  return rows.length > 0;
}

export async function frames(scope: LfTenant, input: { runId: string }): Promise<string[]> {
  const { rows } = await sql<{ frame_address: string }>`
    select j.frame_address from automations.join_pending j
    where j.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'j.run_id')} order by j.frame_address`.execute(pool());
  return rows.map((r) => r.frame_address);
}

export async function deleteFrames(scope: LfTenant, input: { runId: string; frameAddresses: string[] }): Promise<null> {
  if (input.frameAddresses.length === 0) return null;
  await inTransaction(async (trx) => {
    await sql`
      delete from automations.join_pending j
      where j.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'j.run_id')} and j.frame_address = any(${input.frameAddresses}::text[])`.execute(trx);
    await sql`
      delete from automations.join_branch_export e
      where e.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'e.run_id')} and e.frame_address = any(${input.frameAddresses}::text[])`.execute(trx);
    // A race inside an arm another race withdrew is settled by nobody.
    const owed = input.frameAddresses.map((frame) => storedKey(scope.tenant, settleRaceWorkKey(input.runId, frame)));
    await sql`delete from automations.work work where ${lfWorkOf(scope, 'work')} and work.key = any(${owed}::text[])`.execute(trx);
  });
  return null;
}

// ── The run lease ───────────────────────────────────────────────────────────

/** One statement: taken only while free or lapsed, stamping the run's
 *  heartbeat and keeping the arrival mark as it is claimed (while the lease
 *  is unexpired the sweep keeps every arrival above it), and in the same
 *  statement every leaf a dead holder left claimed goes back to parked. */
export async function claimLease(scope: LfTenant, input: { runId: string; ttlMs: number }): Promise<{ token: string } | null> {
  const token = randomUUID();
  const { rows } = await sql<{ id: string }>`
    with claimed as (
      update automations.trigger_run r
      set lease_owner = ${LEASE_OWNER}::text, lease_until = now() + ${input.ttlMs}::int8 * interval '1 millisecond',
          lease_token = ${token}::uuid, last_heartbeat_at = now(),
          lease_mark = (select coalesce(max(seq), 0) from automations.arrival)
      where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')} and (r.lease_until is null or r.lease_until < now())
      returning r.id
    ), returned as (
      update automations.parked_run set status = 'parked'
      where run_id in (select id from claimed) and status = 'resuming'
    )
    select id::text from claimed`.execute(pool());
  return rows.length === 0 ? null : { token };
}

/** Also the run's heartbeat. A lapsed lease is not renewed: it is free. */
export async function renewLease(scope: LfTenant, input: { runId: string; token: string; ttlMs: number }): Promise<boolean> {
  const { rows } = await sql`
    update automations.trigger_run r set lease_until = now() + ${input.ttlMs}::int8 * interval '1 millisecond', last_heartbeat_at = now()
    where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')} and ${leasedTo('r', input.token)} and r.lease_until > now()
    returning 1`.execute(pool());
  return rows.length > 0;
}

export async function releaseLease(scope: LfTenant, input: { runId: string; token: string }): Promise<null> {
  await sql`
    update automations.trigger_run r set lease_owner = null, lease_until = null, lease_token = null
    where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')} and ${leasedTo('r', input.token)}`.execute(pool());
  return null;
}

/** The run's leaves, joins, waits (with their notes) and owed races. */
export async function dropRunState(scope: LfTenant, input: { runId: string; fence: string | null }): Promise<boolean> {
  const { runId, fence } = input;
  return inTransaction(async (trx) => {
    if (fence !== null) {
      // Held for the transaction: the lease cannot change hands between the
      // check and the deletes.
      const { rows } = await sql`
        select r.id from automations.trigger_run r
        where r.id = ${runId}::uuid and ${lfRunRow(scope, 'r')} and ${leasedTo('r', fence)} for update`.execute(trx);
      if (rows.length === 0) return false;
    }
    await sql`delete from automations.parked_run t where t.run_id = ${runId}::uuid and ${lfRunOf(scope, 't.run_id')}`.execute(trx);
    await sql`delete from automations.join_pending t where t.run_id = ${runId}::uuid and ${lfRunOf(scope, 't.run_id')}`.execute(trx);
    await sql`delete from automations.join_branch_export t where t.run_id = ${runId}::uuid and ${lfRunOf(scope, 't.run_id')}`.execute(trx);
    await sql`delete from automations.wait_row t where t.run_id = ${runId}::uuid and ${lfRunOf(scope, 't.run_id')}`.execute(trx);
    await sql`
      delete from automations.work work
      where ${lfWorkOf(scope, 'work')} and work.kind = ${SETTLE_RACE_WORK_KIND}::text and work.payload->>'runId' = ${runId}::text`.execute(trx);
    return true;
  });
}

// ── Library sources ─────────────────────────────────────────────────────────

export async function putSource(scope: LfTenant, input: { teamId: string; hash: string; source: string }): Promise<null> {
  refuseAnotherTenant(scope, input.teamId);
  await sql`
    insert into automations.park_library_source (team_id, hash, source) values (${input.teamId}::uuid, ${input.hash}::text, ${input.source}::text)
    on conflict (team_id, hash) do nothing`.execute(pool());
  return null;
}

export async function getSource(scope: LfTenant, input: { teamId: string; hash: string }): Promise<string | null> {
  if (!namesTenant(scope, input.teamId)) return null;
  const { rows } = await sql<{ source: string }>`
    select source from automations.park_library_source where team_id = ${input.teamId}::uuid and hash = ${input.hash}::text`.execute(pool());
  return rows[0]?.source ?? null;
}
