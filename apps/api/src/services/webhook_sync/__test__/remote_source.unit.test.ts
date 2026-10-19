// A remote install's inbound source: whether its module checks its own inbound
// is read off the install's stored manifest, so a delivery the host verifies
// is turned away before the adapter is resolved, and the adapter is resolved
// once, only when a delivery is read.

import { randomUUID } from 'node:crypto';

import { CHECKED_BY_MODULE } from 'movement-engine/public/inbound';

const mockInstalls: unknown[] = [];
const mockResolve = jest.fn();
jest.mock('../../translation_graph/adapters/remote/store', () => ({
  ...jest.requireActual('../../translation_graph/adapters/remote/store'),
  listRemoteAdapters: async () => mockInstalls,
}));
jest.mock('../../translation_graph/adapters/resolve', () => ({
  ...jest.requireActual('../../translation_graph/adapters/resolve'),
  resolveAdapter: (...args: unknown[]) => mockResolve(...args),
}));

import { platformInboundStore } from '../handler';
import { webhookProviderKey } from '../urls';

const ADAPTER_TYPE = 'acme_mail';

function install(methods: string[]) {
  const manifest = {
    adapterType: ADAPTER_TYPE,
    baseUrl: 'https://acme-mail.test',
    authStrategy: { kind: 'bearer' },
    supportedTriggers: ['webhook'],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods,
    protocolVersion: 2,
  };
  return { adapter_type: ADAPTER_TYPE, credentials_id: randomUUID(), manifest };
}

const subscription = {
  id: 'sub',
  teamId: randomUUID(),
  providerKey: webhookProviderKey({ adapterType: ADAPTER_TYPE }),
  credentialsId: 'c',
  secret: 'whsec',
  grandfatheredUnsigned: false,
  checkpoint: null,
};

describe('a remote install as an inbound source', () => {
  beforeEach(() => {
    mockInstalls.length = 0;
    mockResolve.mockReset().mockResolvedValue({ adapterType: ADAPTER_TYPE });
  });

  it('is verified by the host when its stored manifest lists no checkInbound, and resolves nothing until read', async () => {
    mockInstalls.push(install(['manifest', 'preprocessInbound']));
    const source = await platformInboundStore.sourceFor(subscription);
    expect(source?.verifier).not.toBe(CHECKED_BY_MODULE);
    expect(mockResolve).not.toHaveBeenCalled();
    await source?.open();
    await source?.open();
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it('is checked by its module when its stored manifest lists checkInbound, again without resolving first', async () => {
    mockInstalls.push(install(['manifest', 'checkInbound']));
    const source = await platformInboundStore.sourceFor(subscription);
    expect(source?.verifier).toBe(CHECKED_BY_MODULE);
    expect(mockResolve).not.toHaveBeenCalled();
    expect((await source?.open())?.adapterType).toBe(ADAPTER_TYPE);
  });
});
