// The composition root's asks wiring: the composed deployment's answer to "an
// ask settled, now what".
//
// Asks publishes a notifier interface and nothing more — it does not know the
// movement engine, parked runs, or their waits exist. Automations knows all
// three and nothing about how an answer got written. This module is the only
// place that knows both, which is the same shape as the knowledge mutation
// subscriber and the knowledge usage sink: the two products meet here and
// nowhere else.
//
// An answer is an arrival on the ask's `Response`, delivered as any module's
// arrival is (listen_door.ts): logged in one write that wakes the run waiting
// on the ask (keyed by its id), and judged by the team's listens on
// `Response`. A cancel reports the ask gone: a run waiting on it is stranded
// and its program hears `Wait Lost Its Record`, which it may race with a
// sleep. Being registered is what tells the cancel door a drain exists here.

import type { AskRecord } from './store';

import { ASK_ADAPTER_TYPE, RESPONSE_EDGE_NAME, responseArrival } from '@listen-fire/ask';
import { registerAskSettledNotifier } from './notifier';
import { deliverArrivals } from '../inbound/listen_door';
import { notifyWork } from '../work/drain';

/** The ask's settle, delivered as its `Response`'s arrival. The ask's id
 *  names the delivery, so a settle told twice is kept once. */
export async function deliverSettle(ask: AskRecord): Promise<void> {
  const arrival =
    ask.state === 'answered'
      ? responseArrival({ id: ask.id, family: ask.family, answer: ask.answer, state: 'answered' })
      : { edge: RESPONSE_EDGE_NAME, key: ask.id, gone: true as const };
  await deliverArrivals({
    teamId: ask.teamId,
    delivered: { adapterType: ASK_ADAPTER_TYPE, credentialsId: null },
    subscriptionId: ASK_ADAPTER_TYPE,
    externalId: `${ask.state}:${ask.id}`,
    source: 'hook',
    arrivals: [arrival],
  });
  notifyWork();
}

export function notifyEngineOfSettledAsks(): void {
  registerAskSettledNotifier({ notify: deliverSettle, cancelled: deliverSettle });
}
