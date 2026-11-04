// A remote install's inbound source: whether its module checks its own inbound
// is read off the install's stored manifest, so a delivery the host verifies
// is turned away before the adapter is resolved, and the adapter is resolved
// once, only when a delivery is read.

import { randomUUID } from 'node:crypto';

import { CHECKED_BY_MODULE } from 'movement-engine/public/inbound';

const mockInstalls: unknown[] = [];
const mockResolve = jest.fn();
const mockKeep = jest.fn();
jest.mock('../../inbound/carried_delivery', () => ({
  ...jest.requireActual('../../inbound/carried_delivery'),
  keepForEveryVersion: (...args: unknown[]) => mockKeep(...args),
}));
jest.mock('../../translation_graph/adapters/remote/store', () => ({
  ...jest.requireActual('../../translation_graph/adapters/remote/store'),
  listRemoteAdapters: async () => mockInstalls,
}));
jest.mock('../../translation_graph/adapters/resolve', () => ({
  ...jest.requireActual('../../translation_graph/adapters/resolve'),
  resolveAdapter: (...args: unknown[]) => mockResolve(...args),
}));

import { platformInboundStore, platformInboundStoreFor } from '../handler';
import { webhookProviderKey } from '../urls';

const ADAPTER_TYPE = 'acme_mail';

function install(methods: string[], inbound?: unknown) {
  const manifest = {
    adapterType: ADAPTER_TYPE,
    baseUrl: 'https://acme-mail.test',
    authStrategy: { kind: 'bearer' },
    supportedTriggers: ['webhook'],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods,
    protocolVersion: 2,
    ...(inbound !== undefined ? { inbound } : {}),
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

  it("keeps a delivery without the fields and headers its stored manifest declares for its inbound, as a built in's do", async () => {
    mockKeep.mockReset().mockResolvedValue({ kind: 'read', deliveryId: randomUUID(), keptAt: new Date() });
    mockInstalls.push(
      install(['manifest', 'preprocessInbound'], {
        providerKey: ADAPTER_TYPE,
        scheme: 'remote',
        signatureHeaders: ['x-listen-fire-signature'],
        captureHeaders: ['x-acme-event'],
        redactFields: ['verification_token'],
      }),
    );
    const rawBody = Buffer.from(JSON.stringify({ verification_token: 'tok-123', text: 'hello' }), 'utf8');
    const headers = { 'content-type': 'application/json', 'x-acme-event': 'message', 'x-acme-other': 'dropped' };
    const source = await platformInboundStoreFor({ rawBody, headers }).sourceFor(subscription);

    await source?.open();

    const { request } = mockKeep.mock.calls[0]![0] as { request: { headers: Record<string, string>; body: string } };
    expect(request.headers).toEqual({ 'content-type': 'application/json', 'x-acme-event': 'message' });
    expect(Buffer.from(request.body, 'base64').toString('utf8')).toBe(JSON.stringify({ text: 'hello' }));
  });
});
