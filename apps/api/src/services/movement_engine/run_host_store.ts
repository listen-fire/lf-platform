// The hosted product's run-host backend: the core's backend families
// (movement-engine run_host/store.ts) served from Postgres. The rules that
// read and write this state are the core's; what is written here is only how
// Postgres holds it:
//
//   parks         automations.parked_run (one row per run and address)
//   joins         automations.join_pending + join_branch_export
//   waits         automations.arrival + arrival_identity + wait_row +
//                 wait_seen (run_host_waits.ts)
//   leases        the lease columns of automations.trigger_run
//   work          automations.work, through work/store.ts (the drain claims
//                 it richer than the core needs, so its queries live there)
//   sources       automations.park_library_source (one row per team and hash)
//   deliveries    automations.delivery and the rows it queues
//                 (run_host_deliveries.ts)
//
// The run lease is a fence on every live-state write: a write that names the
// token it holds lands only while the run's lease is still that token's. A
// park is kept in one write with what wakes it (a timer's row, a wait's
// park); a segment's joins, parks, finished leaf, settle and owed races are
// kept in one write (`parks.commitSegment`). Branded ids (a run's, a team's)
// are converted at this boundary only.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { sql } from 'kysely';
import { z } from 'zod';
import { RunLeaseLost } from 'movement-engine/public/errors';
import {
  RESUME_TIMER_WORK_KIND,
  SETTLE_RACE_WORK_KIND,
  settleRaceWorkKey,
  timerWorkKey,
  type DeliveryRowStore,
  type LeafRow,
  type OwedRace,
  type ParkKind,
  type RunHostStore,
  type RunSettle,
  type WaitWake,
} from 'movement-engine/public/run-host';
import { neverAsAny } from 'movement-engine/public/types';

import type { CoreParkReason, ParkReason } from 'engine-contracts';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { JoinPendingFrameAddress } from '../../generated/kysely/automations/JoinPending';
import type { JoinBranchExportFrameAddress, JoinBranchExportBranchAddress } from '../../generated/kysely/automations/JoinBranchExport';
import type { ParkLibrarySourceTeamId, ParkLibrarySourceHash } from '../../generated/kysely/automations/ParkLibrarySource';

import { getAutomationsQb } from '../../lib/kysely';
import { isWorkKind } from '../work/kinds';
import { claimDueWork, completeWork, enqueueWork, enqueueWorkIfAbsent, releaseWork } from '../work/store';
import { deliveryRowStore } from './run_host_deliveries';
import { announceQueued, inStoreTransaction, queueRow, queueWake, storeDb, workClaimOf, type Exec, type Queued } from './run_host_queue';
import {
  arrivalMark,
  keepNotesOf,
  lockWaitEdges,
  logArrivalsIn,
  noteArrivalIn,
  openWait,
  parkWaitIn,
  strandedWaits,
  sweepArrivalsIn,
  unparkWaitsAt,
  waitArrivals,
} from './run_host_waits';

type StoreDb = ReturnType<typeof storeDb>;

// ── Boundary conversions ────────────────────────────────────────────────────

/** A library source's key (a team and a sha256, plain text) as the
 *  source row's key. */
function librarySourceKeyOf(teamId: string, hash: string): { team_id: ParkLibrarySourceTeamId; hash: ParkLibrarySourceHash } {
  return { team_id: teamId as ParkLibrarySourceTeamId, hash: hash as ParkLibrarySourceHash };
}

/** A run id from the core (plain text) as the run's row id. */
export function triggerRunIdOf(runId: string): TriggerRunId {
  return runId as TriggerRunId;
}

// The join tables' address columns carry codegen brands of their own.
const frameOfJoin = (address: string) => address as JoinPendingFrameAddress;
const frameOfExport = (address: string) => address as JoinBranchExportFrameAddress;
const branchOfExport = (address: string) => address as JoinBranchExportBranchAddress;

