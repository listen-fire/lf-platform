// The catalog an author sees holds only the connections they may use; a
// run's catalog holds every connection its team has. The team has two Attio
// connections, Finance and Sales, and the caller may use only Sales. Each
// authoring route answers about Finance exactly as it answers about a
// connection that does not exist, and never names Finance on its own; a run
// of a program on Finance still resolves it.

import { runWithPrincipal, type Principal } from 'principal';

import type { RequestHandler } from 'express';
import type { TeamId } from '../../../../generated/kysely/core/Team';

const mockTeam = '11111111-1111-4111-8111-111111111111';
const FINANCE_ID = 'c0000000-0000-4000-8000-000000000001';
const SALES_ID = 'c0000000-0000-4000-8000-000000000002';

const mockCaller: Principal = {
  teamId: mockTeam,
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  access: 'write',
  scopes: ['*'],
  pinnedTeamId: null,
};

const mockAsked = { connections: 0 };

jest.mock('../../../access/decide', () => ({
  ...jest.requireActual('../../../access/decide'),
  // Membership caps a statement; here the caller's statements give them Sales alone.
  readableIds: async (_principal: unknown, asked: { thing: string }) => {
    if (asked.thing === 'connection') mockAsked.connections += 1;
    return new Set(asked.thing === 'connection' ? [SALES_ID] : []);
  },
  accessTo: async (_principal: unknown, asked: { target: { thing: string; id: string } }) =>
    asked.target.thing === 'connection' && asked.target.id === SALES_ID,
}));

jest.mock('../../../../lib/kysely', () => {
  const tables: Record<string, unknown[]> = {
    external_service_credentials: [
      { id: 'c0000000-0000-4000-8000-000000000001', name: 'Finance', type: 'ATTIO', created_at: new Date(1), app_id: null, declared_credential: null },
      { id: 'c0000000-0000-4000-8000-000000000002', name: 'Sales', type: 'ATTIO', created_at: new Date(2), app_id: null, declared_credential: null },
    ],
  };
  const stub = (): unknown => {
    let rows: unknown[] = [];
    const chain: object = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') return undefined;
          if (prop === 'selectFrom') {
            return (table: string) => {
              rows = tables[table] ?? [];
              return chain;
            };
          }
          if (prop === 'execute') return async () => rows;
          if (prop === 'executeTakeFirst') return async () => rows[0];
          return () => chain;
        },
      },
    );
    return chain;
  };
  return { ...jest.requireActual('../../../../lib/kysely'), getAutomationsQb: stub, getCoreQb: stub, getKnowledgeQb: stub, getQb: stub };
});

jest.mock('../store', () => ({
  ...jest.requireActual('../store'),
  listMovementRows: async () => [],
  getMovementRowByName: async () => null,
  getMovementRow: async () => null,
}));

// Nothing here talks to Attio: describing a usable connection says its
// introspection failed, which is all the test needs to tell it from a missing one.
jest.mock('../instance_cache', () => ({
  ...jest.requireActual('../instance_cache'),
  cachedAdapterInstance: async () => {
    throw new Error('no network in this test');
  },
  introspectAdapterInstanceCached: async () => {
    throw new Error('no network in this test');
  },
  adapterInstanceIsWarm: () => false,
}));

jest.mock('../../../../interfaces/rest/v1/team_scope', () => ({
  ...jest.requireActual('../../../../interfaces/rest/v1/team_scope'),
  teamSetForReads: async () => [mockTeam],
  resolveToolTeam: async (team?: string) => team ?? mockTeam,
  listAccessibleTeams: async () => [{ teamId: mockTeam, name: 'Team', access: 'write', isPersonal: false }],
}));

import { automationRouter } from '../../../../interfaces/rest/v1/automation';
import { runCatalogSnapshotForTeam } from '../catalog';

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] }; handle: { stack?: Layer[] } };

