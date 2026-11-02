// What lf keeps of its inbound side (inbound.*, events.*, processes.*), ported
// from pg_store.rs over the tables written only by this module: pull cursors
// (`inbound_checkpoint`), event receipts (`event_receipt`), delivery receipts
// with their requests (`delivery`) and the module processes its hosts started
// (`module_processes`). A delivery's arrivals and the waits of the runs it
// queues are the in-process store's own statements (run_host_waits.ts).

import { sql } from 'kysely';
import { SlotRefusal } from 'module-runtime/module_wire/wire';

import type { DeliveryArrivals, DeliveryWait, WaitWake } from 'movement-engine/public/run-host';

import { markedPayload } from '../movement_engine/run_host_deliveries';
import { announceQueued, queueWake, type Queued } from '../movement_engine/run_host_queue';
import { arrivalMark, logArrivalsIn, openDeliveryWaits } from '../movement_engine/run_host_waits';
import { keepUnjudgedIn, type UnjudgedArrival } from './records_door';
import { lfStatus, isUuid, startRunRow, type RunStart } from './runs';
import { ownWakes } from './waits';
import { enqueueRow, storedKey } from './work';
import { inTransaction, iso, pool, refuseAnotherTenant, type Exec, type LfTenant } from './scope';

// ── Pull cursors ────────────────────────────────────────────────────────────

export async function checkpoint(scope: LfTenant, input: { subscriptionId: string }): Promise<{ checkpoint: unknown } | null> {
  const { rows } = await sql<{ checkpoint: unknown }>`
    select checkpoint from automations.inbound_checkpoint
    where team_id = ${scope.tenant}::uuid and subscription_id = ${input.subscriptionId}::text`.execute(pool());
  const row = rows[0];
  return row === undefined ? null : { checkpoint: row.checkpoint };
}

async function saveCheckpointRow(exec: Exec, scope: LfTenant, subscriptionId: string, saved: unknown): Promise<void> {
  await sql`
    insert into automations.inbound_checkpoint (team_id, subscription_id, checkpoint)
    values (${scope.tenant}::uuid, ${subscriptionId}::text, ${JSON.stringify(saved)}::text::jsonb)
    on conflict (team_id, subscription_id) do update set checkpoint = excluded.checkpoint, updated_at = now()`.execute(exec);
}

export async function saveCheckpoint(scope: LfTenant, input: { subscriptionId: string; checkpoint: unknown }): Promise<null> {
  await saveCheckpointRow(pool(), scope, input.subscriptionId, input.checkpoint);
  return null;
}

// ── Delivery receipts ───────────────────────────────────────────────────────

export interface NewDelivery {
  id: string;
  externalId: string | null;
  receivedAt: string;
  source: 'webhook' | 'hook' | 'emit' | 'cli' | 'poll';
  inline: boolean;
  replayOf: string | null;
  events: unknown[];
  /** The request it was received as, kept as given; null for none. */
  request: unknown;
}

export interface KeptWork {
  kind: string;
  key: string;
  payload: unknown;
  dueAt: string | null;
  teamId: string | null;
}

/**
 * The door's one write. The receipt first: a duplicate (its id, or its
 * external id kept at its subscription before, even by a transaction still
 * open, which the unique index waits on) writes nothing, no cursor and no
 * rows, and answers `kept: false`. `checkpoint` null leaves the cursor as it
 * is; `{ saved }` saves it, `null` being a cursor too. Then, from the mark
 * before the delivery's arrivals, the waits of the runs it queues (each
 * under its `fire_event` row's stored key, so burying or completing that
 * row finds them), the arrivals and the wake rows they answer, the rows
 * (each `fire_event` carrying the mark), and the listens that could not
 * judge them.
 */