function jsonb(value: unknown) {
  return sql<unknown>`${JSON.stringify(value ?? null)}::jsonb`;
}

// ── The run lease as a fence ────────────────────────────────────────────────

/** The run's lease is under `token`. Compared as text: a token is opaque to
 *  the core, and one that is not a uuid (a lease this backend never handed
 *  out) holds nothing rather than failing the statement. */
function leaseTokenIs(token: string) {
  return sql<boolean>`trigger_run.lease_token::text = ${token}`;
}

/** Why a fenced write wrote nothing: the lease is another's now, or (with no
 *  lease to fence by) the run has no row to write against. */
function notWritten(runId: string, fence: string | undefined): Error {
  return fence !== undefined ? new RunLeaseLost(runId) : new Error(`run ${runId} has no trigger_run row to park on`);
}

/** The run's row held for the transaction under `fence`, so the lease cannot
 *  change hands between the check and the writes. A lost fence writes nothing. */
async function holdRun(exec: Exec, runId: string, fence: string | undefined): Promise<void> {
  if (fence === undefined) return;
  const { rows } = await sql`
    select id from automations.trigger_run where id = ${runId}::uuid and lease_token::text = ${fence}::text for update`.execute(exec);
  if (rows.length === 0) throw new RunLeaseLost(runId);
}

// One process is one owner. The owner is only informational (the token
// fences), so a stable name makes the column readable.
const LEASE_OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

function leaseFromNow(ttlMs: number) {
  return sql<Date>`now() + ${ttlMs}::integer * interval '1 millisecond'`;
}

// ── Leaves ──────────────────────────────────────────────────────────────────

const LeafStatus = z.enum(['parked', 'resuming']);

function leafOf(row: { address: string; park_reason: string; status: string; wake_at: Date | null }): LeafRow {
  return {
    address: row.address,
    reason: row.park_reason,
    status: LeafStatus.parse(row.status),
    wakeAt: row.wake_at === null ? null : new Date(row.wake_at).toISOString(),
  };
}

interface PutLeaf {
  runId: string;
  address: string;
  reason: CoreParkReason;
  wakeAt: string | null;
  state?: unknown;
  rewritten?: boolean;
  fence?: string;
}

async function putLeafIn(db: StoreDb, { runId, address, reason, wakeAt, state, rewritten, fence }: PutLeaf): Promise<void> {
  const run = triggerRunIdOf(runId);
  const written = await db
    .insertInto('parked_run')
    .columns(['run_id', 'address', 'status', 'park_reason', 'wake_at', 'state'])
    .expression((eb) => {
      let row = eb
        .selectFrom('trigger_run')
        .select([
          'trigger_run.id as run_id',
          sql<string>`${address}::text`.as('address'),
          sql<string>`'parked'`.as('status'),
          sql<string>`${reason}::text`.as('park_reason'),
          sql<Date | null>`${wakeAt}::timestamptz`.as('wake_at'),
          jsonb(state).as('state'),
        ])
        .where('trigger_run.id', '=', run);
      if (fence !== undefined) row = row.where(leaseTokenIs(fence));
      return row;
    })
    .onConflict((oc) =>
      oc.columns(['run_id', 'address']).doUpdateSet({
        state: jsonb(state),
        status: 'parked',
        park_reason: reason,
        wake_at: wakeAt,
        // How the limit resume tells a flow that suspended again at once
        // from the one it stepped.
        ...(rewritten === true ? { updated_at: sql<Date>`now()` } : {}),
      }),
    )
    .returning('id')
    .executeTakeFirst();
  if (written === undefined) throw notWritten(runId, fence);
}

/** The leaf a segment resumed is over: deleted if resuming, and the notes the
 *  segment made kept. */
async function finishLeafIn(exec: Exec, input: { runId: string; address: string }): Promise<void> {
  await sql`
    delete from automations.parked_run
    where run_id = ${input.runId}::uuid and address = ${input.address}::text and status = 'resuming'`.execute(exec);
  await keepNotesOf(exec, { runId: input.runId, leaf: input.address });
}

