// The pure catalog builder every shell shares: a remote install reaches the
// snapshot as a built-in does. Its listens are its listenable edges, which an
// introspected module declares at describe time, so the snapshot carries no
// listen vocabulary of its own.

import { buildCatalogSnapshot } from 'movement-engine/public/catalog';

import { RemoteAdapterManifestFile, remoteAdapterManifest } from '../../adapters/remote/manifest';

const file = RemoteAdapterManifestFile.parse({
  protocolVersion: 2,
  adapterType: 'acme_crm',
  baseUrl: 'https://crm.example/adapter',
  authStrategy: { kind: 'bearer' },
  supportedTriggers: ['webhook'],
  // A file stored under 0.12: its listen keys parse and are dropped.
  subscribableEvents: ['company.created', 'company.updated'],
  listenConfig: [{ key: 'schedule', format: 'cron' }],
  runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
  methods: ['describe'],
});

describe('buildCatalogSnapshot over a remote manifest', () => {
  it('projects the install as an introspected module with no listen vocabulary of its own', () => {
    const snapshot = buildCatalogSnapshot({
      adapters: [{ manifest: remoteAdapterManifest(file) }],
      credentials: {},
      plugins: {},
    });
    const spec = snapshot.adapters.acme_crm;
    expect(spec).toMatchObject({ constructionArgs: [], schemaShape: 'introspected', schemas: {} });
    expect(spec).not.toHaveProperty('triggerConfig');
    expect(spec).not.toHaveProperty('triggerConfigOptions');
  });
});
