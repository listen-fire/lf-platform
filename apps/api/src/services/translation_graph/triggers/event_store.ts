// The trigger-event receipt — every inbound event a trigger receives is
// STORED before any processing runs:
//
//   receive  → insert a `trigger_event` row ('received'); the door queues a
//              `dispatch_event` work row and acks the sender
//              (dispatch_event.ts `receiveTriggerEvent`);
//   dispatch → the work row runs the normal trigger dispatch from the
//              receipt and records the outcome here ('dispatched' |
//              'failed' + failure_reason | 'suppressed');
//   replay   → a stored event is queued again as a new run
//              (dispatch_event.ts `replayTriggerEvent`) — the recovery path
//              for events that failed.
//
// The row is the durable record of WHAT ARRIVED, independent of whether
// processing ever ran — `trigger_run.trigger_payload` only exists once a
// firing recorded, so a crash between receipt and recording used to lose
// the event entirely (and the sender waited on the whole run before its
// ack).

import { sql } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerEventId } from '../../../generated/kysely/automations/TriggerEvent';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { getAutomationsQb } from '../../../lib/kysely';

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
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
  event: TriggerEvent;
}): Promise<{ id: TriggerEventId; duplicate: boolean }> {
  const externalEventId = input.event.idempotencyKey ?? null;
  const inserted = await getAutomationsQb(['trigger_event'])
    .insertInto('trigger_event')
    .values({
      team_id: input.teamId,
      trigger_id: input.triggerId,
      adapter_type: input.event.adapterType,
      trigger_type: input.event.triggerType,
      payload: jsonb(JSON.parse(JSON.stringify(input.event))) as never,
      external_event_id: externalEventId,
      ...(input.event.occurredAt !== undefined
        ? { occurred_at: new Date(input.event.occurredAt) }
        : {}),
    })
    .onConflict((oc) =>
      oc.columns(['trigger_id', 'external_event_id']).where('external_event_id', 'is not', null).doNothing(),
    )
    .returning('id')
    .executeTakeFirst();

  if (inserted) return { id: inserted.id, duplicate: false };

  // Conflict: this delivery id was already received for this trigger (only
  // reachable when externalEventId is non-null — the partial index). Return the
  // first delivery's row id so the receipt is still addressable, flagged dup.
  const existing = await getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('trigger_id', '=', input.triggerId)
    .where('external_event_id', '=', externalEventId)
    .select('id')
    .executeTakeFirstOrThrow();
  return { id: existing.id, duplicate: true };
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

/**
 * Reset a stored event back to 'received' so its queued row runs it. Used by
 * the loop guard's queue-don't-drop deferred release: an event held by a rate
 * throttle goes back on the queue, due after the rate window. Best-effort —
 * the event is replayable by hand regardless.
 */
export async function resetTriggerEventToReceived(eventId: string): Promise<void> {
  await getAutomationsQb(['trigger_event'])
    .updateTable('trigger_event')
    .set({ status: 'received', dispatched_at: null, failure_reason: null })
    .where('id', '=', eventId as TriggerEventId)
    .execute()
    .catch(() => {});
}

/** The stored events for one trigger, newest first (playback picker). */
export async function listTriggerEvents(input: {
  teamId: TeamId;
  triggerId: string;
  limit?: number;
}) {
  return getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('team_id', '=', input.teamId)
    .where('trigger_id', '=', input.triggerId)
    .select([
      'id',
      'trigger_id',
      'adapter_type',
      'trigger_type',
      'status',
      'dispatched_at',
      'failure_reason',
      'occurred_at',
      'created_at',
    ])
    .orderBy('created_at', 'desc')
    .limit(Math.min(input.limit ?? 25, 100))
    .execute();
}
