// setAccess over its route: replace one list of one automation or one
// connection, as the person the agent works for chose it. The real decision
// (`services/access/decide.ts`) runs over statements held in memory, with the
// connections and automations of two teams beside them.

import { Router } from 'express';
import { runWithPrincipal, type Access, type Principal } from 'principal';

import type { RequestHandler } from 'express';
import type { Grantee, Target, Verb } from '../../../../services/access/statement';

const TEAM_A = '11111111-1111-4111-8111-111111111111';
const TEAM_B = '22222222-2222-4222-8222-222222222222';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAROL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const DEALS = 'd0000000-0000-4000-8000-000000000001';
const FINANCE_A = 'c0000000-0000-4000-8000-00000000000a';
const FINANCE_B = 'c0000000-0000-4000-8000-00000000000b';
const SALES_B = 'c0000000-0000-4000-8000-00000000005b';

type Row = { teamId: string; target: Target; verb: Verb; grantee: Grantee };

const mockState: {
  things: Map<string, string>;
  members: Map<string, Access>;
  rows: Row[];
  teams: string[];
  connections: { id: string; team_id: string; name: string }[];
} = { things: new Map(), members: new Map(), rows: [], teams: [], connections: [] };

jest.mock('../../../../services/access/statement', () => {
  const actual = jest.requireActual('../../../../services/access/statement');
  const same = (a: Target, b: Target) => a.thing === b.thing && a.id === b.id;
  return {
    ...actual,
    StatementStore: {
      languagePinOf: async () => undefined,
      teamOf: async (target: Target) => mockState.things.get(`${target.thing}:${target.id}`),
      grantsOf: async (target: Target, options: { teamId: string; verb: Verb }) =>
        mockState.rows
          .filter((r) => r.teamId === options.teamId && same(r.target, target) && r.verb === options.verb)
          .map((r) => r.grantee),
      hasAnyStatement: async (target: Target) => mockState.rows.some((r) => same(r.target, target)),
      membershipsOf: async (userId: string, teamIds: string[]) =>
        new Map(
          teamIds.flatMap((teamId) => {
            const access = mockState.members.get(`${teamId}:${userId}`);
            return access === undefined ? [] : [[teamId, access] as const];
          }),
        ),
      membershipsAmong: async (teamId: string, userIds: string[]) =>
        new Map(
          userIds.flatMap((userId) => {
            const access = mockState.members.get(`${teamId}:${userId}`);
            return access === undefined ? [] : [[userId, access] as const];
          }),
        ),
      replaceGrants: async (target: Target, options: { teamId: string; verb: Verb; grantees: Grantee[] }) => {
        mockState.rows = [
          ...mockState.rows.filter((r) => !(same(r.target, target) && r.verb === options.verb)),
          ...options.grantees.map((grantee) => ({ teamId: options.teamId, target, verb: options.verb, grantee })),
        ];
      },
    },
  };
});

jest.mock('../../../../services/lf_engine/team_engine', () => ({
  ...jest.requireActual('../../../../services/lf_engine/team_engine'),
  isLfEngineTeam: async () => false,
}));

jest.mock('../team_scope', () => ({
  ...jest.requireActual('../team_scope'),
  teamSetForReads: async () => mockState.teams,
  resolveToolTeam: async (team?: string) => team ?? mockState.teams[0],
}));

jest.mock('../../../../services/translation_graph/movement/store', () => {
  const row = { id: DEALS, teamId: TEAM_A, name: 'Deals', source: '', languageVersion: '0.15.0' };
  return {
    ...jest.requireActual('../../../../services/translation_graph/movement/store'),
    getMovementRow: async (input: { teamId: string; id: string }) => (input.teamId === TEAM_A && input.id === DEALS ? row : null),
    getMovementRowByName: async (input: { teamId: string; name: string }) => (input.teamId === TEAM_A && input.name === 'Deals' ? row : null),
  };
});

