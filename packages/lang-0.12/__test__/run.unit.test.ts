// A 0.12 segment someone started, run by 0.12's own engine on 0.12's own host
// kit, with the platform's services as a fake. What the platform sees back is
// plain data: a result, or why the segment failed.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { InMemoryWriteLocks } from '@listen-fire/engine/public/embed';
import * as errors012 from '@listen-fire/engine/public/errors';

import { manualInvocationEvent, manualListens, readEvent, runSegment } from '..';
import { ledgered } from '../lane/run';
import { heldSchemaCount, readOnce } from '../lane/catalog';
import { moduleTable } from '../lane/modules';
import type { HostAdapters } from '@listen-fire/engine/public/host';
import type { RunPlatform, SegmentRequest } from '../lane/run_types';
import type { TeamFacts } from '../lane/types';

const TEAM = '00000000-0000-4000-8000-000000000012';

function team(): TeamFacts {
  return { credentials: [], files: [], connectOf: () => 'oauth', kgChangeWebhooks: false, mcpEnabled: false, whatsappNumber: null };
}

const refused = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not part of this test`);
};

function platform(overrides: Partial<RunPlatform> = {}): RunPlatform {
  return {
    modules: {
      hostFor: () => {
        throw new Error('no module is hosted in this test');
      },
      parts: {
        askAnswerUrl: (token) => `https://example.test/asks/${token}`,
        kgStore: () => {
          throw new Error('no kg in this test');
        },
        kgChangeWebhooks: false,
        slackChat: refused('slack chat'),
        readFile: refused('readFile'),
        whatsappNumber: null,
        isExposedFileUrl: () => false,
      remoteInstall: refused('remote installs'),
        readDocument: refused('readDocument'),
      },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      validateResults: true,
    },
    credentials: { belongsTo: () => true },
    llm: {
      client: { call: refused('llm') },
      extractCall: { call: refused('extract') },
      transforms: { invoke: refused('transforms') },
      arbitrateEntities: refused('arbitrate'),
    },
    files: { resolveFileText: refused('file text'), render: refused('render') },
    bindings: { record: refused('bindings'), findBoundCounterpart: refused('bindings'), delete: refused('bindings') },
    locks: new InMemoryWriteLocks(),
    actingUser: async () => null,
    control: { cancelled: async () => false, cancelledNow: async () => false, leaseLost: () => false },
    ...overrides,
  };
}

function request(source: string, extra: Partial<SegmentRequest> = {}): SegmentRequest & { parkRefusal: string } {
  const [movementName] = manualListens({ source, pin: '0.12.13' });
  return {
    source,
    pin: '0.12.13',
    ...(movementName !== undefined ? { movementName } : {}),
    event: manualInvocationEvent({ key: 'movement-1', invocation: { firedAt: '2026-11-04T10:00:00.000Z', text: 'hello' } }),
    teamId: TEAM,
    firedAt: '2026-11-04T10:00:00.000Z',
    runId: 'run-1',
    team: team(),
    parkRefusal: 'this platform does not resume a parked 0.12 run',
    ...extra,
  };
}

/** A manual listen as 0.12 spells it, reading the press's text. */
const ECHO_012 = 'function echo(run: <manual-[:Invocation]->>) {\n  t = run.Text\n  return t\n}\nlisten to manual fire echo\n';

