// The graph's change events, in the engine's currency.
//
// The store derives one event per changed record at the commit of a write and
// hands it to the host as an envelope — `{ event, timestamp, data }` — the same
// envelope whichever way the host carries it (in process, or a signed POST
// from a store in another process). The host runs it through `preprocessInbound`
// like any adapter's delivery and queues a run per matching listen; nothing
// here runs a movement.

import { z } from 'zod';

import type { DiscriminableEvent } from 'movement-engine/public/adapter';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { mutationContextSchema } from 'movement-engine/public/adapter';

/** The change kinds a `listen to <graph> { events: [...] }` subscribes to, in
 *  Listen-Fire's uniform `record.*` currency (the same names attio and
 *  airtable use, so authoring and dispatch stay adapter-neutral). */
export const KG_SUBSCRIBABLE_EVENTS = ['record.created', 'record.updated', 'record.deleted'] as const;

export const recordChangeKindSchema = z.enum(['create', 'update', 'delete']);
export type RecordChangeKind = z.infer<typeof recordChangeKindSchema>;

/** One changed record, coalesced from the property writes of one store
 *  transaction. */
export const recordMutationEventSchema = z.object({
  recordId: z.string().uuid(),
  nodeTypeId: z.string(),
  changeKind: recordChangeKindSchema,
  /** Property type ids whose canonical value changed (a create's initial
   *  fields; empty for a delete); edge type ids for links. */
  changedFields: z.array(z.string()),
  context: mutationContextSchema,
});
export type RecordMutationEvent = z.infer<typeof recordMutationEventSchema>;

/** The envelope the store delivers. Parsed rather than trusted: a body is
 *  somebody else's claim until it typechecks. `data` is read loosely here and
 *  strictly below, so a provenance bag the strict schema refuses still fires
 *  its listeners (loudly) rather than vanishing. */
const mutationEnvelopeSchema = z.object({
  event: z.enum([...KG_SUBSCRIBABLE_EVENTS]),
  timestamp: z.string(),
  data: z.object({
    recordId: z.string(),
    nodeTypeId: z.string(),
    changeKind: recordChangeKindSchema,
    changedFields: z.array(z.string()),
    context: z.record(z.string(), z.unknown()),
  }),
});

const CHANGE_TYPE_BY_EVENT: Record<(typeof KG_SUBSCRIBABLE_EVENTS)[number], RecordChangeKind> = {
  'record.created': 'create',
  'record.updated': 'update',
  'record.deleted': 'delete',
};

/**
 * The store's envelope as one event. The payload is the changed record's
 * event (`recordId`, `nodeTypeId`, `changeKind`, `changedFields`, `context`):
 * `didWeAuthor` computes the whole `suppress_self` answer from its context,
 * and a listen's `fields:` filter reads `changedFields`. The event happened
 * when the write did (`context.occurredAt`, which is also the envelope's
 * timestamp).
 */
export function changeEventsOf(
  raw: unknown,
  warn: (message: string, meta?: Record<string, unknown>) => void,
): DiscriminableEvent[] {
  const parsed = mutationEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return [];
  const { event, timestamp, data } = parsed.data;
  const strict = recordMutationEventSchema.safeParse(data);
  if (!strict.success) {
    // A provenance bag that did not survive the write is a `suppress_self`
    // that can no longer answer: said once, here, and the listener still fires.
    warn('[kg] a change event whose payload does not match the event contract — delivered as read', {
      event,
      recordId: data.recordId,
      issues: strict.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const payload = strict.success ? strict.data : data;
  return [
    {
      payload,
      eventType: event,
      recordType: data.nodeTypeId,
      externalId: data.recordId,
      changedFields: data.changedFields,
      occurredAt: strict.success ? strict.data.context.occurredAt : timestamp,
      changeType: CHANGE_TYPE_BY_EVENT[event],
    },
  ];
}

/**
 * "Did WE author this change?" — the `suppress_self` capability, answered
 * purely from the change's own provenance (no round trip, no recent-write
 * cache). Scoped to this change's authorship, never the record's identity:
 *
 *   - `structured_input` / `extraction` produced by a movement or trigger (a
 *     `translationGraphId` or a `trigger:`-marked `pipelineInputId`) is our
 *     own automated write → `true`.
 *   - `user_edit` / `agent` / `api` — a person (or an interactive agent, a
 *     direct API call) editing a record, even one automation once wrote — is
 *     not → `false`, fires normally.
 *   - no recognisable provenance → `null` (cannot tell; do not suppress).
 */
export function didWeAuthorChange(event: TriggerEvent): boolean | null {
  const parsed = recordMutationEventSchema.pick({ context: true }).safeParse(event.payload);
  if (!parsed.success) return null;
  const source = parsed.data.context.source;
  if (source.type !== 'structured_input' && source.type !== 'extraction') return false;
  return (
    source.translationGraphId !== undefined ||
    (typeof source.pipelineInputId === 'string' && source.pipelineInputId.startsWith('trigger:'))
  );
}
