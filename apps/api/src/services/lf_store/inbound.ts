// What lf keeps of its inbound side (inbound.*, events.*, processes.*), ported
// from pg_store.rs over the tables written only by this module: pull cursors
// (`inbound_checkpoint`), event receipts (`event_receipt`), delivery receipts
// (`delivery`) and the module processes its hosts started (`module_processes`).

import { sql } from 'kysely';

import { lfStatus, isUuid, startRunRow, type RunStart } from './runs';
import { enqueueRow } from './work';
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
  source: 'webhook' | 'hook' | 'emit' | 'cli';
  inline: boolean;
  replayOf: string | null;
  events: unknown[];
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
 * is; `{ saved }` saves it, `null` being a cursor too.
 */
export async function keepDelivery(
  scope: LfTenant,
  input: { subscriptionId: string; checkpoint: { saved: unknown } | null; delivery: NewDelivery; work: KeptWork[] },
): Promise<{ kept: boolean }> {
  const { subscriptionId, delivery } = input;
  for (const row of input.work) refuseAnotherTenant(scope, row.teamId);
  return inTransaction(async (trx) => {
    const { rows } = await sql<{ id: string }>`
      insert into automations.delivery (id, team_id, subscription_id, external_id, received_at, source, inline, replay_of, events, event_count)
      values (${delivery.id}::uuid, ${scope.tenant}::uuid, ${subscriptionId}::text, ${delivery.externalId}::text, ${delivery.receivedAt}::timestamptz,
              ${delivery.source}::text, ${delivery.inline}::bool, ${delivery.replayOf}::uuid, ${JSON.stringify(delivery.events)}::text::jsonb,
              ${delivery.events.length}::int)
      on conflict do nothing returning id::text`.execute(trx);
    if (rows.length === 0) return { kept: false };
    if (input.checkpoint !== null) await saveCheckpointRow(trx, scope, subscriptionId, input.checkpoint.saved);
    for (const row of input.work) await enqueueRow(trx, { ...row, teamId: row.teamId ?? scope.tenant });
    return { kept: true };
  });
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
 *  `events` only when they were read. */
async function deliveryOf(scope: LfTenant, row: DeliveryColumns, events: unknown[] | undefined) {
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
    ...(events !== undefined ? { events } : {}),
  };
}

export async function deliveries(scope: LfTenant, input: { subscriptionId: string | null; since: string | null; limit: number }) {
  const { rows } = await sql<DeliveryColumns>`
    select ${DELIVERY_COLUMNS} from automations.delivery d
    where d.team_id = ${scope.tenant}::uuid and (${input.subscriptionId}::text is null or d.subscription_id = ${input.subscriptionId}::text)
      and (${input.since}::text is null or d.received_at >= ${input.since}::timestamptz)
    order by d.received_at desc, d.id desc limit ${input.limit}::int8`.execute(pool());
  return Promise.all(rows.map((row) => deliveryOf(scope, row, undefined)));
}

export async function delivery(scope: LfTenant, input: { id: string }) {
  if (!isUuid(input.id)) return null;
  const { rows } = await sql<DeliveryColumns & { events: unknown }>`
    select ${DELIVERY_COLUMNS}, d.events from automations.delivery d
    where d.id = ${input.id}::uuid and d.team_id = ${scope.tenant}::uuid`.execute(pool());
  const row = rows[0];
  if (row === undefined) return null;
  if (!Array.isArray(row.events)) throw new Error(`delivery ${input.id}'s events are not a list`);
  return deliveryOf(scope, row, row.events);
}

/** Forgets at most `limit` deliveries received before `before` whose lf runs
 *  are all settled and that no lf `fire_event` row names: how many went. */
export async function sweepDeliveries(scope: LfTenant, input: { before: string; limit: number }): Promise<number> {
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

async function claimEventRow(exec: Exec, scope: LfTenant, input: { listen: string; key: string }): Promise<boolean> {
  const { rows } = await sql`
    insert into automations.event_receipt (team_id, listen, key) values (${scope.tenant}::uuid, ${input.listen}::text, ${input.key}::text)
    on conflict do nothing returning 1`.execute(exec);
  return rows.length === 1;
}

/** `true` the first time this event key reaches this listen. */
export async function claimEvent(scope: LfTenant, input: { listen: string; key: string }): Promise<boolean> {
  return claimEventRow(pool(), scope, input);
}

/** The event's receipt and, when it is the first, its run, as one write. */
export async function startEventRun(scope: LfTenant, input: { listen: string; key: string; run: RunStart }): Promise<boolean> {
  return inTransaction(async (trx) => {
    if (!(await claimEventRow(trx, scope, input))) return false;
    await startRunRow(trx, scope, input.run);
    return true;
  });
}