describe("a 0.12 segment on 0.12's own run host", () => {
  it("finds the movement a 0.12 manual listen fires, by 0.12's parser", () => {
    expect(manualListens({ source: ECHO_012, pin: '0.12.13' })).toEqual(['echo']);
    expect(manualListens({ source: 'listen to manual-[:Invocations]-> fire echo\n', pin: '0.12.13' })).toEqual([]);
  });

  it('runs a manual press to its end and answers its result as plain data', async () => {
    const outcome = await runSegment(request(ECHO_012), platform());
    expect(outcome).toMatchObject({ kind: 'ran', result: { movementName: 'echo', writes: [] } });
    expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
  });

  it("stops a segment that parks with the registry's refusal, as 0.12's own error, failing loudly", async () => {
    const sleeps = 'function nap(run: <manual-[:Invocation]->>) {\n  await sleep(1h)\n}\nlisten to manual fire nap\n';
    const outcome = await runSegment(request(sleeps), platform());
    expect(outcome).toMatchObject({ kind: 'failed', code: 'MOVENG_UNSUPPORTED' });
    if (outcome.kind !== 'failed') return;
    expect(outcome.message).toContain('this platform does not resume a parked 0.12 run');
  });

  it("a lost lease stops the segment as 0.12's own `RunLeaseLost`, answered as its own outcome", async () => {
    const outcome = await runSegment(
      request(ECHO_012),
      platform({ control: { cancelled: async () => false, cancelledNow: async () => false, leaseLost: () => true } }),
    );
    expect(outcome).toEqual({ kind: 'lease-lost', message: expect.stringContaining('run lease lost') });
  });

  it('a cancel stops the segment at its boundary and says so on the result', async () => {
    const outcome = await runSegment(
      request(ECHO_012),
      platform({ control: { cancelled: async () => true, cancelledNow: async () => true, leaseLost: () => false } }),
    );
    expect(outcome).toMatchObject({ kind: 'ran', result: { cancelled: true } });
  });

  it("a construct 0.12 cannot read fails with 0.12's own description, never thrown across", async () => {
    const outcome = await runSegment(request('listen to manual-[:Invocations]-> fire echo\n', { movementName: 'echo' }), platform());
    expect(outcome.kind).toBe('failed');
  });

  it("0.12's classes are its own: the run host throws none of the current release's", () => {
    expect(errors012.RunLeaseLost.name).toBe('RunLeaseLost');
  });
});

describe("a 0.12 run of an ask, against the catalog its own literals type", () => {
  const form = (read: string) =>
    'import { `@lf/ask` as ask } from adapters\nqa = connect ask\n' +
    `function m(go: <manual-[:Invocation]->>) {\n  q = write qa-[:Form]-> { Prompt: "Deal?", Fields: ["Budget"] }\n  a = await first(q-[:Response]->)\n  return ${read}\n}\nlisten to manual fire m\n`;

  it("a field the Form declares gets past the run's check, to the module", async () => {
    const outcome = await runSegment(request(form('a.Budget')), platform());
    expect(outcome).toMatchObject({ kind: 'failed', message: expect.stringContaining('no module is hosted') });
  });

  it("a field it does not declare is the run's check's to refuse", async () => {
    const outcome = await runSegment(request(form('a.Budgett')), platform());
    expect(outcome).toMatchObject({ kind: 'failed', code: 'MOVENG_CHECK', message: expect.stringContaining("no field 'Budgett'") });
  });
});

describe('a program importing a library on another version', () => {
  const IMPORTS = 'import { shout } from "lib"\nfunction echo(run: <manual-[:Invocation]->>) {\n  return shout(run.Text)\n}\nlisten to manual fire echo\n';
  const LIBRARY = 'export function shout(t: <text>) {\n  return t\n}\n';

  it('fails with the import diagnostic naming both versions, not a later unknown file', async () => {
    const outcome = await runSegment(
      request(IMPORTS, { team: { ...team(), files: [{ name: 'lib', source: LIBRARY, languageVersion: '0.15.1' }] } }),
      platform(),
    );
    expect(outcome).toMatchObject({ kind: 'failed', code: 'MOVENG_CHECK' });
    if (outcome.kind !== 'failed') return;
    expect(outcome.message).toContain("the library 'lib' it imports is on language 0.15.1");
    expect(outcome.message).toContain('this automation is on language 0.12.13');
  });
});

describe('an event, read by 0.12', () => {
  it("answers what the platform records, by 0.12's schema", () => {
    const event = manualInvocationEvent({ key: 'movement-1', invocation: { firedAt: '2026-11-04T10:00:00.000Z', text: 'hello' } });
    expect(readEvent(event)).toEqual({
      ok: true,
      record: { pipelineInputId: 'trigger:movement-1', adapterType: 'manual', triggerType: 'webhook', payload: { firedAt: '2026-11-04T10:00:00.000Z', text: 'hello' } },
    });
  });

  it('names what it cannot read', () => {
    const reading = readEvent({ pipelineInputId: 'p', adapterType: 'manual', triggerType: 'arrival' });
    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(reading.reason).toContain('triggerType');
  });
});

