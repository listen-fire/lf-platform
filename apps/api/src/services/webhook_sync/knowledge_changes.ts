// The knowledge graph's change events, carried the way every adapter's events
// are.
//
// The graph's store (the knowledge unit) commits an outbox row with each write.
// Where the store runs beside us (KNOWLEDGE_MUTATION_DELIVERY=local, the
// shipped default) nothing POSTs it: a periodic work kind drains the outbox and
// hands each envelope to the `@lf/kg` module's `preprocessInbound`, then the
// same capture-and-queue tail a webhook delivery takes — one durable receipt
// and one `dispatch_event` row per matching listen. The movement runs when a
// drainer claims that row: the server's drain loop, or a scheduled
// `drain:once`. Nothing here runs a movement, and nothing runs in a request.
//
// Where the store is another process (`webhook`), its signed POST reaches the
// webhook door instead and takes the same tail from there; this kind is not
// registered.

import type { TeamId } from '../../generated/kysely/core/Team';
import type { MutationEventEnvelope } from '../../lib/knowledge/store/events';

import { KG_ADAPTER_TYPE } from '@listen-fire/kg/manifest';
import { SECOND } from '../../constants';
import { drainOnce } from '../knowledge/mutation_outbox/worker';
import { registerWorkKinds } from '../work/drain';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { enqueueCapturedEvents } from '../translation_graph/triggers/dispatch_event';
import { captureProviderTriggerEvents } from './handler';
import { NATIVE_KNOWLEDGE_PROVIDER_KEY } from './providers/native_knowledge';

declare module '../work/kinds' {
  interface UnitWorkKinds {
    knowledge_changes: true;
  }
}

/** How often the outbox is drained: the knowledge unit's own loop's cadence. */
const DRAIN_EVERY_MS = 2 * SECOND;

/**
 * One change event into the work queue: the module reads the envelope, and a
 * receipt plus a run row is queued for every listen it matches. Keyed on the
 * outbox row, so a redelivery (a drain that died between queueing and marking
 * the row delivered) is a duplicate receipt and queues nothing twice.
 *
 * The listen's own connection is the one its run uses, as for a shared bot's
 * deliveries: the event is the team's graph's, not one connection's.
 */
export async function queueKnowledgeChange(input: {
  teamId: string;
  envelope: MutationEventEnvelope;
  outboxId: string;
}): Promise<{ queued: number }> {
  const teamId = input.teamId as TeamId;
  const adapter = await resolveAdapter({ adapterType: KG_ADAPTER_TYPE, teamId });
  if (adapter.preprocessInbound === undefined) {
    throw new Error('the knowledge graph module reads no inbound events (preprocessInbound)');
  }
  const { events } = await adapter.preprocessInbound({ raw: input.envelope });
  let queued = 0;
  for (const event of events) {
    const receipts = await captureProviderTriggerEvents({
      event: { ...event, idempotencyKey: `knowledge_outbox:${input.outboxId}` },
      subscription: { team_id: teamId, credentials_id: null, provider: NATIVE_KNOWLEDGE_PROVIDER_KEY },
      adapterType: KG_ADAPTER_TYPE,
      matchAnyCredential: true,
      eventTypes: [],
    });
    await enqueueCapturedEvents(receipts);
    queued += receipts.filter((receipt) => !receipt.duplicate).length;
  }
  return { queued };
}

/** The periodic kind that carries the outbox into the queue (registered only
 *  where the store runs beside us). */
export function registerKnowledgeChangeWork(): void {
  registerWorkKinds([
    {
      kind: 'knowledge_changes',
      intervalMs: DRAIN_EVERY_MS,
      handler: {
        async run() {
          await drainOnce({ deliverLocally: async (change) => void (await queueKnowledgeChange(change)) });
        },
      },
    },
  ]);
}