/** The connections table, answering the equality conditions a query puts on team, name and id read as text. */
jest.mock('../../../../lib/kysely', () => {
  type Condition = { column: string; value: unknown };
  const builder = () => {
    const conditions: Condition[] = [];
    let columns: string[] = [];
    const matching = () =>
      mockState.connections
        .filter((row) => conditions.every(({ column, value }) => (row as Record<string, unknown>)[column] === value))
        .map((row) => Object.fromEntries(columns.map((column) => [column, (row as Record<string, unknown>)[column]])));
    const query: object = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') return undefined;
          if (prop === 'where') {
            return (column: unknown, _op?: string, value?: unknown) => {
              if (typeof column === 'function') {
                const eb = Object.assign((left: string, _operator: string, right: unknown) => ({ column: left, value: right }), {
                  cast: (name: string) => name,
                });
                conditions.push(column(eb));
              } else {
                conditions.push({ column: String(column), value });
              }
              return query;
            };
          }
          if (prop === 'select') {
            return (selected: string[]) => {
              columns = selected;
              return query;
            };
          }
          if (prop === 'execute') return async () => matching();
          if (prop === 'executeTakeFirst') return async () => matching()[0];
          return () => query;
        },
      },
    );
    return query;
  };
  const qb = { selectFrom: builder };
  return { ...jest.requireActual('../../../../lib/kysely'), getAutomationsQb: () => qb, getCoreQb: () => qb, getQb: () => qb };
});

import { mountAutomationToolRoutes } from '../knowledge_agent_tools';

const setAccess: RequestHandler = (() => {
  const router = Router();
  mountAutomationToolRoutes(router);
  const layer = router.stack.find((l) => l.route?.path === '/access' && l.route.stack.some((s) => s.method === 'post'));
  const handler = layer?.route?.stack[layer.route.stack.length - 1]?.handle;
  if (handler === undefined) throw new Error('POST /access is not mounted');
  return handler;
})();

type Answer = { status: number; body: Record<string, unknown> };

async function call(asked: { as?: Principal; body: Record<string, unknown> }): Promise<Answer> {
  const answer: Answer = { status: 200, body: {} };
  const res = {
    status(code: number) {
      answer.status = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      answer.body = body;
      return res;
    },
  };
  const principal = asked.as ?? { teamId: TEAM_A, userId: ALICE, access: 'write', scopes: ['*'], pinnedTeamId: null };
  await runWithPrincipal(principal, () => Promise.resolve(setAccess({ body: asked.body } as never, res as never, () => undefined)));
  return answer;
}

const team: Grantee = { kind: 'team' };
const user = (userId: string): Grantee => ({ kind: 'user', userId });

function stateConnection(id: string, teamId: string, use: Grantee[]) {
  const target: Target = { thing: 'connection', id };
  mockState.things.set(`connection:${id}`, teamId);
  for (const grantee of use) mockState.rows.push({ teamId, target, verb: 'use', grantee });
}

const listOf = (id: string, verb: Verb) => mockState.rows.filter((r) => r.target.id === id && r.verb === verb).map((r) => r.grantee);

beforeEach(() => {
  mockState.things = new Map();
  mockState.rows = [];
  mockState.teams = [TEAM_A];
  mockState.members = new Map([
    [`${TEAM_A}:${ALICE}`, 'write'],
    [`${TEAM_A}:${BOB}`, 'write'],
    [`${TEAM_A}:${CAROL}`, 'read'],
    [`${TEAM_B}:${ALICE}`, 'write'],
  ]);
  mockState.connections = [{ id: FINANCE_A, team_id: TEAM_A, name: 'Finance' }];
  mockState.things.set(`automation:${DEALS}`, TEAM_A);
  for (const verb of ['read', 'write', 'fire'] as const) {
    mockState.rows.push({ teamId: TEAM_A, target: { thing: 'automation', id: DEALS }, verb, grantee: team });
  }
  stateConnection(FINANCE_A, TEAM_A, [team]);
});