export async function keepDelivery(
  scope: LfTenant,
  input: {
    subscriptionId: string;
    checkpoint: { saved: unknown } | null;
    delivery: NewDelivery;
    work: KeptWork[];
    arrivals: DeliveryArrivals | null;
    waits: DeliveryWait[];
    unjudged: UnjudgedArrival[];
  },
): Promise<{ kept: false } | { kept: true; arrivalMark: number; wakes?: WaitWake[] }> {
  const { subscriptionId, delivery, arrivals } = input;
  for (const row of input.work) refuseAnotherTenant(scope, row.teamId);
  if (arrivals !== null) refuseAnotherTenant(scope, arrivals.teamId);
  if (arrivals === null && input.waits.length > 0) {
    throw new SlotRefusal('bad_request', "waits came without arrivals: a delivery's waits are opened with its arrivals, under their team and adapter");
  }
  const written = await inTransaction(async (trx) => {
    const { rows } = await sql<{ id: string }>`
      insert into automations.delivery (id, team_id, subscription_id, external_id, received_at, source, inline, replay_of, events, event_count, request)
      values (${delivery.id}::uuid, ${scope.tenant}::uuid, ${subscriptionId}::text, ${delivery.externalId}::text, ${delivery.receivedAt}::timestamptz,
              ${delivery.source}::text, ${delivery.inline}::bool, ${delivery.replayOf}::uuid, ${JSON.stringify(delivery.events)}::text::jsonb,
              ${delivery.events.length}::int, ${delivery.request === null ? null : JSON.stringify(delivery.request)}::text::jsonb)
      on conflict do nothing returning id::text`.execute(trx);
    if (rows.length === 0) return null;
    if (input.checkpoint !== null) await saveCheckpointRow(trx, scope, subscriptionId, input.checkpoint.saved);
    const mark = await arrivalMark(trx);
    const queued: Queued[] = [];
    let wakes: WaitWake[] | undefined;
    if (arrivals !== null) {
      const waits = input.waits.map((wait) => ({ ...wait, fireKey: storedKey(scope.tenant, wait.fireKey) }));
      await openDeliveryWaits(trx, { teamId: scope.tenant, adapterType: arrivals.adapterType, waits, since: mark });
      wakes = (await logArrivalsIn(trx, arrivals)).wakes;
      for (const wake of wakes) queued.push(await queueWake(trx, scope.tenant, wake));
    }
    for (const row of input.work) {
      await enqueueRow(trx, { ...row, payload: markedPayload(row.kind, row.payload, mark), teamId: scope.tenant });
    }
    for (const fact of input.unjudged) await keepUnjudgedIn(trx, scope, fact);
    return { mark, wakes, queued };
  });
  if (written === null) return { kept: false };
  await announceQueued(written.queued);
  return written.wakes === undefined
    ? { kept: true, arrivalMark: written.mark }
    : { kept: true, arrivalMark: written.mark, wakes: await ownWakes(scope, written.wakes) };
}

/** Clears a kept delivery's external id, its receipt kept: a sender's retry
 *  under that id is then a delivery of its own. */
export async function forgetDeliveryId(scope: LfTenant, input: { id: string }): Promise<null> {
  if (!isUuid(input.id)) return null;
  await sql`
    update automations.delivery set external_id = null where id = ${input.id}::uuid and team_id = ${scope.tenant}::uuid`.execute(pool());
  return null;
}

interface DeliveryColumns {
  id: string;
  subscription_id: string;
  external_id: string | null;
  received_at: string;
  source: NewDelivery['source'];
  inline: boolean;
  replay_of: string | null;
  event_count: number;
}

const DELIVERY_COLUMNS = sql`d.id::text as id, d.subscription_id, d.external_id, ${iso('d.received_at')} as received_at, d.source, d.inline,
  d.replay_of::text as replay_of, d.event_count`;

/** A delivery row as the store wire carries it (store_wire.rs `DeliveryRow`):
 *  `events` and `request` only when they were read. */
async function deliveryOf(scope: LfTenant, row: DeliveryColumns, read?: { events: unknown[]; request: unknown }) {
  const { rows: runs } = await sql<{ id: string; status: string }>`
    select r.id::text as id, r.status from automations.trigger_run r
    where r.team_id = ${scope.tenant}::uuid and r.host = 'lf' and r.delivery_id = ${row.id}::uuid
    order by r.started_at, r.id`.execute(pool());
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    externalId: row.external_id,
    receivedAt: row.received_at,
    source: row.source,
    inline: row.inline,
    replayOf: row.replay_of,
    eventCount: row.event_count,
    runs: runs.map((r) => ({ id: r.id, status: lfStatus(r.status) })),
    ...(read !== undefined ? { events: read.events, ...(read.request !== null ? { request: read.request } : {}) } : {}),
  };
}

export async function deliveries(scope: LfTenant, input: { subscriptionId: string | null; since: string | null; limit: number }) {
  const { rows } = await sql<DeliveryColumns>`
    select ${DELIVERY_COLUMNS} from automations.delivery d
    where d.team_id = ${scope.tenant}::uuid and (${input.subscriptionId}::text is null or d.subscription_id = ${input.subscriptionId}::text)
      and (${input.since}::text is null or d.received_at >= ${input.since}::timestamptz)
    order by d.received_at desc, d.id desc limit ${input.limit}::int8`.execute(pool());
  return Promise.all(rows.map((row) => deliveryOf(scope, row)));
}