async function markParkedIn(exec: Exec, runId: string): Promise<void> {
  await sql`
    update automations.trigger_run set status = 'parked'
    where id = ${runId}::uuid and status in ('running', 'parked')`.execute(exec);
}

/** The engine's settle on the run's row; `completed` is the hosted product's `success`. */
async function settleRunIn(exec: Exec, runId: string, settle: RunSettle): Promise<void> {
  const status = settle.status === 'completed' ? 'success' : settle.status;
  const outcome = typeof settle.outcome === 'object' && settle.outcome !== null && !Array.isArray(settle.outcome) ? settle.outcome : {};
  const writes = Reflect.get(outcome, 'writes');
  const error = Reflect.get(outcome, 'error');
  const returned = 'returned' in outcome ? JSON.stringify(Reflect.get(outcome, 'returned')) : null;
  await sql`
    update automations.trigger_run r set
      status = ${status}::text,
      nodes_written = coalesce(${Number.isInteger(writes) ? writes : null}::int, r.nodes_written),
      failure_reason = case when ${status}::text = 'failed' then ${typeof error === 'string' ? error : null}::text else r.failure_reason end,
      completed_at = case when ${status}::text = 'success' then ${settle.at}::timestamptz else r.completed_at end,
      failed_at = case when ${status}::text = 'failed' then ${settle.at}::timestamptz else r.failed_at end,
      returned = coalesce(${returned}::text::json, r.returned)
    where r.id = ${runId}::uuid`.execute(exec);
}

/**
 * One park's leaf and what wakes it, in the caller's transaction (which holds
 * the run, and the edges of the waits it parks). Whatever parks at the
 * address now, no wait parked there before is; a timer arms the run's
 * `resume_timer` row; a wait is parked there (stranded as it parks when its
 * record is already gone).
 */
async function parkIn(
  trx: StoreDb,
  input: { runId: string; teamId: string; address: string; state?: unknown; park: ParkKind; rewritten?: boolean },
): Promise<Queued[]> {
  const { runId, teamId, address, park } = input;
  const reason: CoreParkReason = park.kind === 'wait' ? 'await' : park.kind;
  await putLeafIn(trx, {
    runId,
    address,
    reason,
    wakeAt: park.kind === 'timer' ? park.wakeAt : null,
    state: input.state,
    ...(input.rewritten !== undefined ? { rewritten: input.rewritten } : {}),
  });
  await unparkWaitsAt(trx, { runId, address });
  switch (park.kind) {
    case 'timer':
      // The leaf is the truth; the work row only says when to look.
      return [
        await queueRow(trx, { runId }, { kind: RESUME_TIMER_WORK_KIND, key: timerWorkKey(runId), payload: { runId }, dueAt: park.wakeAt, teamId }),
      ];
    case 'wait':
      await parkWaitIn(trx, { runId, waitId: park.waitId, address });
      return [];
    case 'limit':
      return [];
    default:
      return neverAsAny(park);
  }
}

const OwedRacePayload = z.object({ runId: z.string(), frameAddress: z.string(), state: z.unknown() });

// ── Work claims ─────────────────────────────────────────────────────────────

/** A work claim's handle as the store hands it out. */
function claimOf(row: { leaseToken: string | null; updatedAt: Date }): string {
  return JSON.stringify({ leaseToken: row.leaseToken, claimedUpdatedAt: row.updatedAt.toISOString() });
}

// ── The families ────────────────────────────────────────────────────────────

