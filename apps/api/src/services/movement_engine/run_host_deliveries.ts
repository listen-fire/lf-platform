// A kept delivery's one write and the rows it queues (listen-fire 0.13's
// `DeliveryRowStore`: `inbound.keepDelivery`, `work.bury`,
// `work.completeKey`, `inbound.forgetDeliveryId`), over automations.delivery,
// inbound_checkpoint, work and the waits tables. Ported from
// @lf/postgres-store (crates/lf/src/pg_store.rs). One store is one team's
// deliveries, kept for one host: the platform's door, or a cloud lf through
// the store module.

import { sql } from 'kysely';

import type { DeliveryRowStore, KeepDelivery, NewWorkRow, WaitWake } from 'movement-engine/public/run-host';

import { isWorkKind } from '../work/kinds';
import {
  announceQueued,
  inStoreTransaction,
  queueRow,
  queueWake,
  storeDb,
  workClaimOf,
  type Exec,
  type Host,
  type Queued,
} from './run_host_queue';
import { arrivalMark, dropUnstartedWaits, logArrivalsIn, openDeliveryWaits } from './run_host_waits';
import { keepUnjudgedIn, type UnjudgedArrival } from '../lf_store/records_door';

/** `inbound.keepDelivery`'s input as the platform's door sends it: with the
 *  listens that could not judge the delivery's arrivals, kept in its write. */
export interface PlatformKeepDelivery extends KeepDelivery {
  unjudged?: readonly UnjudgedArrival[];
  /** The door kept this delivery before reading it (`keepRawDelivery`): this
   *  write is its judging. `kept: false` when it was judged before. */
  rawKept?: { id: string };
}

/** The row a door keeps before any version reads the delivery. */
export interface RawDelivery {
  id: string;
  subscriptionId: string;
  externalId: string | null;
  receivedAt: string;
  source: KeepDelivery['delivery']['source'];
  request: unknown;
}

export interface PlatformDeliveryRowStore extends DeliveryRowStore {
  keepDelivery(input: PlatformKeepDelivery): ReturnType<DeliveryRowStore['keepDelivery']>;
  /** The delivery as it arrived, and the rows owed by it in the same write,
   *  under the team's doors lock (`work` is asked inside it, so what it reads is
   *  settled against any upgrade): `alreadyKept` when its external id was kept
   *  before. Then its id is that delivery's, `judged` says whether the platform's
   *  version read it, and nothing is written. `keptAt` is the database's clock
   *  at the keep. */
  keepRawDelivery(input: { delivery: RawDelivery; work: () => Promise<readonly NewWorkRow[]> }): Promise<{ id: string; alreadyKept: boolean; judged: boolean; keptAt: Date }>;
  /** A kept delivery the platform's version read and found nothing in. */
  judgedEmpty(input: { id: string }): Promise<void>;
}

const FIRE_EVENT = 'fire_event';

/** A kept delivery the platform's version has not judged yet is named by what
 *  it carries, so a provider's retry of it finds it. The key goes with the
 *  judging: an identical delivery after that is a new one. */
export const WAITING_KEY_PREFIX = 'waiting:';

/** The doors of a team hold this shared while a delivery is kept and what it owes
 *  each version is read; an upgrade holds it alone (`holdDoorsAlone`). So a
 *  delivery is on one side of a move: its keep sees the move, or the move sees
 *  what it queued. */
function doorsLockKey(teamId: string) {
  return sql`hashtextextended(${`doors:${teamId}`}::text, 0)`;
}

