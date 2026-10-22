// An lf run's live state (parks.*, joins.*, correlations.*, leases.*,
// sources.*), ported from pg_store.rs over the platform's tables of the same
// shapes. The run lease is a fence on every live-state write: a write naming
// the token it holds lands only while the run is still leased to it. Every
// statement reaches a row only through a run that is one of the tenant's lf
// runs.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { sql } from 'kysely';
import { neverAsAny } from 'movement-engine/public/types';

import { markParked } from './runs';
import { enqueueRow } from './work';
import {
  inTransaction,
  iso,
  leaseLost,
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
  const { rows } = await sql<{ reason: string; state: unknown }>`
    update automations.parked_run p set status = 'resuming', updated_at = now()
    where p.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'p.run_id')} and p.address = ${input.address}::text and p.status = 'parked'
      and (${input.reason}::text is null or p.park_reason = ${input.reason}::text)
    returning p.park_reason as reason, coalesce(p.state, 'null'::jsonb) as state`.execute(pool());
  const row = rows[0];
  return row === undefined ? null : { reason: row.reason, state: row.state };
}

export async function finishLeaf(scope: LfTenant, input: { runId: string; address: string; fence: string | null }): Promise<null> {
  await sql`
    delete from automations.parked_run p
    where p.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'p.run_id')} and p.address = ${input.address}::text and p.status = 'resuming'
      and (${input.fence}::text is null or exists (select 1 from automations.trigger_run r where r.id = p.run_id and ${leasedTo('r', input.fence ?? '')}))`.execute(pool());
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

export type ParkKind =
  | { kind: 'timer'; wakeAt: string }
  | { kind: 'await'; teamId: string; adapterType: string; correlationKey: string }
  | { kind: 'limit' };

/**
 * One park, kept as one with what wakes it: the leaf; for a timer the run's
 * `resume_timer` row, for an await its correlation, for a limit the address's
 * correlation dropped; and the run marked parked. A fenced one holds the run's
 * row for the transaction, so the lease cannot change hands between the check
 * and the writes. A lost fence writes nothing.
 */
export async function commitPark(
  scope: LfTenant,
  input: { runId: string; address: string; state: unknown; fence: string | null; park: ParkKind },
): Promise<null> {
  const { runId, address, state, fence, park } = input;
  if (park.kind === 'await') refuseAnotherTenant(scope, park.teamId);
  await inTransaction(async (trx) => {
    if (fence !== null) {
      const { rows } = await sql<{ id: string }>`
        select r.id::text as id from automations.trigger_run r
        where r.id = ${runId}::uuid and ${lfRunRow(scope, 'r')} and ${leasedTo('r', fence)} for update`.execute(trx);
      if (rows.length === 0) throw leaseLost(runId);
    }
    await putLeaf(trx, scope, { runId, address, reason: park.kind, wakeAt: park.kind === 'timer' ? park.wakeAt : null, state, fence });
    switch (park.kind) {
      case 'timer':
        // The leaf is the truth; the work row only says when to look.
        await enqueueRow(trx, { kind: 'resume_timer', key: `resume_timer:${runId}`, payload: { runId }, dueAt: park.wakeAt, teamId: scope.tenant });
        break;
      case 'await':
        await correlateRow(trx, scope, { runId, teamId: park.teamId, address, adapterType: park.adapterType, correlationKey: park.correlationKey });
        break;
      case 'limit':
        await dropCorrelationRow(trx, scope, { runId, address });
        break;
      default:
        neverAsAny(park);
    }
    await markParked(trx, scope, runId);
  });
  return null;
}

// ── Joins ───────────────────────────────────────────────────────────────────

export async function recordJoin(
  scope: LfTenant,
  input: { runId: string; frameAddress: string; pending: number; fence: string | null },
): Promise<null> {
  const { rows } = await sql<{ run_id: string }>`
    insert into automations.join_pending (run_id, frame_address, pending)
    select r.id, ${input.frameAddress}::text, ${input.pending}::int from automations.trigger_run r
    where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')} and (${input.fence}::text is null or ${leasedTo('r', input.fence ?? '')})
    on conflict (run_id, frame_address) do update set pending = excluded.pending, updated_at = now()
    returning run_id::text`.execute(pool());
  if (rows.length === 0) throw notWritten(input.runId, input.fence);
  return null;
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
  });
  return null;
}

