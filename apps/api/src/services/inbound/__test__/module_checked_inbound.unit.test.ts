// A module that checks its own inbound (`inbound.scheme: module`): the core
// hands it the raw request, and the door answers what it decided — its events
// queued, its refusal, or its reply sent as it is (a handshake).

import type { DiscriminableEvent, InboundCheck, InboundCheckInput } from 'movement-engine/public/adapter';
import type { InboundStore } from 'movement-engine/public/inbound';

import { CHECKED_BY_MODULE, UNREGISTERED_SECRET, answerDelivery } from 'movement-engine/public/inbound';

function storeAnswering(answer: InboundCheck, secret = 'key') {
  const seen: InboundCheckInput[] = [];
  const queued: DiscriminableEvent[] = [];
  const wakes: string[] = [];
  const store: InboundStore<DiscriminableEvent> = {
    findSubscription: async (id) =>
      id === 'sub' ? { id, teamId: 't', providerKey: 'MAIL', credentialsId: 'c', secret, grandfatheredUnsigned: false, checkpoint: null } : null,
    knowsProvider: (key) => key === 'MAIL',
    intercepts: () => [],
    sourceFor: async () => ({
      verifier: CHECKED_BY_MODULE,
      secret,
      open: async () => ({
        adapterType: 'mail',
        credentialsId: 'c',
        adapter: {
          adapterType: 'mail',
          checkInbound: async (input: InboundCheckInput) => {
            seen.push(input);
            return answer;
          },
          preprocessInbound: async () => {
            throw new Error('never read for a module that checks its own inbound');
          },
        },
      }),
    }),
    verifiesSignature: () => true,
    capture: async ({ event }) => event,
    saveCheckpoint: async () => {},
    enqueue: async ({ event }) => void queued.push(event),
    enqueueWakes: async ({ keys }) => void wakes.push(...keys),
  };
  return { store, seen, queued, wakes };
}

const host = { notify: () => {} };
const deliver = (store: InboundStore<DiscriminableEvent>, method = 'POST') =>
  answerDelivery(store, host, {
    provider: 'mail',
    subscriptionId: 'sub',
    rawBody: Buffer.from('a=b'),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method,
    path: '/api/public/webhook-sync/mail/sub',
    query: 'x=1',
  });

describe('a module that checks its own inbound', () => {
  it('is handed the raw request and its secret; its events and wakes are queued', async () => {
    const { store, seen, queued, wakes } = storeAnswering({ outcome: 'accepted', events: [{ payload: { n: 1 } }], wakeKeys: ['k1'] });
    const answer = await deliver(store);
    expect([answer.status, answer.body]).toEqual([200, { ok: true, eventsProcessed: 1 }]);
    expect(seen[0]).toEqual({
      request: {
        method: 'POST',
        path: '/api/public/webhook-sync/mail/sub',
        query: 'x=1',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: Buffer.from('a=b').toString('base64'),
      },
      secret: 'key',
    });
    expect([queued.length, wakes]).toEqual([1, ['k1']]);
  });

  it('is handed no secret when the subscription holds no usable one', async () => {
    const { store, seen } = storeAnswering({ outcome: 'refused' }, UNREGISTERED_SECRET);
    const answer = await deliver(store);
    expect([answer.status, answer.body]).toEqual([401, { error: 'signature_invalid' }]);
    expect(seen[0]?.secret).toBeUndefined();
  });

  it('refuses with the status it names', async () => {
    const answer = await deliver(storeAnswering({ outcome: 'refused', status: 406 }).store);
    expect(answer.status).toBe(406);
  });

  it('answers a GET handshake with its reply, as text, running nothing', async () => {
    const { store, queued } = storeAnswering({ outcome: 'reply', status: 200, text: 'challenge-1' });
    const answer = await deliver(store, 'GET');
    expect(answer).toEqual({ status: 200, body: 'challenge-1', contentType: 'text/plain' });
    expect(queued).toEqual([]);
  });
});