describe('what setAccess answers', () => {
  it('gives the list as stored, in the shape it is stored in, not as it was sent', async () => {
    const answer = await call({
      body: { automation: 'Deals', verb: 'fire', grantees: [{ kind: 'domain', domain: ' Example.COM ' }, { kind: 'email', address: 'Pat@Example.com' }] },
    });
    expect(answer).toEqual({
      status: 200,
      body: {
        automation: { id: DEALS, name: 'Deals' },
        verb: 'fire',
        grantees: [
          { kind: 'domain', domain: 'example.com' },
          { kind: 'email', address: 'pat@example.com' },
        ],
      },
    });
    expect(listOf(DEALS, 'fire')).toEqual(answer.body.grantees);
  });

  it('gives a connection the same way', async () => {
    const answer = await call({ body: { connection: 'Finance', verb: 'use', grantees: [user(BOB)] } });
    expect(answer).toEqual({ status: 200, body: { connection: { id: FINANCE_A, name: 'Finance' }, verb: 'use', grantees: [user(BOB)] } });
  });

  it.each([
    ['an automation asked for use', { automation: 'Deals', verb: 'use', grantees: [team] }],
    ['a connection asked for read', { connection: 'Finance', verb: 'read', grantees: [team] }],
    ['a connection asked for fire', { connection: 'Finance', verb: 'fire', grantees: [team] }],
  ])('refuses %s with a 400 naming the verbs each takes, changing nothing', async (_, body) => {
    const before = JSON.stringify(mockState.rows);
    const answer = await call({ body });
    expect(answer).toEqual({ status: 400, body: { error: "An automation's lists are read, write and fire; a connection's is use." } });
    expect(JSON.stringify(mockState.rows)).toBe(before);
  });

  it.each([
    ['both an automation and a connection', { automation: 'Deals', connection: 'Finance', verb: 'read', grantees: [team] }],
    ['neither', { verb: 'read', grantees: [team] }],
  ])('refuses a request naming %s, as invalid', async (_, body) => {
    const answer = await call({ body });
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer.body)).toContain('Name exactly one of automation or connection.');
  });

  it('refuses a list of the wrong shape, naming the bad value, and changes nothing', async () => {
    const before = JSON.stringify(mockState.rows);
    const answer = await call({ body: { automation: 'Deals', verb: 'fire', grantees: [{ kind: 'domain', domain: 'not a domain' }] } });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ refusal: 'malformed', error: expect.stringContaining('"not a domain"') });
    expect(JSON.stringify(mockState.rows)).toBe(before);
  });
});

describe('a connection is found among the teams the caller covers, as an automation is', () => {
  it('in a second team, by name or by id', async () => {
    mockState.teams = [TEAM_A, TEAM_B];
    mockState.connections.push({ id: SALES_B, team_id: TEAM_B, name: 'Sales' });
    stateConnection(SALES_B, TEAM_B, [team]);

    const byName = await call({ body: { connection: 'Sales', verb: 'use', grantees: [user(ALICE)] } });
    expect(byName.body).toMatchObject({ connection: { id: SALES_B, name: 'Sales' } });
    const byId = await call({ body: { connection: SALES_B, verb: 'use', grantees: [team] } });
    expect(byId.body).toMatchObject({ connection: { id: SALES_B, name: 'Sales' } });
  });

  it('passes over a same named connection the caller may not use for the one in a later team they may', async () => {
    mockState.teams = [TEAM_A, TEAM_B];
    mockState.connections.push({ id: FINANCE_B, team_id: TEAM_B, name: 'Finance' });
    mockState.rows = mockState.rows.filter((r) => r.target.id !== FINANCE_A);
    stateConnection(FINANCE_A, TEAM_A, [user(BOB)]);
    stateConnection(FINANCE_B, TEAM_B, [team]);

    const answer = await call({ body: { connection: 'Finance', verb: 'use', grantees: [team] } });
    expect(answer.body).toMatchObject({ connection: { id: FINANCE_B, name: 'Finance' } });
  });

  it('answers one the caller may not use exactly as one that is not there', async () => {
    mockState.rows = mockState.rows.filter((r) => r.target.id !== FINANCE_A);
    stateConnection(FINANCE_A, TEAM_A, [user(BOB)]);

    const unusable = await call({ body: { connection: 'Finance', verb: 'use', grantees: [team] } });
    const missing = await call({ body: { connection: 'Nowhere', verb: 'use', grantees: [team] } });
    expect(unusable.status).toBe(404);
    expect({ ...unusable, body: { error: String(unusable.body.error).replace('Finance', 'Nowhere') } }).toEqual(missing);
  });
});

describe('who may change a list', () => {
  const carol: Principal = { teamId: TEAM_A, userId: CAROL, access: 'read', scopes: ['*'], pinnedTeamId: null };

  it('answers a read only member 403 for a connection they may use, as for an automation they may read', async () => {
    const connection = await call({ as: carol, body: { connection: 'Finance', verb: 'use', grantees: [team] } });
    const automation = await call({ as: carol, body: { automation: 'Deals', verb: 'read', grantees: [team] } });
    expect(connection.status).toBe(403);
    expect(automation.status).toBe(403);
    expect(listOf(FINANCE_A, 'use')).toEqual([team]);
  });

  it('still answers a connection they may not use as one that is not there', async () => {
    mockState.rows = mockState.rows.filter((r) => r.target.id !== FINANCE_A);
    stateConnection(FINANCE_A, TEAM_A, [user(BOB)]);
    expect((await call({ as: carol, body: { connection: 'Finance', verb: 'use', grantees: [team] } })).status).toBe(404);
  });
});
