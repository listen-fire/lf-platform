// Who may reach a thing, read back by an agent: getAutomation carries an
// automation's three lists and describeConnection a connection's one, each in
// the shape setAccess takes, so a list read can be changed and passed back.
// The real decision and listing run over statements held in memory.

import { Router } from 'express';
import { runWithPrincipal, type Access, type Principal } from 'principal';

import type { RequestHandler } from 'express';
import type { Grantee, Target, Verb } from '../../../../services/access/statement';

const TEAM_A = '11111111-1111-4111-8111-111111111111';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAROL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LEFT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const DEALS = 'd0000000-0000-4000-8000-000000000001';
const FINANCE = 'c0000000-0000-4000-8000-00000000000a';

type Row = { teamId: string; target: Target; verb: Verb; grantee: Grantee };

const mockState: {
  things: Map<string, string>;
  members: Map<string, Access>;
  rows: Row[];
  connections: { id: string; team_id: string; name: string }[];
  describedConnection: { id: string; name: string } | undefined;
} = { things: new Map(), members: new Map(), rows: [], connections: [], describedConnection: undefined };

jest.mock('../../../../services/access/statement', () => {
  const actual = jest.requireActual('../../../../services/access/statement');
  const same = (a: Target, b: Target) => a.thing === b.thing && a.id === b.id;
  return {
    ...actual,
    StatementStore: {
      ...jest.requireActual('../../../../services/access/__test__/no_libraries').noLibraries,
      teamOf: async (target: Target) => mockState.things.get(`${target.thing}:${target.id}`),
      grantsOf: async (target: Target, options: { teamId: string; verb: Verb }) =>
        mockState.rows
          .filter((r) => r.teamId === options.teamId && same(r.target, target) && r.verb === options.verb)
          .map((r) => r.grantee),
      grantsAmong: async (options: { thing: string; teamId: string; ids: readonly string[]; verbs: readonly Verb[] }) => {
        const among = new Map<string, { verb: Verb; grantee: Grantee }[]>();
        for (const row of mockState.rows) {
          if (row.teamId !== options.teamId || row.target.thing !== options.thing) continue;
          if (!options.ids.includes(row.target.id) || !options.verbs.includes(row.verb)) continue;
          among.set(row.target.id, [...(among.get(row.target.id) ?? []), { verb: row.verb, grantee: row.grantee }]);
        }
        return among;
      },
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

jest.mock('../team_scope', () => ({
  ...jest.requireActual('../team_scope'),
  teamSetForReads: async () => [TEAM_A],
  resolveToolTeam: async (team?: string) => team ?? TEAM_A,
}));

const DEALS_ROW = { id: DEALS, teamId: TEAM_A, name: 'Deals', source: '', languageVersion: '0.15.0', validityCheckedAgainst: null };

jest.mock('../../../../services/translation_graph/movement/store', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/store'),
  getMovementRow: async (input: { teamId: string; id: string }) => (input.teamId === TEAM_A && input.id === DEALS ? DEALS_ROW : null),
  getMovementRowByName: async (input: { teamId: string; name: string }) => (input.teamId === TEAM_A && input.name === 'Deals' ? DEALS_ROW : null),
}));

jest.mock('../../../../services/translation_graph/movement/story_token', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/story_token'),
  storyTokenForMovement: async () => 'token',
}));

jest.mock('../../../../services/translation_graph/movement/provision', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/provision'),
  getMovement: async () => DEALS_ROW,
}));

jest.mock('../../../../services/translation_graph/movement/describe_connection', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/describe_connection'),
  describeConnectionCompact: async (input: { system: string }) => `# ${input.system}`,
}));

jest.mock('../../../../services/translation_graph/movement/catalog', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/catalog'),
  describedConnectionOf: async () => mockState.describedConnection,
  describeMovementInstance: async () => ({ schema: null, notes: [] }),
}));