export async function delivery(scope: LfTenant, input: { id: string }) {
  if (!isUuid(input.id)) return null;
  const { rows } = await sql<DeliveryColumns & { events: unknown; request: unknown }>`
    select ${DELIVERY_COLUMNS}, d.events, d.request from automations.delivery d
    where d.id = ${input.id}::uuid and d.team_id = ${scope.tenant}::uuid`.execute(pool());
  const row = rows[0];
  if (row === undefined) return null;
  if (!Array.isArray(row.events)) throw new Error(`delivery ${input.id}'s events are not a list`);
  return deliveryOf(scope, row, { events: row.events, request: row.request ?? null });
}

/** Forgets the request of every delivery received before `before`, and at
 *  most `limit` of those deliveries whose lf runs are all settled and that no
 *  lf `fire_event` row names: how many went. */
export async function sweepDeliveries(scope: LfTenant, input: { before: string; limit: number }): Promise<number> {
  await sql`
    update automations.delivery set request = null
    where team_id = ${scope.tenant}::uuid and received_at < ${input.before}::timestamptz and request is not null`.execute(pool());
  const { rows } = await sql<{ id: string }>`
    delete from automations.delivery where id in (
      select d.id from automations.delivery d
      where d.team_id = ${scope.tenant}::uuid and d.received_at < ${input.before}::timestamptz
        and not exists (select 1 from automations.trigger_run r
                        where r.team_id = d.team_id and r.host = 'lf' and r.delivery_id = d.id and r.status in ('running', 'parked'))
        and not exists (select 1 from automations.work w
                        where w.team_id = d.team_id and w.host = 'lf' and w.kind = 'fire_event' and w.payload->>'deliveryId' = d.id::text)
      order by d.received_at limit ${input.limit}::int8)
    returning id::text`.execute(pool());
  return rows.length;
}

// ── Module processes ────────────────────────────────────────────────────────

export async function listProcesses(scope: LfTenant): Promise<{ processes: unknown; version: number }> {
  const { rows } = await sql<{ processes: unknown; version: string }>`
    select processes, version::text as version from automations.module_processes where team_id = ${scope.tenant}::uuid`.execute(pool());
  const row = rows[0];
  return row === undefined ? { processes: [], version: 0 } : { processes: row.processes, version: Number(row.version) };
}

/** Compare-and-set on the list's version: `false` when another host wrote first. */
export async function swapProcesses(scope: LfTenant, input: { version: number; processes: unknown }): Promise<boolean> {
  const processes = JSON.stringify(input.processes);
  const { rows } =
    input.version === 0
      ? await sql`
          insert into automations.module_processes (team_id, processes, version) values (${scope.tenant}::uuid, ${processes}::text::jsonb, 1)
          on conflict (team_id) do nothing returning 1`.execute(pool())
      : await sql`
          update automations.module_processes set processes = ${processes}::text::jsonb, version = version + 1, updated_at = now()
          where team_id = ${scope.tenant}::uuid and version = ${input.version}::int8 returning 1`.execute(pool());
  return rows.length === 1;
}

// ── Event receipts ──────────────────────────────────────────────────────────

/** An event receipt: its team's (absent, the tenant's; another's refused). */
interface Receipt {
  listen: string;
  key: string;
  teamId: string | null;
}

async function claimEventRow(exec: Exec, scope: LfTenant, input: Receipt): Promise<boolean> {
  refuseAnotherTenant(scope, input.teamId);
  const { rows } = await sql`
    insert into automations.event_receipt (team_id, listen, key) values (${scope.tenant}::uuid, ${input.listen}::text, ${input.key}::text)
    on conflict do nothing returning 1`.execute(exec);
  return rows.length === 1;
}

/** `true` the first time this event key reaches this listen under this team. */
export async function claimEvent(scope: LfTenant, input: Receipt): Promise<boolean> {
  return claimEventRow(pool(), scope, input);
}

/** The event's receipt and, when it is the first, its run, as one write. */
export async function startEventRun(scope: LfTenant, input: Receipt & { run: RunStart }): Promise<boolean> {
  return inTransaction(async (trx) => {
    if (!(await claimEventRow(trx, scope, input))) return false;
    await startRunRow(trx, scope, input.run);
    return true;
  });
}
