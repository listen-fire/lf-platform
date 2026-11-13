// Project A's production settings, honoured inside the process:
// MOVEMENT_MAX_SEGMENT_SECONDS by the engine (its segment wall clock),
// AFFINITY_MAX_CALLS_PER_RUN by the Affinity module (its run-scoped call
// count). A carried version honours them through its own engine and modules,
// which its own package proves.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { credentialIdsFor, makeTestHost } from 'movement-engine/public/testing';
import { positionData } from 'movement-engine/public/catalog';
import { isAdapterCallCeilingExceeded, withSegment } from 'movement-engine/public/adapter-support';
import type { Adapter } from 'movement-engine/public/adapter';
import type { EngineHost } from 'movement-engine/public/host';
import { runMovement } from 'movement-engine/public/movement-engine';
import { mockCatalogSnapshot, LANGUAGE_VERSION } from 'movement-lang';
import { AffinityAPIClient } from '@listen-fire/affinity/api_client';

const TEAM = '00000000-0000-4000-8000-000000000012';

/** A file render that takes `ms`. */
const slowRender =
  (ms: number): EngineHost['files']['render'] =>
  async ({ content }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { __brand: 'FileRef', name: 'out.txt', contentType: 'text/plain', size: content.length, source: { store: 'document', objectUri: 'mem://out' } } as never;
  };

function withEnv(name: string, value: string) {
  const before = process.env[name];
  beforeEach(() => {
    process.env[name] = value;
  });
  afterEach(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

/** The 0.15 segment's source, read from the event it was handed. */
function sourceAdapter(): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async (input) => {
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, input.fieldId) : undefined;
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
    updateRecord: async () => {
      throw new Error('the source is never written in this test');
    },
    deleteRecord: async () => ({}),
  };
}

describe('MOVEMENT_MAX_SEGMENT_SECONDS', () => {
  withEnv('MOVEMENT_MAX_SEGMENT_SECONDS', '1');

  it('stops a segment that outlives it', async () => {
    const catalog = mockCatalogSnapshot({
      adapters: {
        email: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          schema: { positions: { message: { properties: { subject: 'text' }, edges: {} } }, collections: {}, writableRoots: {} },
        },
      },
      credentials: { inbox_cred: { adapters: ['email'] } },
    });
    const source = [
      'import { email } from adapters',
      'import { inbox_cred } from credentials',
      'inbox = connect email using inbox_cred',
      'function slow(msg: <inbox-[:message]->>) {',
      '  f = File.from(msg.subject, "text")',
      '  return f',
      '}',
    ].join('\n');
    const failure = await runMovement({
      source,
      languageVersion: LANGUAGE_VERSION,
      movementName: 'slow',
      event: { pipelineInputId: 'limits', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'x' } },
      // A tenant id is a branded string; this test's is one by construction.
      teamId: TEAM as Parameters<typeof runMovement>[0]['teamId'],
      firedAt: new Date().toISOString(),
      catalog,
      credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
      host: makeTestHost({
        adapters: { resolve: () => sourceAdapter() },
        files: { render: slowRender(1_500) },
      }),
    }).catch((error: unknown) => error);
    expect(String(failure)).toContain('MOVENG_LIMIT_WALL_CLOCK');
  }, 30_000);
});

describe("AFFINITY_MAX_CALLS_PER_RUN, read by the Affinity module", () => {
  withEnv('AFFINITY_MAX_CALLS_PER_RUN', '2');
  let server: http.Server;
  let baseUrl: string;
  let requests = 0;
  let answersOrganizations = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      // A read of an organization is answered as Affinity does; anything else on `[]`.
      res.end(answersOrganizations && req.url?.startsWith('/organizations/') === true ? JSON.stringify({ id: 1 }) : '[]');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('stops a run at the ceiling, in a segment as the engine\'s host opens one', async () => {
    requests = 0;
    answersOrganizations = true;
    const client = new AffinityAPIClient({ apiKey: 'k', baseUrl });
    const failure = await withSegment({ teamId: TEAM }, async () => {
      await client.getOrganisationById(1);
      await client.getOrganisationById(2);
      return client.getOrganisationById(3).catch((error: unknown) => error);
    }).finally(() => {
      answersOrganizations = false;
    });

    expect(isAdapterCallCeilingExceeded(failure)).toBe(true);
    expect(String(failure)).toContain('AFFINITY_MAX_CALLS_PER_RUN');
    expect(requests).toBe(2);
  }, 30_000);
});