/** The people the lists name, and the connections table, answering the equality conditions a query puts on it. */
jest.mock('../../../../lib/kysely', () => {
  type Condition = { column: string; value: unknown };
  const people: Record<string, Record<string, unknown>[]> = {
    user: [
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', username: 'Bob' },
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', username: 'Dee' },
    ],
    user_email: [{ user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'bob@example.com' }],
  };
  const builder = (table: string) => {
    const conditions: Condition[] = [];
    let columns: string[] = [];
    const matching = () => {
      if (table in people) return people[table] ?? [];
      return mockState.connections
        .filter((row) => conditions.every(({ column, value }) => (row as Record<string, unknown>)[column] === value))
        .map((row) => Object.fromEntries(columns.map((column) => [column, (row as Record<string, unknown>)[column]])));
    };
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
  return { ...jest.requireActual('../../../../lib/kysely'), getCoreQb: () => qb, getAutomationsQb: () => qb, getQb: () => qb };
});

import { mountAutomationToolRoutes } from '../knowledge_agent_tools';

function handlerOf(method: 'get' | 'post', path: string): RequestHandler {
  const router = Router();
  mountAutomationToolRoutes(router);
  const layer = router.stack.find((l) => l.route?.path === path && l.route.stack.some((s) => s.method === method));
  const handler = layer?.route?.stack[layer.route.stack.length - 1]?.handle;
  if (handler === undefined) throw new Error(`${method} ${path} is not mounted`);
  return handler;
}

const getAutomation = handlerOf('get', '/automations/:idOrName');
const describeConnection = handlerOf('post', '/connections/describe');
const setAccess = handlerOf('post', '/access');

type Answer = { status: number; body: unknown; type?: string };

async function call(handler: RequestHandler, asked: { as?: Principal; params?: object; body?: object }): Promise<Answer> {
  const answer: Answer = { status: 200, body: {} };
  const res = {
    status(code: number) {
      answer.status = code;
      return res;
    },
    type(type: string) {
      answer.type = type;
      return res;
    },
    json(body: unknown) {
      answer.body = body;
      return res;
    },
    send(body: unknown) {
      answer.body = body;
      return res;
    },
  };
  const principal = asked.as ?? { teamId: TEAM_A, userId: ALICE, access: 'write', scopes: ['*'], pinnedTeamId: null };
  await runWithPrincipal(principal, () =>
    Promise.resolve(handler({ params: asked.params ?? {}, body: asked.body ?? {}, query: {} } as never, res as never, () => undefined)),
  );
  return answer;
}

const team: Grantee = { kind: 'team' };
const user = (userId: string): Grantee => ({ kind: 'user', userId });

function state(target: Target, lists: Partial<Record<Verb, Grantee[]>>) {
  mockState.things.set(`${target.thing}:${target.id}`, TEAM_A);
  for (const [verb, grantees] of Object.entries(lists)) {
    for (const grantee of grantees) mockState.rows.push({ teamId: TEAM_A, target, verb: verb as Verb, grantee });
  }
}

const listOf = (id: string, verb: Verb) => mockState.rows.filter((r) => r.target.id === id && r.verb === verb).map((r) => r.grantee);

const carol: Principal = { teamId: TEAM_A, userId: CAROL, access: 'read', scopes: ['*'], pinnedTeamId: null };

beforeEach(() => {
  mockState.things = new Map();
  mockState.rows = [];
  mockState.describedConnection = { id: FINANCE, name: 'Finance' };
  mockState.members = new Map([
    [`${TEAM_A}:${ALICE}`, 'write'],
    [`${TEAM_A}:${BOB}`, 'write'],
    [`${TEAM_A}:${CAROL}`, 'read'],
  ]);
  mockState.connections = [{ id: FINANCE, team_id: TEAM_A, name: 'Finance' }];
  state(
    { thing: 'automation', id: DEALS },
    {
      read: [team],
      write: [user(ALICE), user(BOB)],
    },
  );
  state({ thing: 'connection', id: FINANCE }, { use: [user(ALICE), user(BOB), user(LEFT)] });
});

describe('getAutomation', () => {
  it('returns the read and write lists, who each named user is, and what the caller may do', async () => {
    const answer = await call(getAutomation, { params: { idOrName: 'Deals' } });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      id: DEALS,
      access: {
        read: [team],
        write: [
          { kind: 'user', userId: ALICE, name: null, email: null, onTeam: false },
          { kind: 'user', userId: BOB, name: 'Bob', email: 'bob@example.com', onTeam: true },
        ],
        mayChange: true,
        onlyYou: false,
      },
    });
    expect((answer.body as { access: object }).access).not.toHaveProperty('fire');
    expect((answer.body as { access: object }).access).not.toHaveProperty('carriedPin');
    expect((answer.body as { access: object }).access).not.toHaveProperty('teamRunsOnLf');
  });

  it('gives a list that setAccess accepts back unchanged, and stores it as it was', async () => {
    const { body } = await call(getAutomation, { params: { idOrName: 'Deals' } });
    const { access } = body as { access: Record<'read' | 'write', unknown[]> };
    for (const verb of ['read', 'write'] as const) {
      const before = JSON.stringify(listOf(DEALS, verb));
      const answer = await call(setAccess, { body: { automation: 'Deals', verb, grantees: access[verb] } });
      expect(answer.status).toBe(200);
      expect(JSON.stringify(listOf(DEALS, verb))).toBe(before);
    }
  });

  it('says a read only caller may not change the lists', async () => {
    const answer = await call(getAutomation, { as: carol, params: { idOrName: 'Deals' } });
    expect(answer.body).toMatchObject({ access: { mayChange: false } });
  });

  it('answers an automation the caller may not read as one that is not there', async () => {
    mockState.rows = mockState.rows.filter((r) => r.target.id !== DEALS);
    state({ thing: 'automation', id: DEALS }, { read: [user(BOB)], write: [user(BOB)] });
    const unseen = await call(getAutomation, { as: carol, params: { idOrName: 'Deals' } });
    const missing = await call(getAutomation, { as: carol, params: { idOrName: 'Nowhere' } });
    expect(JSON.stringify(unseen.body)).not.toContain('access');
    expect({ ...unseen, body: { error: String((unseen.body as { error: unknown }).error).replace('Deals', 'Nowhere') } }).toEqual(missing);
  });
});

