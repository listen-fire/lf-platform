// A kept delivery's one write and the rows it queues (listen-fire 0.13's
// `DeliveryRowStore`: `inbound.keepDelivery`, `work.bury`,
// `work.completeKey`, `inbound.forgetDeliveryId`), over automations.delivery,
// inbound_checkpoint, work and the waits tables. Ported from
// @lf/postgres-store (crates/lf/src/pg_store.rs). One store is one team's
// deliveries, kept for one host: the platform's door, or a cloud lf through
// the store module.

import { sql } from 'kysely';

import type { DeliveryRowStore, KeepDelivery, WaitWake } from 'movement-engine/public/run-host';

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

const FIRE_EVENT = 'fire_event';

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
export function deliveryRowStore(owner: { host: Host; teamId: string }): DeliveryRowStore {
  return {
    /**
     * The receipt first: a duplicate (its id, or its external id kept at its
     * subscription before, even by a transaction still open, which the unique
     * index waits on) writes nothing and answers `kept: false`. Then the
     * cursor, the waits of the runs it queues (from the mark before its
     * arrivals), its arrivals and the wakes they answer, and its rows.
     */
    async keepDelivery(input: KeepDelivery) {
      const { subscriptionId, delivery, arrivals } = input;
      const waits = input.waits ?? [];
      if (arrivals === undefined && waits.length > 0) {
        throw new Error("inbound.keepDelivery: `waits` came without `arrivals`; a delivery's waits are opened with its arrivals, under their team and adapter");
      }
      if (owner.host === 'platform') {
        for (const row of input.work) if (!isWorkKind(row.kind)) throw new Error(`'${row.kind}' is not a work kind this process knows`);
      }
      const written = await inStoreTransaction(async (trx) => {
        const { rows } = await sql<{ id: string }>`
          insert into automations.delivery (id, team_id, subscription_id, external_id, received_at, source, inline, replay_of, events, event_count, request)
          values (${delivery.id}::uuid, ${owner.teamId}::uuid, ${subscriptionId}::text, ${delivery.externalId ?? null}::text,
                  ${delivery.receivedAt}::timestamptz, ${delivery.source}::text, ${delivery.inline}::bool, ${delivery.replayOf ?? null}::uuid,
                  ${JSON.stringify(delivery.events)}::text::jsonb, ${delivery.events.length}::int,
                  ${delivery.request === undefined ? null : JSON.stringify(delivery.request)}::text::jsonb)
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
        return { mark, wakes, queued };
      });
      if (written === null) return { kept: false };
      await announceQueued(written.queued);
      return written.wakes === undefined
        ? { kept: true, arrivalMark: written.mark }
        : { kept: true, arrivalMark: written.mark, wakes: written.wakes };
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