export const postgresRunHostStore: RunHostStore = {
  parks: {
    async putLeaf(input) {
      await putLeafIn(storeDb(), input);
    },

    /** One write: the leaf, what wakes it, the run marked parked. A fenced
     *  one holds the run's row for it; a lost fence writes nothing. */
    async commit({ runId, teamId, address, state, fence, park, rewritten }) {
      const queued = await inStoreTransaction(async (trx) => {
        await holdRun(trx, runId, fence);
        if (park.kind === 'wait') await lockWaitEdges(trx, runId, [park.waitId]);
        const rows = await parkIn(trx, { runId, teamId, address, state, park, ...(rewritten !== undefined ? { rewritten } : {}) });
        await markParkedIn(trx, runId);
        return rows;
      });
      await announceQueued(queued);
    },

    /**
     * A segment's held writes in one: its joins, its parks, the end of the
     * leaf it resumed (unless it parks there again), the run marked parked,
     * its settle, the race it settled and the races it owes. Each wait it
     * parks whose arrivals are unread, read in the write, gets a wake.
     */
    async commitSegment({ runId, teamId, fence, resumed, joins, parks, settle, owedRaces, settledRace }) {
      const { wakes, queued } = await inStoreTransaction(async (trx) => {
        await holdRun(trx, runId, fence);
        // Locked as a log locks them, so a commit and a log never wait on each other.
        await lockWaitEdges(
          trx,
          runId,
          parks.flatMap(({ park }) => (park.kind === 'wait' ? [park.waitId] : [])),
        );
        for (const join of joins) await recordJoinIn(trx, { runId, frameAddress: join.frameAddress, pending: join.pending });
        const queued: Queued[] = [];
        for (const park of parks) queued.push(...(await parkIn(trx, { runId, teamId, address: park.address, state: park.state, park: park.park })));
        if (resumed !== null && !parks.some((park) => park.address === resumed)) await finishLeafIn(trx, { runId, address: resumed });
        if (parks.length > 0) await markParkedIn(trx, runId);
        if (settle !== null) await settleRunIn(trx, runId, settle);
        if (settledRace !== undefined && settledRace !== null) {
          await sql`
            delete from automations.work
            where key = ${settleRaceWorkKey(runId, settledRace)}::text and host = (select host from automations.trigger_run where id = ${runId}::uuid)`.execute(trx);
        }
        for (const race of owedRaces ?? []) {
          queued.push(
            await queueRow(trx, { runId }, {
              kind: SETTLE_RACE_WORK_KIND,
              key: settleRaceWorkKey(runId, race.frameAddress),
              payload: { runId, frameAddress: race.frameAddress, state: race.state },
              teamId,
            }),
          );
        }
        // Read in the write: an arrival logged before it is read here, and
        // one logged after it finds the wait parked.
        const wakes: WaitWake[] = [];
        for (const { address, park } of parks) {
          if (park.kind !== 'wait') continue;
          const { arrivals } = await waitArrivals(trx, park.waitId);
          if (arrivals.length === 0) continue;
          const wake = { runId, waitId: park.waitId, address };
          queued.push(await queueWake(trx, teamId, wake));
          wakes.push(wake);
        }
        return { wakes, queued };
      });
      await announceQueued(queued);
      return wakes;
    },

    async owedRaces({ runId }) {
      const { rows } = await sql<{ payload: unknown }>`
        select payload from automations.work
        where kind = ${SETTLE_RACE_WORK_KIND}::text and payload->>'runId' = ${runId}::text
        order by created_at, key`.execute(storeDb());
      return rows.map(({ payload }): OwedRace => {
        const race = OwedRacePayload.parse(payload);
        return { frameAddress: race.frameAddress, state: race.state };
      });
    },

    /** Claiming the leaf also drops the notes a segment that resumed it before
     *  made and never kept (it died), so their arrivals are read again. */
    async claimLeaf({ runId, address, reason }) {
      const { rows } = await sql<{ park_reason: string; state: unknown }>`
        with claimed as (
          update automations.parked_run set status = 'resuming', updated_at = now()
          where run_id = ${runId}::uuid and address = ${address}::text and status = 'parked'
            and (${reason ?? null}::text is null or park_reason = ${reason ?? null}::text)
          returning park_reason, state
        ), dropped as (
          delete from automations.wait_seen s using automations.wait_row w
          where s.wait_id = w.id and w.run_id = ${runId}::uuid and s.leaf = ${address}::text and exists (select 1 from claimed)
        )
        select park_reason, state from claimed`.execute(storeDb());
      const row = rows[0];
      if (row === undefined) return null;
      const claimedReason: ParkReason = row.park_reason;
      return { state: row.state, reason: claimedReason };
    },

    /** The leaf's resume is over: the notes its segment made are kept. */
    async finishLeaf({ runId, address, fence }) {
      await inStoreTransaction(async (trx) => {
        if (fence !== undefined) {
          const { rows } = await sql`
            select id from automations.trigger_run where id = ${runId}::uuid and lease_token::text = ${fence}::text for update`.execute(trx);
          if (rows.length === 0) return;
        }
        await finishLeafIn(trx, { runId, address });
      });
    },

    async leaves({ runId, parkedOnly, reason, dueBy }) {
      let rows = getAutomationsQb(['parked_run'])
        .selectFrom('parked_run')
        .where('run_id', '=', triggerRunIdOf(runId));
      if (parkedOnly === true) rows = rows.where('status', '=', 'parked');
      if (reason !== undefined) rows = rows.where('park_reason', '=', reason);
      if (dueBy !== undefined) rows = rows.where('park_reason', '=', 'timer').where('wake_at', '<=', new Date(dueBy));
      const found = await rows
        .select(['address', 'park_reason', 'status', 'wake_at'])
        .orderBy('created_at')
        .orderBy('address')
        .execute();
      return found.map(leafOf);
    },

    async deleteLeaves({ runId, addresses }) {
      if (addresses.length === 0) return;
      await getAutomationsQb(['parked_run'])
        .deleteFrom('parked_run')
        .where('run_id', '=', triggerRunIdOf(runId))
        .where('address', 'in', [...addresses])
        .execute();
    },
  },

  joins: {
    async recordJoin({ runId, frameAddress, pending, fence }) {
      await recordJoinIn(storeDb(), { runId, frameAddress, pending, ...(fence !== undefined ? { fence } : {}) });
    },

    /**
     * The mark-closed decrement. The join row is KEPT on close with the closing
     * leaf's address in `closed_by_address`, so a closer re-scanned after a
     * crash sees its own address and re-runs the continuation; a sibling never
     * does. Each branch decrements exactly once: its decrement is claimed
     * against its own export row (written before the decrement) via
     * `decremented`, so a non-closer re-scanned between its decrement and its
     * leaf's delete never closes the frame early. Claim and decrement are one
     * transaction.
     */
    async decrementJoin({ runId, frameAddress, branchAddress, leafAddress }) {
      const run = triggerRunIdOf(runId);
      return getAutomationsQb(['join_pending', 'join_branch_export'])
        .transaction()
        .execute(async (trx) => {
          const claimed = await trx
            .updateTable('join_branch_export')
            .set({ decremented: true })
            .where('run_id', '=', run)
            .where('frame_address', '=', frameOfExport(frameAddress))
            .where('branch_address', '=', branchOfExport(branchAddress))
            .where('decremented', '=', false)
            .returning(sql<number>`1`.as('one'))
            .executeTakeFirst();
          if (claimed !== undefined) {
            const updated = await trx
              .updateTable('join_pending')
              .set((eb) => ({ pending: eb('pending', '-', 1), updated_at: new Date() }))
              .where('run_id', '=', run)
              .where('frame_address', '=', frameOfJoin(frameAddress))
              .where('pending', '>', 0)
              .returning('pending')
              .executeTakeFirst();
            if (updated !== undefined) {
              if (updated.pending > 0) return { closed: false };
              await trx
                .updateTable('join_pending')
                .set({ closed_by_address: leafAddress })
                .where('run_id', '=', run)
                .where('frame_address', '=', frameOfJoin(frameAddress))
                .execute();
              return { closed: true };
            }
            // Claimed, but another branch already closed the frame: whose close
            // it was is read below.
          }
          // Already decremented (a crash retry), or claimed after the close:
          // the frame resolved. Is the close this leaf's?
          const row = await trx
            .selectFrom('join_pending')
            .where('run_id', '=', run)
            .where('frame_address', '=', frameOfJoin(frameAddress))
            .select('closed_by_address')
            .executeTakeFirst();
          return { closed: row?.closed_by_address === leafAddress };
        });
    },

    async persistBranchExport({ runId, frameAddress, branchAddress, branchIndex, exports }) {
      // The conflict update must never touch `decremented`: a re-persist on a
      // crash retry would otherwise reset the branch's decrement claim.
      await getAutomationsQb(['join_branch_export'])
        .insertInto('join_branch_export')
        .values({
          run_id: triggerRunIdOf(runId),
          frame_address: frameOfExport(frameAddress),
          branch_address: branchOfExport(branchAddress),
          branch_index: branchIndex,
          exports: jsonb(exports),
        })
        .onConflict((oc) =>
          oc.columns(['run_id', 'frame_address', 'branch_address']).doUpdateSet({
            exports: jsonb(exports),
            branch_index: branchIndex,
            updated_at: new Date(),
          }),
        )
        .execute();
    },

    async collectBranchExports({ runId, frameAddress }) {
      const rows = await getAutomationsQb(['join_branch_export'])
        .selectFrom('join_branch_export')
        .where('run_id', '=', triggerRunIdOf(runId))
        .where('frame_address', '=', frameOfExport(frameAddress))
        .orderBy('branch_index')
        .select(['branch_address', 'branch_index', 'exports'])
        .execute();
      return rows.map((r) => ({ branchAddress: r.branch_address, branchIndex: r.branch_index, exports: r.exports }));
    },

    async hasPendingJoins({ runId }) {
      const row = await getAutomationsQb(['join_pending'])
        .selectFrom('join_pending')
        .where('run_id', '=', triggerRunIdOf(runId))
        .where('pending', '>', 0)
        .select(sql<number>`1`.as('one'))
        .executeTakeFirst();
      return row !== undefined;
    },

    async frames({ runId }) {
      const rows = await getAutomationsQb(['join_pending'])
        .selectFrom('join_pending')
        .where('run_id', '=', triggerRunIdOf(runId))
        .select('frame_address')
        .orderBy('frame_address')
        .execute();
      return rows.map((r) => r.frame_address);
    },

    /** The frames, their exports, and the races owed at them: a race inside
     *  an arm another race withdrew is settled by nobody. */
    async deleteFrames({ runId, frameAddresses }) {
      if (frameAddresses.length === 0) return;
      const run = triggerRunIdOf(runId);
      await inStoreTransaction(async (trx) => {
        await trx
          .deleteFrom('join_pending')
          .where('run_id', '=', run)
          .where('frame_address', 'in', frameAddresses.map(frameOfJoin))
          .execute();
        await trx
          .deleteFrom('join_branch_export')
          .where('run_id', '=', run)
          .where('frame_address', 'in', frameAddresses.map(frameOfExport))
          .execute();
        const owed = frameAddresses.map((frame) => settleRaceWorkKey(runId, frame));
        await sql`
          delete from automations.work
          where key = any(${owed}::text[]) and host = (select host from automations.trigger_run where id = ${runId}::uuid)`.execute(trx);
      });
    },
  },

  waits: {
    mark: () => arrivalMark(storeDb()),

    async log(input) {
      const { logged, queued } = await inStoreTransaction(async (trx) => {
        const logged = await logArrivalsIn(trx, input);
        const queued: Queued[] = [];
        for (const wake of logged.wakes) queued.push(await queueWake(trx, input.teamId, wake));
        return { logged, queued };
      });
      await announceQueued(queued);
      return logged;
    },

    open: (input) => inStoreTransaction((trx) => openWait(trx, input)),

    arrivals: ({ waitId }) => waitArrivals(storeDb(), waitId),

    // The platform's runs, every team's: an lf run's are its store module's to read.
    stranded: (of) => strandedWaits(storeDb(), { host: 'platform' }, of),

    note: (input) => inStoreTransaction((trx) => noteArrivalIn(trx, input)),

    async sweep(input) {
      return { swept: await inStoreTransaction((trx) => sweepArrivalsIn(trx, input)) };
    },
  },

  leases: {
    /** One statement: the lease is taken only while free or lapsed, keeping the
     *  arrival mark as it is claimed (the sweep keeps every arrival above it
     *  while the lease is unexpired), and in the same statement every leaf a
     *  dead holder left claimed (`resuming`) goes back to `parked`, before
     *  anything reads the run's leaves. */
    async claim({ runId, ttlMs }) {
      const token = randomUUID();
      const { rows } = await sql<{ id: string }>`
        WITH claimed AS (
          UPDATE automations.trigger_run
          SET lease_owner = ${LEASE_OWNER}, lease_until = ${leaseFromNow(ttlMs)}, lease_token = ${token},
              lease_mark = (SELECT coalesce(max(seq), 0) FROM automations.arrival)
          WHERE id = ${runId}::uuid AND (lease_until IS NULL OR lease_until < now())
          RETURNING id
        ), returned AS (
          UPDATE automations.parked_run SET status = 'parked'
          WHERE run_id IN (SELECT id FROM claimed) AND status = 'resuming'
        )
        SELECT id FROM claimed`.execute(storeDb());
      return rows.length === 0 ? null : { token };
    },

    /** Also stamps the run's heartbeat: a holder renewing is a segment alive.
     *  A lapsed lease is free for anyone to claim, and renewing it would
     *  revive it under a holder that lost it. */
    async renew({ runId, token, ttlMs }) {
      const row = await getAutomationsQb(['trigger_run'])
        .updateTable('trigger_run')
        .set({ lease_until: leaseFromNow(ttlMs), last_heartbeat_at: sql<Date>`now()` })
        .where('id', '=', triggerRunIdOf(runId))
        .where(leaseTokenIs(token))
        .where('lease_until', '>', sql<Date>`now()`)
        .returning('id')
        .executeTakeFirst();
      return row !== undefined;
    },

    async release({ runId, token }) {
      await getAutomationsQb(['trigger_run'])
        .updateTable('trigger_run')
        .set({ lease_owner: null, lease_until: null, lease_token: null })
        .where('id', '=', triggerRunIdOf(runId))
        .where(leaseTokenIs(token))
        .execute();
    },

    /** The run's leaves, joins, waits (with their notes) and owed races. */
    async dropRunState({ runId, fence }) {
      const run = triggerRunIdOf(runId);
      return inStoreTransaction(async (trx) => {
        if (fence !== undefined) {
          // Held for the transaction: the lease cannot change hands between
          // the check and the deletes.
          const held = await trx
            .selectFrom('trigger_run')
            .where('id', '=', run)
            .where(leaseTokenIs(fence))
            .select('id')
            .forUpdate()
            .executeTakeFirst();
          if (held === undefined) return false;
        }
        await trx.deleteFrom('parked_run').where('run_id', '=', run).execute();
        await trx.deleteFrom('join_pending').where('run_id', '=', run).execute();
        await trx.deleteFrom('join_branch_export').where('run_id', '=', run).execute();
        await sql`delete from automations.wait_row where run_id = ${runId}::uuid`.execute(trx);
        await sql`
          delete from automations.work where kind = ${SETTLE_RACE_WORK_KIND}::text and payload->>'runId' = ${runId}::text`.execute(trx);
        return true;
      });
    },
  },

  work: {
    async enqueue({ kind, key, payload, dueAt, teamId }) {
      if (!isWorkKind(kind)) throw new Error(`'${kind}' is not a work kind this process knows`);
      await enqueueWork({ kind, key, payload, ...(teamId !== undefined ? { teamId } : {}), ...(dueAt !== undefined ? { dueAt: new Date(dueAt) } : {}) });
    },

    async enqueueIfAbsent({ kind, key, payload, dueAt, teamId }) {
      if (!isWorkKind(kind)) throw new Error(`'${kind}' is not a work kind this process knows`);
      return enqueueWorkIfAbsent({ kind, key, payload, ...(teamId !== undefined ? { teamId } : {}), ...(dueAt !== undefined ? { dueAt: new Date(dueAt) } : {}) });
    },

    async claimDue({ limit, leaseMs, dueBy, kinds, teamId }) {
      const rows = await claimDueWork({
        owner: LEASE_OWNER,
        limit,
        leaseMs,
        ...(dueBy !== undefined ? { now: new Date(dueBy) } : {}),
        ...(kinds !== undefined ? { kinds } : {}),
        ...(teamId !== undefined ? { teamId } : {}),
      });
      return rows.map((row) => ({ id: row.id, kind: row.kind, key: row.key, payload: row.payload, claim: claimOf(row) }));
    },

    async complete(work) {
      await completeWork(workClaimOf(work));
    },

    async release(work) {
      await releaseWork({ ...workClaimOf(work), ...(work.dueAt !== undefined ? { dueAt: new Date(work.dueAt) } : {}) });
    },
  },

  sources: {
    async put({ teamId, hash, source }) {
      await getAutomationsQb(['park_library_source'])
        .insertInto('park_library_source')
        .values({ ...librarySourceKeyOf(teamId, hash), source })
        .onConflict((oc) => oc.columns(['team_id', 'hash']).doNothing())
        .execute();
    },

    async get({ teamId, hash }) {
      const key = librarySourceKeyOf(teamId, hash);
      const row = await getAutomationsQb(['park_library_source'])
        .selectFrom('park_library_source')
        .select('source')
        .where('team_id', '=', key.team_id)
        .where('hash', '=', key.hash)
        .executeTakeFirst();
      return row?.source ?? null;
    },
  },
};

