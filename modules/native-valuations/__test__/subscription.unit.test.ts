// A listen on a Valuations record's `Changes` gets a Valuations webhook
// provisioned through the adapter's ensureEventSubscription (the
// `syncListenSubscriptions` bridge), as Attio's does. These guard the manifest
// opt-in the reconciler gates on, and the adapter delegating to the shared
// register/deregister helper.

const registerValuationsWebhook = jest.fn(async (_api: unknown, _input: unknown) => ({ externalId: 'https://cb', secret: 'shh' }));
const deregisterValuationsWebhook = jest.fn(async (_api: unknown, _input: unknown) => {});
jest.mock('../webhook', () => ({
  registerValuationsWebhook: (api: unknown, input: unknown) => registerValuationsWebhook(api, input),
  deregisterValuationsWebhook: (api: unknown, input: unknown) => deregisterValuationsWebhook(api, input),
}));

import { NativeValuationsAdapter } from '../adapter';
import { NATIVE_VALUATIONS_MANIFEST } from '../manifest';

const API = { apiKey: 'k', baseUrl: 'http://vals.test', fetch };
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const adapter = (api: typeof API | null = API) => new NativeValuationsAdapter({ api: async () => api, log: quiet });

beforeEach(() => jest.clearAllMocks());

describe('native-valuations manifest — movement-listen opt-in', () => {
  it('declares ensureEventSubscription + removeEventSubscription', () => {
    expect(NATIVE_VALUATIONS_MANIFEST.methods).toEqual(
      expect.arrayContaining(['ensureEventSubscription', 'removeEventSubscription', 'awaitKeys']),
    );
  });
});

describe('NativeValuationsAdapter.ensureEventSubscription', () => {
  it('registers one webhook for every entity’s changes at the callback URL', async () => {
    const result = await adapter().ensureEventSubscription!({ edge: 'Changes', callbackUrl: 'https://cb' });
    expect(registerValuationsWebhook).toHaveBeenCalledTimes(1);
    const [, input] = registerValuationsWebhook.mock.calls[0] ?? [];
    expect(input).toMatchObject({ targetUrl: 'https://cb' });
    expect(input).toHaveProperty('eventTypes', expect.arrayContaining(['valuations:legal_entity:update', 'valuations:investment:delete', 'valuations:asset_transfer:create']));
    expect(result).toEqual({ externalId: 'https://cb', secret: 'shh' });
  });

  it('keeps the webhook it holds', async () => {
    const result = await adapter().ensureEventSubscription!({ edge: 'Changes', callbackUrl: 'https://cb', current: { externalId: 'https://cb' } });
    expect(result).toBeUndefined();
    expect(registerValuationsWebhook).not.toHaveBeenCalled();
  });

  it('refuses an edge that is not listenable', async () => {
    await expect(adapter().ensureEventSubscription!({ edge: 'Investments', callbackUrl: 'https://cb' })).rejects.toThrow("'Investments' is not a listenable edge");
  });
});

describe('an install with no credential', () => {
  it('provisions nothing and removes nothing', async () => {
    expect(await adapter(null).ensureEventSubscription!({ edge: 'Changes', callbackUrl: 'https://cb' })).toBeUndefined();
    await adapter(null).removeEventSubscription!({ callbackUrl: 'https://cb', externalId: 'https://cb' });
    expect(registerValuationsWebhook).not.toHaveBeenCalled();
    expect(deregisterValuationsWebhook).not.toHaveBeenCalled();
  });
});

describe('NativeValuationsAdapter.removeEventSubscription', () => {
  it('deregisters by the held externalId', async () => {
    await adapter().removeEventSubscription!({ callbackUrl: 'https://cb', externalId: 'https://cb' });
    expect(deregisterValuationsWebhook).toHaveBeenCalledWith(API, { externalId: 'https://cb' });
  });
});