describe('describeConnection', () => {
  it('returns who may use the connection beside the compact text', async () => {
    const answer = await call(describeConnection, { body: { system: 'finance' } });
    expect(answer.status).toBe(200);
    expect(answer.type).toBe('text/markdown');
    const text = String(answer.body);
    expect(text.startsWith('# finance')).toBe(true);
    const json = text.slice(text.indexOf('```json\n') + '```json\n'.length, text.lastIndexOf('\n```'));
    expect(JSON.parse(json)).toEqual({
      use: [
        { kind: 'user', userId: ALICE, name: null, email: null, onTeam: false },
        { kind: 'user', userId: BOB, name: 'Bob', email: 'bob@example.com', onTeam: true },
        { kind: 'user', userId: LEFT, name: 'Dee', email: null, onTeam: false },
      ],
      mayChange: true,
      onlyYou: false,
    });
    expect(text).toContain('Access to connection "Finance"');
  });

  it('returns it as a field of the full description', async () => {
    const answer = await call(describeConnection, { body: { system: 'finance', detail: 'full' } });
    expect(answer.body).toMatchObject({
      connection: { id: FINANCE, name: 'Finance' },
      access: { use: [{ userId: ALICE }, { userId: BOB }, { userId: LEFT }], mayChange: true, onlyYou: false },
    });
  });

  it('gives a list that setAccess accepts back unchanged', async () => {
    const { body } = await call(describeConnection, { body: { system: 'finance', detail: 'full' } });
    const { access } = body as { access: { use: unknown[] } };
    const answer = await call(setAccess, { body: { connection: 'Finance', verb: 'use', grantees: access.use.slice(0, 2) } });
    expect(answer.status).toBe(200);
    expect(listOf(FINANCE, 'use')).toEqual([user(ALICE), user(BOB)]);
  });

  it('says nothing about access below the root or when no connection stands behind it', async () => {
    const below = await call(describeConnection, { body: { system: 'finance', position: '-[:Invoices]->' } });
    expect(String(below.body)).not.toContain('Access to');
    mockState.describedConnection = undefined;
    const none = await call(describeConnection, { body: { system: 'finance' } });
    expect(String(none.body)).not.toContain('Access to');
  });
});