function handlerOf(method: string, path: string): RequestHandler {
  const walk = (stack: Layer[]): RequestHandler | undefined => {
    for (const layer of stack) {
      if (layer.route?.path === path && layer.route.methods[method]) return layer.route.stack[layer.route.stack.length - 1]?.handle;
      const nested = layer.handle.stack === undefined ? undefined : walk(layer.handle.stack);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  const found = walk((automationRouter as unknown as { stack: Layer[] }).stack);
  if (found === undefined) throw new Error(`${method} ${path} is not mounted`);
  return found;
}

async function call(method: string, path: string, request: { query?: Record<string, string>; body?: Record<string, unknown> }) {
  const outcome: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      outcome.status = code;
      return res;
    },
    type() {
      return res;
    },
    json(body: unknown) {
      outcome.body = body;
      return res;
    },
    send(body: unknown) {
      outcome.body = body;
      return res;
    },
  };
  const req = { params: {}, query: request.query ?? {}, body: request.body ?? {}, headers: {} };
  await runWithPrincipal(mockCaller, () => Promise.resolve(handlerOf(method, path)(req as never, res as never, () => undefined)));
  return outcome;
}

const text = (outcome: { body: unknown }) => JSON.stringify(outcome.body ?? null);
const asIf = (outcome: { status: number; body: unknown }, from: string, to: string) => JSON.parse(JSON.stringify(outcome).split(from).join(to));

const program = (connection: string) => `import { ${connection} } from credentials\n`;

beforeEach(() => {
  mockAsked.connections = 0;
});

describe('as a caller who may use Sales but not Finance', () => {
  it('listConnections lists Sales and never Finance', async () => {
    const listed = await call('get', '/connections', {});
    expect(listed.status).toBe(200);
    expect(text(listed)).toContain('Sales');
    expect(text(listed)).not.toContain('Finance');
    expect(text(listed)).not.toContain(FINANCE_ID);
    expect(mockAsked.connections).toBeGreaterThan(0);
  });

  it('describeConnection answers Finance as it answers a connection that does not exist', async () => {
    const finance = await call('post', '/connections/describe', { body: { system: 'attio', connection: 'Finance', detail: 'full' } });
    const nowhere = await call('post', '/connections/describe', { body: { system: 'attio', connection: 'Nowhere', detail: 'full' } });
    const sales = await call('post', '/connections/describe', { body: { system: 'attio', connection: 'Sales', detail: 'full' } });
    expect(finance.status).toBe(200);
    expect(finance).toEqual(asIf(nowhere, 'Nowhere', 'Finance'));
    expect(sales).not.toEqual(asIf(nowhere, 'Nowhere', 'Sales'));
  });

  it('describeConnection with no connection named never falls back to Finance', async () => {
    const described = await call('post', '/connections/describe', { body: { system: 'attio' } });
    expect(text(described)).not.toContain('Finance');
  });

  it('validateAutomation answers a program on Finance as one on a connection that does not exist', async () => {
    const finance = await call('post', '/automations/validate', { body: { source: program('Finance') } });
    const nowhere = await call('post', '/automations/validate', { body: { source: program('Nowhere') } });
    expect(finance.status).toBe(nowhere.status);
    expect(finance).toEqual(asIf(nowhere, 'Nowhere', 'Finance'));
    expect(text(nowhere)).not.toContain('Finance');
  });

  it('the completions handler offers Sales and never Finance', async () => {
    const completed = await call('post', '/automations/completions', {
      body: { source: 'crm = connect attio using <|>\n' },
    });
    expect(completed.status).toBe(200);
    expect(text(completed)).toContain('Sales');
    expect(text(completed)).not.toContain('Finance');
  });
});

describe('a run', () => {
  it('still resolves Finance', async () => {
    const { snapshot, credentialIds } = await runCatalogSnapshotForTeam(mockTeam as TeamId, {
      source: program('Finance'),
      imports: 'shipped',
      audience: { for: 'run' },
    });
    expect(Object.keys(snapshot.credentials)).toEqual(expect.arrayContaining(['Finance', 'Sales']));
    expect(credentialIds.Finance).toBe(FINANCE_ID);
    expect(mockAsked.connections).toBe(0);
  });

  it('as a person (a test run) does not', async () => {
    const { snapshot } = await runWithPrincipal(mockCaller, () =>
      runCatalogSnapshotForTeam(mockTeam as TeamId, { source: program('Finance'), imports: 'live', audience: { for: mockCaller } }),
    );
    expect(Object.keys(snapshot.credentials)).toEqual(['Sales']);
  });
});
