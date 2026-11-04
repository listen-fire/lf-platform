// A tap on an ask's answer button carries the ask's answer token. The delivery
// it arrives in is ended by the door's own handling, so it is never kept: the
// token must not sit in the store for the days a kept delivery stays. A message
// on the same webhook is kept before either version reads it.

import { randomUUID } from 'node:crypto';

const mockKeep = jest.fn();
const mockTap = jest.fn();
jest.mock('../../inbound/carried_delivery', () => ({
  ...jest.requireActual('../../inbound/carried_delivery'),
  keepForEveryVersion: (...args: unknown[]) => mockKeep(...args),
}));
jest.mock('../telegram_callback_door', () => ({
  ...jest.requireActual('../telegram_callback_door'),
  handleTelegramCallbackQuery: (...args: unknown[]) => mockTap(...args),
  ownsCallbackQuery: () => true,
}));
jest.mock('../../translation_graph/adapters/resolve', () => ({
  ...jest.requireActual('../../translation_graph/adapters/resolve'),
  resolveAdapter: async () => ({ adapterType: 'telegram', preprocessInbound: async () => ({ events: [], arrivals: [] }) }),
}));

import { platformInboundStoreFor } from '../handler';

const subscription = {
  id: 'sub',
  teamId: randomUUID(),
  providerKey: 'TELEGRAM',
  credentialsId: randomUUID(),
  secret: 'whsec',
  grandfatheredUnsigned: false,
  checkpoint: null,
};

const ANSWER_TOKEN = 'ask-answer-token-123';
const tap = { update_id: 9, callback_query: { id: 'cbq_1', data: ANSWER_TOKEN, message: { message_id: 42, chat: { id: -1001 } } } };

async function openedFor(body: unknown) {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  const source = await platformInboundStoreFor({ rawBody, headers: { 'content-type': 'application/json' } }).sourceFor(subscription);
  return source?.open();
}

describe('what a Telegram door keeps', () => {
  beforeEach(() => {
    mockKeep.mockReset().mockResolvedValue({ kind: 'read', deliveryId: randomUUID(), keptAt: new Date() });
    mockTap.mockReset();
  });

  it('never keeps a button tap the door handles, so the answer token is not stored', async () => {
    mockTap.mockResolvedValue({ handled: true, outcome: 'recorded' });
    const opened = await openedFor(tap);

    expect(await opened?.intercept?.(tap)).toBe('handled');

    expect(mockKeep).not.toHaveBeenCalled();
  });

  it('keeps a tap the door passes on, before either version reads it', async () => {
    mockTap.mockResolvedValue({ handled: false });
    const opened = await openedFor(tap);

    expect(await opened?.intercept?.(tap)).toBe('continue');

    expect(mockKeep).toHaveBeenCalledTimes(1);
  });
});