describe("the write ledger, from 0.12's modules", () => {
  /** A module that answers every write as written, and `gone` as not found. */
  const fakeModule = (): HostAdapters => ({
    resolve: async (resolution) => ({
      instance: resolution.dryRun === true ? 'rehearsed' : 'live',
      adapterType: 'attio',
      supportedTriggers: [],
      capabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
      methods: ['createRecord', 'updateRecord', 'readRecord'],
    }),
    call: async (call) => {
      const named = 'externalId' in call.args && typeof call.args.externalId === 'string' ? call.args.externalId : undefined;
      if (named === 'gone') return { result: { notFound: true } } as never;
      return { result: { adapterType: 'attio', externalId: named ?? 'company-new' } } as never;
    },
  });

  const writes = async (keepWrite: NonNullable<RunPlatform['keepWrite']>) => {
    const host = ledgered(fakeModule(), keepWrite);
    const live = await host.resolve({ segmentId: 's1', adapterType: 'attio', role: 'target' });
    const rehearsed = await host.resolve({ segmentId: 's1', adapterType: 'attio', role: 'target', dryRun: true });
    return {
      call: (instance: string, method: string, args: Record<string, unknown>) => host.call({ segmentId: 's1', instance, method, args } as never),
      live: live.instance,
      rehearsed: rehearsed.instance,
    };
  };

  it("keeps each write its module answered, with its adapter, record type, id and sent time; nothing a rehearsal, a read or a not-found sends", async () => {
    const kept: Parameters<NonNullable<RunPlatform['keepWrite']>>[0][] = [];
    const { call, live, rehearsed } = await writes(async (write) => {
      kept.push(write);
    });
    const before = Date.now();
    await call(live, 'createRecord', { recordType: 'Companies', fields: {} });
    await call(live, 'updateRecord', { recordType: 'Companies', externalId: 'company-1', fields: {} });
    await call(live, 'updateRecord', { recordType: 'Companies', externalId: 'gone', fields: {} });
    await call(live, 'readRecord', { recordType: 'Companies', externalId: 'company-2' });
    await call(rehearsed, 'updateRecord', { recordType: 'Companies', externalId: 'company-3', fields: {} });
    expect(kept.map(({ adapterType, recordType, externalId }) => ({ adapterType, recordType, externalId }))).toEqual([
      { adapterType: 'attio', recordType: 'Companies', externalId: 'company-new' },
      { adapterType: 'attio', recordType: 'Companies', externalId: 'company-1' },
    ]);
    for (const write of kept) expect(new Date(write.at).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('a write the ledger cannot keep fails the call: a write it does not know would let its echo start a chain', async () => {
    const { call, live } = await writes(async () => {
      throw new Error('the ledger is down');
    });
    expect(await call(live, 'createRecord', { recordType: 'Companies', fields: {} })).toEqual({
      error: {
        kind: 'adapter_error',
        message: 'keeping the write of Companies company-new in the write ledger failed after the write was sent: the ledger is down',
      },
    });
  });
});

describe("a connection's schema, held for the minute it is shared", () => {
  afterEach(() => jest.useRealTimers());

  it('is let go once its minute is over, so the process does not keep every connection it ever read', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-04T10:00:00.000Z') });
    const reading = async () => ({ schema: { positions: {}, collections: {}, writableRoots: {} }, notes: [] });
    await readOnce('team-a|attio|', reading);
    await readOnce('team-b|attio|', reading);
    const held = heldSchemaCount();
    jest.setSystemTime(Date.parse('2026-11-04T10:02:00.000Z'));
    await readOnce('team-c|attio|', reading);
    expect(heldSchemaCount()).toBeLessThan(held);
    expect(heldSchemaCount()).toBe(1);
  });
});

/** A remote adapter server's one writable record type, `Company`. */
function answerOf(request: { method: string; params?: { recordType?: string; fields?: unknown } }): unknown {
  switch (request.method) {
    case 'listEntryPoints':
      return [{ typeId: 'Company', displayName: 'Company', scope: 'self-configured', writable: true, readable: false }];
    case 'describe':
      return {
        typeId: 'Company',
        displayName: 'Company',
        fields: [{ fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: true }],
        references: [],
      };
    case 'createRecord':
      return { adapterType: 'acme_crm', externalId: 'company-1', recordType: request.params?.recordType, data: request.params?.fields };
    default:
      return [];
  }
}

describe("a team's install of a remote adapter, in a 0.12 run", () => {
  let server: http.Server;
  let baseUrl: string;
  const requests: { headers: http.IncomingHttpHeaders; body: { method: string; credential?: unknown } }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const parsed: { method: string; params?: { typeId?: string; recordType?: string; fields?: unknown } } = JSON.parse(body);
        requests.push({ headers: req.headers, body: parsed });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: answerOf(parsed) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    requests.length = 0;
  });

  const stored = (over: Record<string, unknown> = {}) => ({
    protocolVersion: 2,
    adapterType: 'acme_crm',
    baseUrl,
    authStrategy: { kind: 'bearer' },
    supportedTriggers: [],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'deleteRecord'],
    ...over,
  });

  const tableWith = (manifest: unknown) => {
    const asked: unknown[] = [];
    const modules = platform().modules;
    const table = moduleTable({
      ...modules,
      parts: {
        ...modules.parts,
        remoteInstall: async (input) => {
          asked.push(input);
          return { manifest, secret: 'install-secret', credentialsId: 'cred-install', documents: {} as never };
        },
      },
    });
    return { table, asked };
  };

  it("runs through 0.12's own remote adapter: built from the stored manifest, calling the server with the install's secret and the team", async () => {
    const { table, asked } = tableWith(stored());
    const adapter = await table.resolve('acme_crm', { teamId: TEAM, credentialsId: 'cred-install' });
    expect(asked).toEqual([{ adapterType: 'acme_crm', teamId: TEAM, credentialsId: 'cred-install' }]);
    expect(await adapter.listEntryPoints()).toEqual([expect.objectContaining({ typeId: 'Company' })]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.method).toBe('listEntryPoints');
    expect(requests[0]?.headers.authorization).toBe('Bearer install-secret');
    expect(requests[0]?.headers['x-listen-fire-team']).toBe(TEAM);
  });

  it("a 0.12 run writes through the install, on 0.12's own remote adapter", async () => {
    const source = 'import { acme_crm } from adapters\ncrm = connect acme_crm\nfunction go(run: <manual-[:Invocation]->>) {\n  write crm-[:Company]-> { Name: run.Text }\n}\nlisten to manual fire go\n';
    const asked: unknown[] = [];
    const modules = platform().modules;
    const outcome = await runSegment(
      request(source, { team: { ...team(), remoteAdapters: [{ adapterType: 'acme_crm', manifest: stored() }] } }),
      platform({
        modules: {
          ...modules,
          parts: {
            ...modules.parts,
            remoteInstall: async (input) => {
              asked.push(input);
              return { manifest: stored(), secret: 'install-secret', credentialsId: 'cred-install', documents: {} as never };
            },
          },
        },
      }),
    );
    if (outcome.kind !== 'ran') throw new Error(`the run did not finish: ${JSON.stringify(outcome)}`);
    expect(outcome.result.movementName).toBe('go');
    expect(outcome.result.writes.map((write) => [write.adapterType, write.externalId])).toEqual([['acme_crm', 'company-1']]);
    const written = requests.find((sent) => sent.body.method === 'createRecord');
    expect(written?.headers.authorization).toBe('Bearer install-secret');
    expect(written?.headers['x-listen-fire-team']).toBe(TEAM);
    expect(asked).toContainEqual({ adapterType: 'acme_crm', teamId: TEAM });
  });

  it('refuses a stored manifest 0.12 cannot read, by the install and by language', async () => {
    const { table } = tableWith(stored({ baseUrl: 'not a url' }));
    await expect(table.resolve('acme_crm', { teamId: TEAM })).rejects.toThrow(/the stored manifest of 'acme_crm' is not one language 0\.12 reads/);
    expect(requests).toEqual([]);
  });
});