// ── Await correlations ──────────────────────────────────────────────────────

interface Correlate {
  runId: string;
  teamId: string;
  address: string;
  adapterType: string;
  correlationKey: string;
}

async function correlateRow(exec: Exec, scope: LfTenant, input: Correlate): Promise<void> {
  const { rows } = await sql`
    insert into automations.adapter_await (adapter_type, correlation_key, run_id, team_id, address)
    select ${input.adapterType}::text, ${input.correlationKey}::text, r.id, ${input.teamId}::uuid, ${input.address}::text
    from automations.trigger_run r where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')}
    on conflict (run_id, address) do update set
      adapter_type = excluded.adapter_type, correlation_key = excluded.correlation_key, updated_at = now()
    returning 1`.execute(exec);
  if (rows.length === 0) throw notThisTenantsRun(input.runId);
}

export async function correlate(scope: LfTenant, input: Correlate): Promise<null> {
  refuseAnotherTenant(scope, input.teamId);
  await correlateRow(pool(), scope, input);
  return null;
}

/** The tenant's lf runs waiting on a key; another team's answers none. The
 *  platform's own awaits are the platform's to wake. */
export async function correlated(
  scope: LfTenant,
  input: { adapterType: string; teamId: string; correlationKey: string },
): Promise<{ runId: string; teamId: string; address: string }[]> {
  if (!namesTenant(scope, input.teamId)) return [];
  const { rows } = await sql<{ run_id: string; team_id: string; address: string }>`
    select a.run_id::text as run_id, a.team_id::text as team_id, a.address from automations.adapter_await a
    join automations.trigger_run r on r.id = a.run_id
    where ${lfRunRow(scope, 'r')} and a.adapter_type = ${input.adapterType}::text and a.team_id = ${input.teamId}::uuid
      and a.correlation_key = ${input.correlationKey}::text
    order by a.created_at`.execute(pool());
  return rows.map((r) => ({ runId: r.run_id, teamId: r.team_id, address: r.address }));
}

export async function ofRun(
  scope: LfTenant,
  input: { runId: string; adapterType: string },
): Promise<{ runId: string; teamId: string; address: string; correlationKey: string }[]> {
  const { rows } = await sql<{ run_id: string; team_id: string; address: string; correlation_key: string }>`
    select a.run_id::text as run_id, a.team_id::text as team_id, a.address, a.correlation_key from automations.adapter_await a
    where a.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'a.run_id')} and a.adapter_type = ${input.adapterType}::text
    order by a.address`.execute(pool());
  return rows.map((r) => ({ runId: r.run_id, teamId: r.team_id, address: r.address, correlationKey: r.correlation_key }));
}

async function dropCorrelationRow(exec: Exec, scope: LfTenant, input: { runId: string; address: string }): Promise<void> {
  await sql`
    delete from automations.adapter_await a
    where a.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'a.run_id')} and a.address = ${input.address}::text`.execute(exec);
}

export async function dropCorrelation(scope: LfTenant, input: { runId: string; address: string }): Promise<null> {
  await dropCorrelationRow(pool(), scope, input);
  return null;
}

export async function dropRunCorrelations(scope: LfTenant, input: { runId: string }): Promise<null> {
  await sql`
    delete from automations.adapter_await a where a.run_id = ${input.runId}::uuid and ${lfRunOf(scope, 'a.run_id')}`.execute(pool());
  return null;
}

// ── The run lease ───────────────────────────────────────────────────────────

/** One statement: taken only while free or lapsed, stamping the run's
 *  heartbeat, and in the same statement every leaf a dead holder left
 *  claimed goes back to parked. */
export async function claimLease(scope: LfTenant, input: { runId: string; ttlMs: number }): Promise<{ token: string } | null> {
  const token = randomUUID();
  const { rows } = await sql<{ id: string }>`
    with claimed as (
      update automations.trigger_run r
      set lease_owner = ${LEASE_OWNER}::text, lease_until = now() + ${input.ttlMs}::int8 * interval '1 millisecond',
          lease_token = ${token}::uuid, last_heartbeat_at = now()
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
