// A Valuations webhook delivery, as events. The platform's Valuations outbox
// worker sends one delivery per change, `{event, timestamp, actor: {type, id},
// data: {id, before, after}}`; each becomes one event carrying the whole
// delivery as its payload, so trigger filters and field reads can reach
// `data.after.<field>` by dot path.

import { z } from 'zod';

import type { DiscriminableEvent } from 'movement-engine/public/adapter';

const actorSchema = z.object({
  type: z.enum(['user', 'api-token', 'system']),
  id: z.string().nullable(),
});

const deliverySchema = z.object({
  /** "valuations:<entity>:<create|update|delete>" — exactly the row.type the
   *  outbox worker emits. */
  event: z.string(),
  timestamp: z.string(),
  actor: actorSchema,
  data: z.object({
    id: z.string(),
    before: z.unknown().nullable().optional(),
    after: z.unknown().nullable().optional(),
  }),
});

/** The change an event names. The rule every webhook source shared before
 *  sources parsed their own deliveries: it looks for `created`, `updated` and
 *  `deleted`, which the outbox's `:create` / `:update` / `:delete` never
 *  spell, so a Valuations event carries no change type. Kept as it was:
 *  movements may already rely on its absence. */
function changeTypeOf(eventType: string): 'create' | 'update' | 'delete' | undefined {
  if (eventType.includes('created')) return 'create';
  if (eventType.includes('updated')) return 'update';
  if (eventType.includes('deleted')) return 'delete';
  return undefined;
}

/**
 * Parse one delivery into events (0 or 1). A body that is not a delivery
 * yields `[]`, never a throw: a webhook door must not 500 on a stray POST.
 * The entity (`legal_entity`, …), the event's middle segment, is its record
 * type; the row's id is its record id.
 */
export function parseValuationsEvents(raw: unknown): DiscriminableEvent[] {
  const parsed = deliverySchema.safeParse(raw);
  if (!parsed.success) return [];
  const delivery = parsed.data;
  const changeType = changeTypeOf(delivery.event);
  return [
    {
      payload: delivery,
      externalId: delivery.data.id,
      recordType: delivery.event.split(':')[1] ?? '',
      eventType: delivery.event,
      ...(changeType !== undefined ? { changeType } : {}),
      actor: { type: delivery.actor.type, id: delivery.actor.id },
    },
  ];
}
