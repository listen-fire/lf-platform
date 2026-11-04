// Project A's production settings, honoured by each version inside one
// process: MOVEMENT_MAX_SEGMENT_SECONDS by each version's own engine (its
// segment wall clock), AFFINITY_MAX_CALLS_PER_RUN by each version's own
// Affinity module (its run-scoped call count). One jest process runs a 0.12
// segment on 0.12's run host and a 0.15 segment on this release's engine.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { credentialIdsFor, makeTestHost } from 'movement-engine/public/testing';
import { positionData } from 'movement-engine/public/catalog';
import type { Adapter } from 'movement-engine/public/adapter';
import { InMemoryWriteLocks } from 'movement-engine/public/write-locks';
import { runMovement } from 'movement-engine/public/movement-engine';
import { mockCatalogSnapshot, LANGUAGE_VERSION } from 'movement-lang';

import { resumeRefusal, runningOf, type RunPlatform, type RunningLane, type TeamFacts } from '..';

const TEAM = '00000000-0000-4000-8000-000000000012';

const refused = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not part of this test`);
};

function team(credentials: TeamFacts['credentials'] = []): TeamFacts {
  return { credentials, files: [], connectOf: () => 'key-entry', kgChangeWebhooks: false, mcpEnabled: false, whatsappNumber: null };
}

/** The platform as a fake: a file render that takes `renderMs`, and modules
 *  hosted with `fields` as their credential. */
function platform(input: { renderMs?: number; fields?: Record<string, string> } = {}): RunPlatform {
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  return {
    modules: {
      hostFor: () => ({
        credential: { name: 'api_key', fields: async () => input.fields ?? {}, update: async () => {} },
        kv: { get: refused('kv'), set: refused('kv'), delete: refused('kv'), list: refused('kv'), compareAndSet: refused('kv') },
        files: { put: refused('files'), read: refused('files'), expose: refused('files') },
      }),
      parts: {
        askAnswerUrl: () => '',
        kgStore: () => {
          throw new Error('no kg');
        },
        kgChangeWebhooks: false,
        slackChat: refused('slack'),
        readFile: refused('readFile'),
        whatsappNumber: null,
        isExposedFileUrl: () => false,
        readDocument: refused('readDocument'),
      },
      log,
      validateResults: false,
    },
    credentials: { belongsTo: () => true },
    llm: { client: { call: refused('llm') }, extractCall: { call: refused('extract') }, transforms: { invoke: refused('plugins') }, arbitrateEntities: refused('judge') },
    files: {
      resolveFileText: refused('file text'),
      render: async ({ content }) => {
        await new Promise((resolve) => setTimeout(resolve, input.renderMs ?? 0));
        return { __brand: 'FileRef', name: 'out.txt', contentType: 'text/plain', size: content.length, source: { store: 'document', objectUri: 'mem://out' } } as never;
      },
    },
    bindings: { record: refused('bindings'), findBoundCounterpart: refused('bindings'), delete: refused('bindings') },
    locks: new InMemoryWriteLocks(),
    actingUser: async () => null,
    control: { cancelled: async () => false, cancelledNow: async () => false, leaseLost: () => false },
  };
}

async function lane012(): Promise<RunningLane> {
  const running = runningOf('0.12.13');
  if (running.kind !== 'carried') throw new Error('0.12 does not run on this build');
  return running.lane();
}

async function run012(source: string, movementName: string, p: RunPlatform, credentials: TeamFacts['credentials'] = []) {
  const lane = await lane012();
  return lane.runSegment(
    {
      source,
      pin: '0.12.13',
      movementName,
      event: lane.manualInvocationEvent({ key: 'limits', invocation: { firedAt: new Date().toISOString(), text: 'x' } }),
      teamId: TEAM,
      firedAt: new Date().toISOString(),
      runId: 'run-012',
      team: team(credentials),
      parkRefusal: resumeRefusal('0.12.13') ?? '',
    },
    p,
  );
}

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

describe('MOVEMENT_MAX_SEGMENT_SECONDS, read by each version in one process', () => {
  withEnv('MOVEMENT_MAX_SEGMENT_SECONDS', '1');

  it('stops a 0.12 segment that outlives it, with 0.12\'s own wall-clock failure', async () => {
    const source = 'function slow(run: <manual-[:Invocation]->>) {\n  f = File.from("x", "text")\n  return f\n}\nlisten to manual fire slow\n';
    const outcome = await run012(source, 'slow', platform({ renderMs: 1_500 }));
    expect(outcome).toMatchObject({ kind: 'failed', code: 'MOVENG_LIMIT_WALL_CLOCK' });
  }, 30_000);

  it('stops a 0.15 segment that outlives it, in the same process', async () => {
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
        files: { render: platform({ renderMs: 1_500 }).files.render },
      }),
    }).catch((error: unknown) => error);
    expect(String(failure)).toContain('MOVENG_LIMIT_WALL_CLOCK');
  }, 30_000);
});

const SYNC =
  'import { affinity } from adapters\nimport { `Acme Affinity` } from credentials\n\ncrm = connect affinity using `Acme Affinity`\n\n' +
  'function sync(run: <manual-[:Invocation]->>) {\n  write crm-[:Organization]-> {\n    Name: run.Text\n  }\n}\n\nlisten to manual fire sync\n';

describe('AFFINITY_MAX_CALLS_PER_RUN, read by each version\'s Affinity module in one process', () => {
  withEnv('AFFINITY_MAX_CALLS_PER_RUN', '2');
  let server: http.Server;
  let baseUrl: string;
  let requests = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('a 0.12 run against Affinity stops at the ceiling: 0.12\'s Affinity module counts its calls in the run\'s segment', async () => {
    requests = 0;
    const source = SYNC;
    const outcome = await run012(source, 'sync', platform({ fields: { apiKey: 'k', baseUrl } }), [
      { id: 'cred-affinity', name: 'Acme Affinity', type: 'AFFINITY' },
    ]);
    expect(outcome.kind).not.toBe('ran');
    expect(JSON.stringify(outcome)).toContain('AFFINITY_MAX_CALLS_PER_RUN');
  }, 30_000);
});
