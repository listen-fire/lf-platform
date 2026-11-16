// The trigger-event receipt — every inbound event a trigger receives is
// STORED before any processing runs:
//
//   receive  → insert a `trigger_event` row ('received'); the door queues a
//              `dispatch_event` work row and acks the sender
//              (dispatch_event.ts `receiveTriggerEvent`);
//   dispatch → the work row runs the normal trigger dispatch from the
//              receipt and records the outcome here ('dispatched' |
//              'failed' + failure_reason | 'suppressed');
//
// 0.12's alone: the current version keeps its deliveries (inbound/listen_door.ts).
//
// The row is the durable record of WHAT ARRIVED, independent of whether
// processing ever ran — `trigger_run.trigger_payload` only exists once a
// firing recorded, so a crash between receipt and recording used to lose
// the event entirely (and the sender waited on the whole run before its
// ack).

import { sql, type QueryExecutorProvider } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerEventId } from '../../../generated/kysely/automations/TriggerEvent';
import type { CarriedEventRecord } from '@listen-fire/language-versions';

import { getAutomationsQb } from '../../../lib/kysely';

/** An event as a carried version read it: its JSON, and what the platform
 *  records of it. */
export interface StoredEvent {
  json: Readonly<Record<string, unknown>>;
  record: CarriedEventRecord;
}

/**
 * Persist a received event. Synchronous part of the receive path — the
 * caller queues the receipt's work row and acks the sender right after.
 *
 * Idempotent when the event carries an `idempotencyKey` (the source's own
 * per-delivery id): the partial unique index on (trigger_id, external_event_id)
 * makes an at-least-once redelivery a no-op insert. `duplicate: true` signals
 * the caller to SKIP dispatch — the first delivery already owns the run.
 */
export async function storeTriggerEvent(input: {
  teamId: TeamId;
  triggerId: string;
  /** The event in its own version's shape, read by that version. */
  event: StoredEvent;
  /** The kept delivery it was judged from, when one was kept. */
  deliveryId?: string;
  /** The transaction the receipt is written in, with what it is the receipt of. */
  db?: QueryExecutorProvider;
}): Promise<{ id: TriggerEventId; duplicate: boolean }> {
  const db = input.db ?? getAutomationsQb(['trigger_event']);
  const { record } = input.event;
  const externalEventId = record.idempotencyKey ?? null;
  const { rows: inserted } = await sql<{ id: TriggerEventId }>`
    insert into automations.trigger_event (team_id, trigger_id, adapter_type, trigger_type, payload, external_event_id, delivery_id, occurred_at)
    values (${input.teamId}::uuid, ${input.triggerId}::text, ${record.adapterType}::text, ${record.triggerType}::text, ${JSON.stringify(input.event.json)}::text::jsonb,
            ${externalEventId}::text, ${input.deliveryId ?? null}::uuid, coalesce(${record.occurredAt ?? null}::timestamptz, current_timestamp))
    on conflict (trigger_id, external_event_id) where external_event_id is not null do nothing
    returning id`.execute(db);
  const [first] = inserted;
  if (first !== undefined) return { id: first.id, duplicate: false };

  // Conflict: this delivery id was already received for this trigger (only
  // reachable when externalEventId is non-null — the partial index). Return the
  // first delivery's row id so the receipt is still addressable, flagged dup.
  const { rows: existing } = await sql<{ id: TriggerEventId }>`
    select id from automations.trigger_event where trigger_id = ${input.triggerId}::text and external_event_id = ${externalEventId}::text`.execute(db);
  const [held] = existing;
  if (held === undefined) throw new Error(`the receipt of trigger ${input.triggerId} under ${externalEventId} conflicted and is not there`);
  return { id: held.id, duplicate: true };
}

/** Outcome markers the dispatch half records on the receipt. */
export async function markTriggerEventDispatched(eventId: string): Promise<void> {
  await getAutomationsQb(['trigger_event'])
    .updateTable('trigger_event')
    .set({ status: 'dispatched', dispatched_at: new Date(), failure_reason: null })
    .where('id', '=', eventId as TriggerEventId)
    .execute()
    .catch(() => {});
}

export async function markTriggerEventFailed(eventId: string, reason: string): Promise<void> {
  await getAutomationsQb(['trigger_event'])
    .updateTable('trigger_event')
    .set({ status: 'failed', dispatched_at: new Date(), failure_reason: reason })
    .where('id', '=', eventId as TriggerEventId)
    .execute()
    .catch(() => {});
}

/**
 * Mark a stored event SUPPRESSED — the opt-in `suppress_self` echo-suppression
 * recognised it as the author's own write echoing back (see
 * `echo_suppression.ts`). The event is RECORDED, not dropped: it stays in the
 * table at status='suppressed' with the reason, fully auditable and replayable
 * by hand (a self-echo the author later decides they want is just a replay).
 * Best-effort — recording the disposition must never block the door.
 */
export async function markTriggerEventSuppressed(eventId: string, reason: string): Promise<void> {
  await getAutomationsQb(['trigger_event'])
    .updateTable('trigger_event')
    .set({ status: 'suppressed', dispatched_at: new Date(), failure_reason: reason })
    .where('id', '=', eventId as TriggerEventId)
    .execute()
    .catch(() => {});
}