async function holdDoorsShared(exec: Exec, teamId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock_shared(${doorsLockKey(teamId)})`.execute(exec);
}

/** `body` with the team's doors held shared: for a door that reads a delivery's
 *  listens version by version itself, so an upgrade is not between its reads.
 *  The lock's transaction only holds the lock: `body` writes as it always does. */
export function withDoorsHeld<T>(teamId: string, body: () => Promise<T>): Promise<T> {
  return storeDb()
    .transaction()
    .execute(async (trx) => {
      await holdDoorsShared(trx, teamId);
      return body();
    });
}

/** Holds the team's doors for the rest of the open transaction. Answers the
 *  database's clock once it has them, the instant a move is on the far side of. */
export async function holdDoorsAlone(exec: Exec, teamId: string): Promise<Date> {
  await sql`select pg_advisory_xact_lock(${doorsLockKey(teamId)})`.execute(exec);
  const { rows } = await sql<{ at: Date }>`select clock_timestamp() as at`.execute(exec);
  const at = rows[0]?.at;
  if (at === undefined) throw new Error('the database answered no clock');
  return at;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `fire_event` row's payload gains the mark before its delivery's
 *  arrivals: a run it starts reads its trigger's waits from there. */
export function markedPayload(kind: string, payload: unknown, mark: number): unknown {
  if (kind !== FIRE_EVENT || typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload;
  return { ...payload, arrivalMark: mark };
}

async function saveCheckpointIn(exec: Exec, input: { teamId: string; subscriptionId: string; checkpoint: unknown }): Promise<void> {
  await sql`
    insert into automations.inbound_checkpoint (team_id, subscription_id, checkpoint)
    values (${input.teamId}::uuid, ${input.subscriptionId}::text, ${JSON.stringify(input.checkpoint ?? null)}::text::jsonb)
    on conflict (team_id, subscription_id) do update set checkpoint = excluded.checkpoint, updated_at = now()`.execute(exec);
}

/** The team's deliveries, kept for `host`. */
export function deliveryRowStore(owner: { host: Host; teamId: string }): PlatformDeliveryRowStore {
  return {
    /**
     * The receipt first: a duplicate (its id, or its external id kept at its
     * subscription before, even by a transaction still open, which the unique
     * index waits on) writes nothing and answers `kept: false`. Then the
     * cursor, the waits of the runs it queues (from the mark before its
     * arrivals), its arrivals and the wakes they answer, and its rows.
     */
    async keepDelivery(input: PlatformKeepDelivery) {
      const { subscriptionId, delivery, arrivals } = input;
      const waits = input.waits ?? [];
      if (arrivals === undefined && waits.length > 0) {
        throw new Error("inbound.keepDelivery: `waits` came without `arrivals`; a delivery's waits are opened with its arrivals, under their team and adapter");
      }
      if (owner.host === 'platform') {
        for (const row of input.work) if (!isWorkKind(row.kind)) throw new Error(`'${row.kind}' is not a work kind this process knows`);
      }
      const written = await inStoreTransaction(async (trx) => {
        const { rows } =
          input.rawKept !== undefined
            ? await sql<{ id: string }>`
                update automations.delivery
                set judged_at = now(), external_id = case when external_id like ${WAITING_KEY_PREFIX + '%'} then null else external_id end, events = ${JSON.stringify(delivery.events)}::text::jsonb, event_count = ${delivery.events.length}::int,
                    request = coalesce(${delivery.request === undefined ? null : JSON.stringify(delivery.request)}::text::jsonb, request)
                where id = ${input.rawKept.id}::uuid and team_id = ${owner.teamId}::uuid and judged_at is null
                returning id::text as id`.execute(trx)
            : await sql<{ id: string }>`
                insert into automations.delivery (id, team_id, subscription_id, external_id, received_at, source, inline, replay_of, events, event_count, request, judged_at)
                values (${delivery.id}::uuid, ${owner.teamId}::uuid, ${subscriptionId}::text, ${delivery.externalId ?? null}::text,
                        ${delivery.receivedAt}::timestamptz, ${delivery.source}::text, ${delivery.inline}::bool, ${delivery.replayOf ?? null}::uuid,
                        ${JSON.stringify(delivery.events)}::text::jsonb, ${delivery.events.length}::int,
                        ${delivery.request === undefined ? null : JSON.stringify(delivery.request)}::text::jsonb, now())
                on conflict do nothing returning id::text as id`.execute(trx);
        if (rows.length === 0) return null;
        if ('checkpoint' in input) await saveCheckpointIn(trx, { teamId: owner.teamId, subscriptionId, checkpoint: input.checkpoint });
        const mark = await arrivalMark(trx);
        let wakes: WaitWake[] | undefined;
        const queued: Queued[] = [];
        if (arrivals !== undefined) {
          await openDeliveryWaits(trx, { teamId: arrivals.teamId, adapterType: arrivals.adapterType, waits, since: mark });
          wakes = (await logArrivalsIn(trx, arrivals)).wakes;
        }
        for (const row of input.work) {
          queued.push(await queueRow(trx, { host: owner.host }, { ...row, payload: markedPayload(row.kind, row.payload, mark), teamId: row.teamId ?? owner.teamId }));
        }
        for (const wake of wakes ?? []) queued.push(await queueWake(trx, arrivals?.teamId ?? owner.teamId, wake));
        for (const fact of input.unjudged ?? []) await keepUnjudgedIn(trx, { tenant: owner.teamId }, fact);
        return { mark, wakes, queued };
      });
      if (written === null) return { kept: false };
      await announceQueued(written.queued);
      return written.wakes === undefined
        ? { kept: true, arrivalMark: written.mark }
        : { kept: true, arrivalMark: written.mark, wakes: written.wakes };
    },

    async keepRawDelivery({ delivery, work }) {
      const written = await inStoreTransaction(async (trx) => {
        await holdDoorsShared(trx, owner.teamId);
        // A waiting key names a delivery only for as long as a provider retries.
        if (delivery.externalId !== null && delivery.externalId.startsWith(WAITING_KEY_PREFIX)) {
          await sql`
            update automations.delivery set external_id = null
            where team_id = ${owner.teamId}::uuid and subscription_id = ${delivery.subscriptionId}::text and external_id = ${delivery.externalId}::text
              and received_at < now() - interval '1 day'`.execute(trx);
        }
        const { rows } = await sql<{ id: string; received_at: Date }>`
          insert into automations.delivery (id, team_id, subscription_id, external_id, received_at, source, inline, events, event_count, request)
          values (${delivery.id}::uuid, ${owner.teamId}::uuid, ${delivery.subscriptionId}::text, ${delivery.externalId}::text,
                  clock_timestamp(), ${delivery.source}::text, false, '[]'::jsonb, 0, ${JSON.stringify(delivery.request)}::text::jsonb)
          on conflict do nothing returning id::text as id, received_at`.execute(trx);
        const first = rows[0];
        if (first === undefined) {
          const before = await sql<{ id: string; judged: boolean; received_at: Date }>`
            select id::text as id, judged_at is not null as judged, received_at from automations.delivery
            where team_id = ${owner.teamId}::uuid and subscription_id = ${delivery.subscriptionId}::text and external_id = ${delivery.externalId}::text`.execute(trx);
          const kept = before.rows[0];
          if (kept === undefined) throw new Error(`delivery ${delivery.id} conflicted with no kept delivery`);
          return { id: kept.id, alreadyKept: true, judged: kept.judged, keptAt: kept.received_at, queued: [] };
        }
        const queued: Queued[] = [];
        for (const row of await work()) queued.push(await queueRow(trx, { host: owner.host }, { ...row, teamId: row.teamId ?? owner.teamId }));
        return { id: delivery.id, alreadyKept: false, judged: false, keptAt: first.received_at, queued };
      });
      await announceQueued(written.queued);
      return { id: written.id, alreadyKept: written.alreadyKept, judged: written.judged, keptAt: written.keptAt };
    },

    async judgedEmpty({ id }) {
      await sql`
        update automations.delivery
        set judged_at = now(), external_id = case when external_id like ${WAITING_KEY_PREFIX + '%'} then null else external_id end
        where id = ${id}::uuid and team_id = ${owner.teamId}::uuid and judged_at is null`.execute(storeDb());
    },

    /** The row gave up: kept dead with its reason, never claimed again,
     *  unless re-armed since the claim (then only unleased). Burying a
     *  `fire_event` row drops the waits it opened for runs that never started. */
    async bury(work) {
      const claim = workClaimOf(work);
      await inStoreTransaction(async (trx) => {
        const { rows } = await sql<{ key: string }>`
          update automations.work set dead_at = now(), dead_reason = ${work.reason}::text
          where id = ${claim.id}::uuid and lease_token::text = ${claim.leaseToken}::text and updated_at = ${claim.claimedUpdatedAt}
          returning key`.execute(trx);
        await sql`
          update automations.work set lease_owner = null, lease_until = null, lease_token = null
          where id = ${claim.id}::uuid and lease_token::text = ${claim.leaseToken}::text`.execute(trx);
        const buried = rows[0];
        if (buried !== undefined) await dropUnstartedWaits(trx, buried.key);
      });
    },

    /** A row its caller queued a lease out and ran itself, done: deleted
     *  unless a live claim holds it, with the waits it opened for runs that
     *  never started. */
    async completeKey({ key }) {
      return inStoreTransaction(async (trx) => {
        const result = await sql`
          delete from automations.work
          where host = ${owner.host}::text and key = ${key}::text and dead_at is null and (lease_until is null or lease_until < now())`.execute(trx);
        const done = Number(result.numAffectedRows ?? 0) > 0;
        if (done) await dropUnstartedWaits(trx, key);
        return done;
      });
    },

    /** The kept delivery's external id cleared, its receipt kept: a sender's
     *  retry under that id is kept as a delivery of its own. */
    async forgetDeliveryId({ id }) {
      if (!UUID.test(id)) return;
      await sql`
        update automations.delivery set external_id = null where id = ${id}::uuid and team_id = ${owner.teamId}::uuid`.execute(storeDb());
    },
  };
}
