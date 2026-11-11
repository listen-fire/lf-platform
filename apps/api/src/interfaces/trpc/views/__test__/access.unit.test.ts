// What the web is told about who may reach a thing, and what it may change:
// each list with who its people are, whether the caller alone sees the thing,
// whether they may change the lists, and each refusal as the page shows it.
// Which callers reach these at all is the route coverage test's.

import { runWithPrincipal, type Access, type Principal } from 'principal';

import type { Grantee, Target, Verb } from '../../../../services/access/statement';

const TEAM = '11111111-1111-4111-8111-111111111111';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEALS = 'd0000000-0000-4000-8000-000000000001';
const FINANCE = 'c0000000-0000-4000-8000-000000000001';

type Row = { target: Target; verb: Verb; grantee: Grantee };

const mockState: { members: Map<string, Access>; rows: Row[]; pin: string | undefined } = { members: new Map(), rows: [], pin: undefined };

/** The listens of the automation, and the connections they name, as the tables serve them. */
const mockListens: unknown[] = [];
const mockConnections: unknown[] = [];

jest.mock('../../../../services/access/statement', () => {
  const actual = jest.requireActual('../../../../services/access/statement');
  const same = (a: Target, b: Target) => a.thing === b.thing && a.id === b.id;
  const things = new Map([
    [`automation:${DEALS}`, TEAM],
    [`connection:${FINANCE}`, TEAM],
  ]);
  const among = (userIds: string[]) =>
    new Map(userIds.flatMap((userId) => {
      const access = mockState.members.get(userId);
      return access === undefined ? [] : [[userId, access] as const];
    }));
  return {
    ...actual,
    StatementStore: {
      languagePinOf: async () => mockState.pin,
      teamOf: async (target: Target) => things.get(`${target.thing}:${target.id}`),
      grantsOf: async (target: Target, options: { verb: Verb }) =>
        mockState.rows.filter((r) => same(r.target, target) && r.verb === options.verb).map((r) => r.grantee),
      grantsAmong: async (options: { thing: string; ids: string[]; verbs: Verb[] }) => {
        const lists = new Map<string, { verb: Verb; grantee: Grantee }[]>();
        for (const r of mockState.rows) {
          if (r.target.thing !== options.thing || !options.ids.includes(r.target.id) || !options.verbs.includes(r.verb)) continue;
          lists.set(r.target.id, [...(lists.get(r.target.id) ?? []), { verb: r.verb, grantee: r.grantee }]);
        }
        return lists;
      },
      hasAnyStatement: async (target: Target) => mockState.rows.some((r) => same(r.target, target)),
      membershipsOf: async (userId: string, teamIds: string[]) => {
        const access = mockState.members.get(userId);
        return new Map(access === undefined ? [] : teamIds.map((teamId) => [teamId, access] as const));
      },
      membershipsAmong: async (_teamId: string, userIds: string[]) => among(userIds),
      replaceGrants: async (target: Target, options: { verb: Verb; grantees: Grantee[] }) => {
        mockState.rows = [
          ...mockState.rows.filter((r) => !(same(r.target, target) && r.verb === options.verb)),
          ...options.grantees.map((grantee) => ({ target, verb: options.verb, grantee })),
        ];
      },
    },
  };
});

jest.mock('../../../../services/lf_engine/team_engine', () => ({ isLfEngineTeam: async () => false }));

const mockPrincipal: Principal = { teamId: TEAM, userId: ALICE, access: 'write', scopes: ['*'], pinnedTeamId: null };

jest.mock('../../../../services/context', () => ({
  currentContext: () => ({ user: { id: mockPrincipal.userId, teamId: TEAM }, principal: mockPrincipal }),
}));

jest.mock('../../../../services/user', () => ({ UserService: { getById: async (id: string) => ({ id }) } }));

// The people a list names: a name and a primary address each.
jest.mock('../../../../lib/kysely', () => {
  const tables: Record<string, unknown[]> = {
    trigger: mockListens,
    external_service_credentials: mockConnections,
    user: [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'Alice' },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', username: 'Bob' },
    ],
    user_email: [
      { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'alice@acme.com' },
      { user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'bob@acme.com' },
    ],
  };
  const qb = () => {
    let rows: unknown[] = [];
    const chain: object = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') return undefined;
          if (prop === 'selectFrom') {
            return (name: string) => {
              rows = tables[name] ?? [];
              return chain;
            };
          }
          if (prop === 'execute') return async () => rows;
          return () => chain;
        },
      },
    );
    return chain;
  };
  return { getCoreQb: qb, getAutomationsQb: qb };
});

import { trpc } from '../../trpc';
import { accessRouter } from '../access';

const caller = () => accessRouter(trpc.procedure).createCaller({ authorise: async () => {} });

