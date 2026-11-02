// An lf run's waits on listenable edges and the arrival log they read
// (waits.*), over the in-process store's own statements
// (movement_engine/run_host_waits.ts), held to the tenant: a log, an open and
// a sweep are the tenant's team's, and a wait is reached only when it is the
// tenant's and no platform run's.
//
// The arrival log is the team's, whichever host logs it: an arrival lf logs
// wakes each wait parked on its record, and the wake row is queued for the
// host of the wait's run. lf is answered only the waits of its own runs.

import { sql } from 'kysely';
import { SlotRefusal } from 'module-runtime/module_wire/wire';

import type { DeliveryArrivals, StrandedOf, StrandedWait, WaitWake } from 'movement-engine/public/run-host';

import { announceQueued, queueWake, type Queued } from '../movement_engine/run_host_queue';
import {
  arrivalMark,
  logArrivalsIn,
  noteArrivalIn,
  openWait,
  strandedWaits,
  sweepArrivalsIn,
  waitArrivals,
} from '../movement_engine/run_host_waits';
import { inTransaction, lfRunRow, notThisTenantsRun, pool, refuseAnotherTenant, type Exec, type LfTenant } from './scope';

export function mark(): Promise<number> {
  return arrivalMark(pool());
}

/** The tenant's lf runs among `runIds`. */
async function lfRunsAmong(exec: Exec, scope: LfTenant, runIds: readonly string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const { rows } = await sql<{ id: string }>`
    select r.id::text as id from automations.trigger_run r
    where r.id::text = any(${[...new Set(runIds)]}::text[]) and ${lfRunRow(scope, 'r')}`.execute(exec);
  return new Set(rows.map((r) => r.id));
}

/** What a log answers lf: the wakes and strandings of its own runs' waits. */
export async function ownWakes(scope: LfTenant, wakes: readonly WaitWake[]): Promise<WaitWake[]> {
  const own = await lfRunsAmong(pool(), scope, wakes.map((w) => w.runId));
  return wakes.filter((w) => own.has(w.runId));
}

/** One write: the arrivals logged, and a wake row queued per wait they answer. */
export async function log(scope: LfTenant, input: DeliveryArrivals): Promise<{ wakes: WaitWake[]; stranded: StrandedWait[] }> {
  refuseAnotherTenant(scope, input.teamId);
  const { logged, queued } = await inTransaction(async (trx) => {
    const logged = await logArrivalsIn(trx, input);
    const queued: Queued[] = [];
    for (const wake of logged.wakes) queued.push(await queueWake(trx, input.teamId, wake));
    return { logged, queued };
  });
  await announceQueued(queued);
  const own = await lfRunsAmong(pool(), scope, [...logged.wakes, ...logged.stranded].map((w) => w.runId));
  return { wakes: logged.wakes.filter((w) => own.has(w.runId)), stranded: logged.stranded.filter((w) => own.has(w.runId)) };
}

export async function open(
  scope: LfTenant,
  input: { runId: string; teamId: string; adapterType: string; edge: string; key: string | null; recordId: string | null; since: number },
): Promise<{ waitId: string }> {
  refuseAnotherTenant(scope, input.teamId);
  const { recordId, ...wait } = input;
  return inTransaction(async (trx) => {
    // A run a delivery queued has no row until it starts, and its wait is
    // opened before; a run that has one must be the tenant's.
    const { rows: another } = await sql`
      select 1 from automations.trigger_run r where r.id::text = ${input.runId}::text and not ${lfRunRow(scope, 'r')}`.execute(trx);
    if (another.length > 0) throw notThisTenantsRun(input.runId);
    return openWait(trx, { ...wait, ...(recordId !== null ? { recordId } : {}) });
  });
}

/** An unknown wait, or another's, fails as one the store has not. */
async function refuseAnotherWait(exec: Exec, scope: LfTenant, waitId: string): Promise<void> {
  const { rows } = await sql`
    select 1 from automations.wait_row w
    where w.id::text = ${waitId}::text and w.team_id = ${scope.tenant}::uuid
      and not exists (select 1 from automations.trigger_run r where r.id = w.run_id and r.host <> 'lf')`.execute(exec);
  if (rows.length === 0) throw new SlotRefusal('bad_request', `no wait ${waitId} of this tenant's`);
}

export async function arrivals(scope: LfTenant, input: { waitId: string }) {
  await refuseAnotherWait(pool(), scope, input.waitId);
  return waitArrivals(pool(), input.waitId);
}

export function note(
  scope: LfTenant,
  input: { waitId: string; identity: string; version: string | null; matched: boolean; leaf: string | null; fence: string | null },
): Promise<boolean> {
  const { leaf, fence, ...noted } = input;
  return inTransaction(async (trx) => {
    await refuseAnotherWait(trx, scope, input.waitId);
    return noteArrivalIn(trx, { ...noted, ...(leaf !== null ? { leaf } : {}), ...(fence !== null ? { fence } : {}) });
  });
}

export function stranded(scope: LfTenant, of: StrandedOf): Promise<StrandedWait[]> {
  return strandedWaits(pool(), { host: 'lf', teamId: scope.tenant }, of);
}

/** The tenant's arrivals only; the floor is every host's running steps'. */
export async function sweep(scope: LfTenant, input: { limit: number; floor: number | null }): Promise<{ swept: number }> {
  const swept = await inTransaction((trx) =>
    sweepArrivalsIn(trx, { limit: input.limit, teamId: scope.tenant, ...(input.floor !== null ? { floor: input.floor } : {}) }),
  );
  return { swept };
}
