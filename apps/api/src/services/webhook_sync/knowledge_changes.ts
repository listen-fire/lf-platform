// The knowledge graph's change events, carried the way every adapter's events
// are.
//
// The graph's store (the knowledge unit) commits an outbox row with each write.
// Where the store runs beside us (KNOWLEDGE_MUTATION_DELIVERY=local, the
// shipped default) nothing POSTs it: a periodic work kind drains the outbox and
// hands each envelope to the `@lf/kg` module's `preprocessInbound`, whose
// arrivals are kept as a delivery the way a webhook's are: judged by the
// team's listens on the graph, with a `fire_event` row per run it starts
// (inbound/listen_door.ts). The movement runs when a drainer claims that row:
// the server's drain loop, or a scheduled `drain:once`. Nothing here runs a
// movement, and nothing runs in a request.
//
// Where the store is another process (`webhook`), its signed POST reaches the
// webhook door instead and takes the same tail from there; this kind is not
// registered.

import type { TeamId } from '../../generated/kysely/core/Team';
import type { MutationEventEnvelope } from '../../lib/knowledge/store/events';

import { KG_ADAPTER_TYPE } from '@listen-fire/kg/manifest';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { SECOND } from '../../constants';
import { getAutomationsQb } from '../../lib/kysely';
import { logger } from 'movement-engine/public/log';
import { drainOnce } from '../knowledge/mutation_outbox/worker';
import { notifyWork, registerWorkKinds } from '../work/drain';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { deliverArrivals } from '../inbound/listen_door';
import { capturedRequest } from '../inbound/captured_request';
import { NATIVE_KNOWLEDGE_PROVIDER_KEY } from './providers/native_knowledge';

declare module '../work/kinds' {
  interface UnitWorkKinds {
    knowledge_changes: true;
  }
}

/** How often the outbox is drained: the knowledge unit's own loop's cadence. */
const DRAIN_EVERY_MS = 2 * SECOND;

/**
 * One change event into the work queue: the module reads the envelope, and
 * its arrivals are kept as one delivery, with a run queued for every listen
 * they fire. Keyed on the outbox row, so a redelivery (a drain that died
 * between keeping the delivery and marking the row delivered) keeps nothing
 * twice.
 *
 * The delivery is the graph's install's, as for a shared bot's deliveries:
 * the change is the team's graph's, not one connection's, so every listen on
 * the graph judges it.
 */
export async function queueKnowledgeChange(input: {
  teamId: string;
  envelope: MutationEventEnvelope;
  outboxId: string;
}): Promise<{ queued: number }> {
  const teamId = input.teamId as TeamId;
  // The module reads the changed record through the team's connection to the
  // graph. A team with none has no listen on the graph to hear the change.
  const connection = await knowledgeConnectionOf(teamId);
  if (connection === undefined) {
    logger.info('[knowledge] a change on a team with no connection to its graph is heard by no listen', { teamId, outboxId: input.outboxId });
    return { queued: 0 };
  }
  const adapter = await resolveAdapter({ adapterType: KG_ADAPTER_TYPE, teamId, credentialsId: connection });
  if (adapter.preprocessInbound === undefined) {
    throw new Error('the knowledge graph module reads no inbound events (preprocessInbound)');
  }
  const { arrivals = [] } = await adapter.preprocessInbound({ raw: input.envelope });
  if (arrivals.length === 0) return { queued: 0 };
  const { kept, fires } = await deliverArrivals({
    teamId,
    delivered: { adapterType: KG_ADAPTER_TYPE, credentialsId: null },
    subscriptionId: NATIVE_KNOWLEDGE_PROVIDER_KEY,
    externalId: `knowledge_outbox:${input.outboxId}`,
    source: 'emit',
    arrivals,
    // The change as the graph wrote it, read again by the module on a replay.
    request: capturedRequest({
      keeping: undefined,
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from(JSON.stringify(input.envelope), 'utf8'),
      arrivals,
    }),
  });
  if (!kept.kept) return { queued: 0 };
  notifyWork();
  return { queued: fires.length };
}

/** The team's connection to its graph: its first, where it has made more. */
async function knowledgeConnectionOf(teamId: TeamId): Promise<string | undefined> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId)
    .where('type', '=', ExternalServiceType.NATIVE_KNOWLEDGE)
    .orderBy('created_at', 'asc')
    .select(['id'])
    .executeTakeFirst();
  return row?.id;
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