function as<T>(userId: string, call: () => Promise<T>): Promise<T> {
  return runWithPrincipal({ ...mockPrincipal, userId, access: mockState.members.get(userId) ?? 'read' }, call);
}

function stated(target: Target, verb: Verb, grantees: Grantee[]): void {
  mockState.rows.push(...grantees.map((grantee) => ({ target, verb, grantee })));
}

const automation: Target = { thing: 'automation', id: DEALS };
const connection: Target = { thing: 'connection', id: FINANCE };

beforeEach(() => {
  mockState.members = new Map([
    [ALICE, 'write'],
    [BOB, 'write'],
  ]);
  mockState.rows = [];
  mockState.pin = undefined;
  mockListens.length = 0;
  mockConnections.length = 0;
});

describe('reading who may reach an automation', () => {
  it('names each person on a list, says whether the caller may change it, and whether they alone see it', async () => {
    stated(automation, 'read', [{ kind: 'user', userId: ALICE }]);
    stated(automation, 'write', [{ kind: 'user', userId: ALICE }]);
    stated(automation, 'fire', [{ kind: 'domain', domain: 'acme.com' }]);
    const view = await as(ALICE, () => caller().get({ thing: 'automation', id: DEALS }));
    expect(view).toEqual({
      thing: 'automation',
      id: DEALS,
      lists: {
        read: [{ kind: 'user', userId: ALICE, name: 'Alice', email: 'alice@acme.com', onTeam: true }],
        write: [{ kind: 'user', userId: ALICE, name: 'Alice', email: 'alice@acme.com', onTeam: true }],
        fire: [{ kind: 'domain', domain: 'acme.com' }],
      },
      mayChange: true,
      onlyYou: true,
      viewerUserId: ALICE,
      carriedPin: false,
      dropsOwnMessages: [],
    });
  });

  it('says an automation still on an older language version can be fired by anyone only', async () => {
    stated(automation, 'read', [{ kind: 'team' }]);
    stated(automation, 'write', [{ kind: 'user', userId: ALICE }]);
    stated(automation, 'fire', [{ kind: 'anyone' }]);
    mockState.pin = '0.12.13';
    expect(await as(ALICE, () => caller().get({ thing: 'automation', id: DEALS }))).toMatchObject({ carriedPin: true });
    mockState.pin = '4';
    expect(await as(ALICE, () => caller().get({ thing: 'automation', id: DEALS }))).toMatchObject({ carriedPin: true });
  });

  describe('on a Slack connection', () => {
    beforeEach(() => {
      stated(automation, 'read', [{ kind: 'team' }]);
      stated(automation, 'write', [{ kind: 'team' }]);
      stated(automation, 'fire', [{ kind: 'team' }]);
      mockListens.push({ kind: 'slack', credentials_id: FINANCE });
      mockConnections.push({ id: FINANCE, name: 'Team Slack', module_settings: { drop_own_messages: 'on' } });
    });

    it('says whether the connection drops the app’s own messages, and names it to someone who may use it', async () => {
      stated(connection, 'use', [{ kind: 'team' }]);
      const line = { on: true, mayChange: true, connection: { id: FINANCE, name: 'Team Slack' } };
      expect(await as(ALICE, () => caller().get({ thing: 'automation', id: DEALS }))).toMatchObject({ dropsOwnMessages: [line] });
      mockConnections[0] = { id: FINANCE, name: 'Team Slack', module_settings: { drop_own_messages: 'off' } };
      expect(await as(ALICE, () => caller().get({ thing: 'automation', id: DEALS }))).toMatchObject({ dropsOwnMessages: [{ ...line, on: false }] });
    });

    it('lets someone who may use the connection with write on the team change it, and a reader only see it', async () => {
      stated(connection, 'use', [{ kind: 'team' }]);
      mockState.members.set(BOB, 'read');
      const view = await as(BOB, () => caller().get({ thing: 'automation', id: DEALS }));
      expect(view).toMatchObject({ dropsOwnMessages: [{ on: true, mayChange: false, connection: { id: FINANCE } }] });
    });

    it('says how the automation hears, and nothing of the connection, to someone who may not use it', async () => {
      stated(connection, 'use', [{ kind: 'user', userId: BOB }]);
      const view = await as(ALICE, () => caller().get({ thing: 'automation', id: DEALS }));
      expect(view).toMatchObject({ dropsOwnMessages: [{ on: true, mayChange: false, connection: null }] });
      expect(JSON.stringify(view)).not.toContain(FINANCE);
      expect(JSON.stringify(view)).not.toContain('Team Slack');
    });
  });

  it('says a named person who has left the team is no longer on it', async () => {
    stated(automation, 'read', [{ kind: 'user', userId: ALICE }, { kind: 'user', userId: BOB }]);
    stated(automation, 'write', [{ kind: 'user', userId: ALICE }]);
    stated(automation, 'fire', [{ kind: 'team' }]);
    mockState.members.delete(BOB);
    const view = await as(ALICE, () => caller().get({ thing: 'automation', id: DEALS }));
    expect(view.lists).toMatchObject({
      read: [
        { kind: 'user', userId: ALICE, onTeam: true },
        { kind: 'user', userId: BOB, onTeam: false },
      ],
    });
  });

  it('shows a reader the lists without letting them change them', async () => {
    stated(automation, 'read', [{ kind: 'team' }]);
    stated(automation, 'write', [{ kind: 'user', userId: ALICE }]);
    stated(automation, 'fire', [{ kind: 'team' }]);
    const view = await as(BOB, () => caller().get({ thing: 'automation', id: DEALS }));
    expect(view).toMatchObject({ mayChange: false, onlyYou: false, viewerUserId: BOB });
  });

  it('answers an automation the caller may not read as one that is not there', async () => {
    stated(automation, 'read', [{ kind: 'user', userId: BOB }]);
    stated(automation, 'write', [{ kind: 'user', userId: BOB }]);
    await expect(as(ALICE, () => caller().get({ thing: 'automation', id: DEALS }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'That automation was not found.',
    });
  });
});

describe('changing who may reach an automation', () => {
  beforeEach(() => {
    stated(automation, 'read', [{ kind: 'team' }]);
    stated(automation, 'write', [{ kind: 'user', userId: ALICE }]);
    stated(automation, 'fire', [{ kind: 'team' }]);
  });

  it('replaces one list and answers with the automation as it now stands', async () => {
    const set = await as(ALICE, () =>
      caller().set({ thing: 'automation', id: DEALS, verb: 'fire', grantees: [{ kind: 'email', address: 'Pat@Acme.com' }] }),
    );
    expect(set).toMatchObject({ ok: true, view: { lists: { fire: [{ kind: 'email', address: 'pat@acme.com' }] } } });
  });

  it('refuses a fire list other than anyone on an automation still on an older language version, by its reason', async () => {
    mockState.pin = '0.12.13';
    expect(await as(ALICE, () => caller().set({ thing: 'automation', id: DEALS, verb: 'fire', grantees: [{ kind: 'team' }] }))).toEqual({
      ok: false,
      refusal: 'carried_pin',
    });
    expect(await as(ALICE, () => caller().set({ thing: 'automation', id: DEALS, verb: 'fire', grantees: [{ kind: 'anyone' }] }))).toMatchObject({
      ok: true,
      view: { carriedPin: true, lists: { fire: [{ kind: 'anyone' }] } },
    });
  });

  it('refuses a reader as read-only, and a list the decision refuses by its reason', async () => {
    await expect(
      as(BOB, () => caller().set({ thing: 'automation', id: DEALS, verb: 'read', grantees: [{ kind: 'team' }] })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'You may read this automation but not change it.' });
    // By its reason alone: the decision's text is for agents, and the page has its own sentence for each.
    expect(await as(ALICE, () => caller().set({ thing: 'automation', id: DEALS, verb: 'write', grantees: [] }))).toEqual({ ok: false, refusal: 'empty' });
    expect(await as(ALICE, () => caller().set({ thing: 'automation', id: DEALS, verb: 'read', grantees: [{ kind: 'anyone' }] }))).toEqual({
      ok: false,
      refusal: 'outsider',
    });
  });
});

describe('a connection’s use list', () => {
  it('is read and changed by whoever may use it; a read member on the team sees it read-only', async () => {
    stated(connection, 'use', [{ kind: 'user', userId: ALICE }, { kind: 'user', userId: BOB }]);
    const before = await as(ALICE, () => caller().get({ thing: 'connection', id: FINANCE }));
    expect(before).toMatchObject({ mayChange: true, onlyYou: false });
    const after = await as(ALICE, () => caller().set({ thing: 'connection', id: FINANCE, verb: 'use', grantees: [{ kind: 'user', userId: ALICE }] }));
    expect(after).toMatchObject({ ok: true, view: { lists: { use: [{ kind: 'user', userId: ALICE, name: 'Alice' }] }, onlyYou: true } });

    stated(connection, 'use', [{ kind: 'user', userId: BOB }]);
    mockState.members.set(BOB, 'read');
    expect(await as(BOB, () => caller().get({ thing: 'connection', id: FINANCE }))).toMatchObject({ mayChange: false });
    await expect(
      as(BOB, () => caller().set({ thing: 'connection', id: FINANCE, verb: 'use', grantees: [{ kind: 'team' }] })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'You may use this connection but not change who may.' });
  });
});