/** A join recorded (a re-reached frame overwrites to the same deterministic
 *  count, never double-counting), fenced by the run's lease when given. */
async function recordJoinIn(db: StoreDb, input: { runId: string; frameAddress: string; pending: number; fence?: string }): Promise<void> {
  const { runId, frameAddress, pending, fence } = input;
  const recorded = await db
    .insertInto('join_pending')
    .columns(['run_id', 'frame_address', 'pending'])
    .expression((eb) => {
      let row = eb
        .selectFrom('trigger_run')
        .select([
          'trigger_run.id as run_id',
          sql<JoinPendingFrameAddress>`${frameAddress}::text`.as('frame_address'),
          sql<number>`${pending}::integer`.as('pending'),
        ])
        .where('trigger_run.id', '=', triggerRunIdOf(runId));
      if (fence !== undefined) row = row.where(leaseTokenIs(fence));
      return row;
    })
    .onConflict((oc) => oc.columns(['run_id', 'frame_address']).doUpdateSet({ pending, updated_at: new Date() }))
    .returning('run_id')
    .executeTakeFirst();
  if (recorded === undefined) throw notWritten(runId, fence);
}

/** A team's deliveries as the platform's door keeps them. */
export function platformDeliveryRows(teamId: string): DeliveryRowStore {
  return deliveryRowStore({ host: 'platform', teamId });
}

/** The orphan sweep's half: every `resuming` leaf whose run's lease is free or
 *  lapsed was left by a dead holder, and is parked again. Returns how many.
 *  The platform's runs only: a lapsed lf lease is lf's to recover. */
export async function returnLeavesOfLapsedLeases(): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    UPDATE automations.parked_run p
    SET status = 'parked'
    FROM automations.trigger_run r
    WHERE p.run_id = r.id AND p.status = 'resuming' AND r.host = 'platform'
      AND (r.lease_until IS NULL OR r.lease_until < now())
    RETURNING p.id`.execute(getAutomationsQb(['parked_run', 'trigger_run']));
  return rows.length;
}
