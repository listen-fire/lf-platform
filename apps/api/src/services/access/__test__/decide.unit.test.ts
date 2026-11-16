// The one decision about an automation or a connection, over an in-memory
// table: who a statement admits, what team membership caps, and what happens
// to a list when the last person it names leaves the team.

import { logger } from 'movement-engine/public/log';

import type { Access, Principal } from 'principal';
import type { Grantee, Target, Thing, Verb } from '../statement';

type Row = { teamId: string; target: Target; verb: Verb; grantee: Grantee };

const mockTable: {
  things: Map<string, string>;
  members: Map<string, Access>;
  memberSince: string[];
  rows: Row[];
  /** What each file names directly, by file id; a file in here exports. */
  names: Map<string, { connections: Target<'connection'>[]; libraries: Target<'automation'>[] }>;
  standing: Map<string, string | null>;
} = { things: new Map(), members: new Map(), memberSince: [], rows: [], names: new Map(), standing: new Map() };

jest.mock('../statement', () => {
  const actual = jest.requireActual('../statement');
  const same = (a: Target, b: Target) => a.thing === b.thing && a.id === b.id;
  return {
    ...actual,
    StatementStore: {
      teamOf: async (target: Target) => mockTable.things.get(`${target.thing}:${target.id}`),
      grantsOf: async (target: Target, options: { teamId: string; verb: Verb }) =>
        mockTable.rows
          .filter((r) => r.teamId === options.teamId && same(r.target, target) && r.verb === options.verb)
          .map((r) => r.grantee),
      grantsAmong: async (options: { thing: Thing; teamId: string; ids: string[]; verbs: Verb[] }) => {
        const lists = new Map<string, { verb: Verb; grantee: Grantee }[]>();
        for (const r of mockTable.rows) {
          if (r.teamId !== options.teamId || r.target.thing !== options.thing) continue;
          if (!options.ids.includes(r.target.id) || !options.verbs.includes(r.verb)) continue;
          lists.set(r.target.id, [...(lists.get(r.target.id) ?? []), { verb: r.verb, grantee: r.grantee }]);
        }
        return lists;
      },
      replaceGrants: async (target: Target, options: { teamId: string; verb: Verb; grantees: Grantee[] }) => {
        mockTable.rows = [
          ...mockTable.rows.filter((r) => !(same(r.target, target) && r.verb === options.verb)),
          ...options.grantees.map((grantee) => ({ teamId: options.teamId, target, verb: options.verb, grantee })),
        ];
      },
      grantedIds: async (options: { thing: Thing; verb: Verb; teamIds: string[]; userId?: string }) =>
        new Set(
          mockTable.rows
            .filter(
              (r) =>
                options.teamIds.includes(r.teamId) &&
                r.target.thing === options.thing &&
                r.verb === options.verb &&
                (r.grantee.kind === 'team' || (r.grantee.kind === 'user' && r.grantee.userId === options.userId)),
            )
            .map((r) => r.target.id),
        ),
      listsNaming: async (options: { teamId: string; userId: string }) =>
        mockTable.rows
          .filter((r) => r.teamId === options.teamId && r.grantee.kind === 'user' && r.grantee.userId === options.userId)
          .map((r) => ({ target: r.target, verb: r.verb })),
      hasAnyStatement: async (target: Target) => mockTable.rows.some((r) => same(r.target, target)),
      librariesOf: async (teamId: string) => [
        ...new Set(mockTable.rows.filter((r) => r.teamId === teamId && r.target.thing === 'automation' && r.verb === 'use').map((r) => r.target.id)),
      ],
      exportsSomething: async (target: Target) => mockTable.names.has(target.id),
      namedBy: async (target: Target) => mockTable.names.get(target.id) ?? { connections: [], libraries: [] },
      nameOf: async (target: Target) => `name-of-${target.id.slice(-1)}`,
      standingsOf: async (ids: string[]) =>
        new Map(ids.flatMap((id) => (mockTable.standing.has(id) ? [[id, { lostConnectionId: mockTable.standing.get(id) ?? null }] as const] : []))),
      setStanding: async (target: Target, options: { lostConnectionId: string | null }) => {
        mockTable.standing.set(target.id, options.lostConnectionId);
      },
      // Membership is keyed by a uuid column, which Postgres compares without
      // regard to case, and it answers with the canonical lowercase id.
      membershipsOf: async (userId: string, teamIds: string[]) =>
        new Map(
          teamIds.flatMap((teamId) => {
            const access = mockTable.members.get(`${teamId}:${userId.toLowerCase()}`);
            return access === undefined ? [] : [[teamId, access] as const];
          }),
        ),
      membershipsAmong: async (teamId: string, userIds: string[]) =>
        new Map(
          userIds.flatMap((userId) => {
            const access = mockTable.members.get(`${teamId}:${userId.toLowerCase()}`);
            return access === undefined ? [] : [[userId.toLowerCase(), access] as const];
          }),
        ),
      membersOf: async (teamId: string) =>
        new Map(
          [...mockTable.members]
            .filter(([key]) => key.startsWith(`${teamId}:`))
            .map(([key, access]) => [key.slice(teamId.length + 1), access] as const),
        ),
      adminsOf: async (teamId: string) =>
        mockTable.memberSince
          .filter((key) => key.startsWith(`${teamId}:`) && mockTable.members.get(key) === 'admin')
          .map((key) => key.slice(teamId.length + 1)),
    },
  };
});

import {
  accessTo,
  administered,
  adminOf,
  checkConnectionCreation,
  checkCreation,
  stateAtCreation,
  mayChangeStatement,
  maySeeStatement,
  membersAdmitted,
  passOnWhatTheyHeld,
  recomputeLibraryStanding,
  seenOnlyBy,
  readableIds,
  setStatement,
  stateCreation,
  StatementRefusedError,
} from '../decide';

const TEAM = '11111111-1111-4111-8111-111111111111';
const OTHER_TEAM = '22222222-2222-4222-8222-222222222222';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAROL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEALS: Target<'automation'> = { thing: 'automation', id: 'd0000000-0000-4000-8000-000000000001' };
const NOTES: Target<'automation'> = { thing: 'automation', id: 'd0000000-0000-4000-8000-000000000002' };
const ELSEWHERE: Target<'automation'> = { thing: 'automation', id: 'd0000000-0000-4000-8000-000000000003' };
const LEDGER: Target<'automation'> = { thing: 'automation', id: 'd0000000-0000-4000-8000-000000000004' };
const FINANCE: Target<'connection'> = { thing: 'connection', id: 'c0000000-0000-4000-8000-000000000001' };

function member(teamId: string, userId: string, access: Access): void {
  mockTable.members.set(`${teamId}:${userId}`, access);
  mockTable.memberSince.push(`${teamId}:${userId}`);
}

function leaves(teamId: string, userId: string): void {
  mockTable.members.delete(`${teamId}:${userId}`);
  mockTable.memberSince = mockTable.memberSince.filter((key) => key !== `${teamId}:${userId}`);
}

function thing(target: Target, teamId = TEAM): void {
  mockTable.things.set(`${target.thing}:${target.id}`, teamId);
}

function stated(target: Target, verb: Verb, grantees: Grantee[], teamId = TEAM): void {
  mockTable.rows.push(...grantees.map((grantee) => ({ teamId, target, verb, grantee })));
}

function person(userId: string, extra: Partial<Principal> = {}): Principal {
  return { teamId: TEAM, userId, access: mockTable.members.get(`${TEAM}:${userId}`) ?? 'read', scopes: ['*'], pinnedTeamId: null, ...extra };
}

function machine(extra: Partial<Principal> = {}): Principal {
  return { teamId: TEAM, access: 'write', scopes: ['*'], pinnedTeamId: TEAM, ...extra };
}

const user = (userId: string): Grantee => ({ kind: 'user', userId });
const team: Grantee = { kind: 'team' };

function listOf(target: Target, verb: Verb): Grantee[] {
  return mockTable.rows.filter((r) => r.target.id === target.id && r.verb === verb).map((r) => r.grantee);
}

beforeEach(() => {
  mockTable.things = new Map();
  mockTable.members = new Map();
  mockTable.memberSince = [];
  mockTable.rows = [];
  mockTable.names = new Map();
  mockTable.standing = new Map();
  thing(DEALS);
  thing(NOTES);
  thing(FINANCE);
  thing(ELSEWHERE, OTHER_TEAM);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('accessTo', () => {
  it('admits a named user only while they are on the thing’s team', async () => {
    member(TEAM, ALICE, 'write');
    stated(DEALS, 'read', [user(ALICE)]);
    expect(await accessTo(person(ALICE), { target: DEALS, verb: 'read' })).toBe(true);

    leaves(TEAM, ALICE);
    member(OTHER_TEAM, ALICE, 'write');
    expect(await accessTo(person(ALICE), { target: DEALS, verb: 'read' })).toBe(false);
  });

  it('admits nobody a list does not name, and nobody when nothing is stated', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'write');
    stated(DEALS, 'read', [user(BOB)]);
    expect(await accessTo(person(ALICE), { target: DEALS, verb: 'read' })).toBe(false);
    expect(await accessTo(person(ALICE), { target: NOTES, verb: 'read' })).toBe(false);
  });

  it('lets team membership cap it: a read member never writes, whatever the statement says', async () => {
    member(TEAM, ALICE, 'read');
    member(TEAM, BOB, 'write');
    stated(DEALS, 'write', [team, user(ALICE)]);
    expect(await accessTo(person(ALICE), { target: DEALS, verb: 'write' })).toBe(false);
    expect(await accessTo(person(BOB), { target: DEALS, verb: 'write' })).toBe(true);
  });

  it('lets whoever may write an automation read it, while membership still caps', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'write');
    member(TEAM, CAROL, 'read');
    stated(DEALS, 'read', [user(ALICE)]);
    stated(DEALS, 'write', [team]);
    expect(await accessTo(person(BOB), { target: DEALS, verb: 'read' })).toBe(true);
    expect(await accessTo(person(CAROL), { target: DEALS, verb: 'read' })).toBe(false);
    expect(await readableIds(person(BOB), { thing: 'automation', teamIds: [TEAM] })).toEqual(new Set([DEALS.id]));
    expect(await readableIds(person(CAROL), { thing: 'automation', teamIds: [TEAM] })).toEqual(new Set());
  });

  it('caps by the membership on the thing’s team, not by the access the caller arrived with', async () => {
    member(TEAM, ALICE, 'read');
    stated(DEALS, 'write', [team]);
    expect(await accessTo(person(ALICE, { teamId: OTHER_TEAM, access: 'write' }), { target: DEALS, verb: 'write' })).toBe(false);
  });

  it('takes a key as its creator', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'write');
    stated(DEALS, 'read', [user(ALICE)]);
    expect(await accessTo(person(ALICE, { credentialId: 'key-1', pinnedTeamId: TEAM }), { target: DEALS, verb: 'read' })).toBe(true);
    expect(await accessTo(person(BOB, { credentialId: 'key-2', pinnedTeamId: TEAM }), { target: DEALS, verb: 'read' })).toBe(false);
  });

  it('keeps a credential pinned to one team out of the others its creator belongs to', async () => {
    member(TEAM, ALICE, 'write');
    member(OTHER_TEAM, ALICE, 'write');
    stated(ELSEWHERE, 'read', [team], OTHER_TEAM);
    expect(await accessTo(person(ALICE, { pinnedTeamId: TEAM }), { target: ELSEWHERE, verb: 'read' })).toBe(false);
    expect(await accessTo(person(ALICE), { target: ELSEWHERE, verb: 'read' })).toBe(true);
  });

  it('matches a principal with no user to team grants only, on its own team', async () => {
    stated(DEALS, 'read', [team]);
    stated(NOTES, 'read', [user(ALICE)]);
    stated(ELSEWHERE, 'read', [team], OTHER_TEAM);
    expect(await accessTo(machine(), { target: DEALS, verb: 'read' })).toBe(true);
    expect(await accessTo(machine(), { target: NOTES, verb: 'read' })).toBe(false);
    expect(await accessTo(machine(), { target: ELSEWHERE, verb: 'read' })).toBe(false);
  });

  it('caps a machine principal by its own access', async () => {
    stated(DEALS, 'write', [team]);
    expect(await accessTo(machine({ access: 'read' }), { target: DEALS, verb: 'write' })).toBe(false);
    expect(await accessTo(machine(), { target: DEALS, verb: 'write' })).toBe(true);
  });

  it('decides a connection by its use list', async () => {
    member(TEAM, ALICE, 'read');
    member(TEAM, BOB, 'write');
    stated(FINANCE, 'use', [user(ALICE)]);
    expect(await accessTo(person(ALICE), { target: FINANCE, verb: 'use' })).toBe(true);
    expect(await accessTo(person(BOB), { target: FINANCE, verb: 'use' })).toBe(false);
  });

  it('says no about a thing that does not exist, or an id that is not one', async () => {
    member(TEAM, ALICE, 'write');
    expect(await accessTo(person(ALICE), { target: { thing: 'automation', id: 'd0000000-0000-4000-8000-00000000dead' }, verb: 'read' })).toBe(false);
    expect(await accessTo(person(ALICE), { target: { thing: 'automation', id: 'not-a-uuid' }, verb: 'read' })).toBe(false);
  });
});

describe('readableIds', () => {
  it('lists what the caller may read across the teams asked about, and only those', async () => {
    member(TEAM, ALICE, 'read');
    member(OTHER_TEAM, ALICE, 'read');
    stated(DEALS, 'read', [team]);
    stated(NOTES, 'read', [user(BOB)]);
    stated(ELSEWHERE, 'read', [user(ALICE)], OTHER_TEAM);
    expect(await readableIds(person(ALICE), { thing: 'automation', teamIds: [TEAM, OTHER_TEAM] })).toEqual(new Set([DEALS.id, ELSEWHERE.id]));
    expect(await readableIds(person(ALICE), { thing: 'automation', teamIds: [TEAM] })).toEqual(new Set([DEALS.id]));
  });

  it('lists nothing on a team the caller is not on, or one their credential is not pinned to', async () => {
    member(TEAM, ALICE, 'write');
    member(OTHER_TEAM, ALICE, 'write');
    stated(ELSEWHERE, 'read', [team], OTHER_TEAM);
    expect(await readableIds(person(BOB), { thing: 'automation', teamIds: [TEAM, OTHER_TEAM] })).toEqual(new Set());
    expect(await readableIds(person(ALICE, { pinnedTeamId: TEAM }), { thing: 'automation', teamIds: [OTHER_TEAM] })).toEqual(new Set());
  });

  it('lists connections by their use list, and a machine principal by team grants on its own team', async () => {
    stated(FINANCE, 'use', [team]);
    stated(ELSEWHERE, 'read', [team], OTHER_TEAM);
    expect(await readableIds(machine(), { thing: 'connection', teamIds: [TEAM] })).toEqual(new Set([FINANCE.id]));
    expect(await readableIds(machine(), { thing: 'automation', teamIds: [TEAM, OTHER_TEAM] })).toEqual(new Set());
  });
});

describe('setStatement', () => {
  it('replaces a verb’s whole list', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'write');
    stated(DEALS, 'write', [user(ALICE)]);
    stated(DEALS, 'read', [team]);
    await setStatement(person(ALICE), { target: DEALS, verb: 'read', grantees: [user(ALICE), user(BOB)] });
    expect(listOf(DEALS, 'read')).toEqual([user(ALICE), user(BOB)]);
    expect(listOf(DEALS, 'write')).toEqual([user(ALICE)]);
  });

  it('refuses an empty list', async () => {
    member(TEAM, ALICE, 'write');
    stated(DEALS, 'write', [user(ALICE)]);
    stated(DEALS, 'read', [team]);
    await expect(setStatement(person(ALICE), { target: DEALS, verb: 'read', grantees: [] })).rejects.toMatchObject({ refusal: 'empty' });
    expect(listOf(DEALS, 'read')).toEqual([team]);
  });

  it('lets whoever may write the automation change its statement, and nobody else', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'write');
    stated(DEALS, 'write', [user(ALICE)]);
    stated(DEALS, 'read', [team]);
    await expect(setStatement(person(BOB), { target: DEALS, verb: 'read', grantees: [user(BOB)] })).rejects.toBeInstanceOf(StatementRefusedError);
    await expect(setStatement(person(BOB), { target: DEALS, verb: 'write', grantees: [user(BOB)] })).rejects.toMatchObject({ refusal: 'not_allowed' });
    expect(listOf(DEALS, 'write')).toEqual([user(ALICE)]);
  });

  it('lets whoever may use the connection change its statement, if they may write on the team', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'write');
    member(TEAM, CAROL, 'read');
    stated(FINANCE, 'use', [user(ALICE), user(CAROL)]);
    await expect(setStatement(person(BOB), { target: FINANCE, verb: 'use', grantees: [user(BOB)] })).rejects.toMatchObject({ refusal: 'not_allowed' });
    await expect(setStatement(person(CAROL), { target: FINANCE, verb: 'use', grantees: [team] })).rejects.toMatchObject({ refusal: 'not_allowed' });
    await setStatement(person(ALICE), { target: FINANCE, verb: 'use', grantees: [team] });
    expect(listOf(FINANCE, 'use')).toEqual([team]);
  });

  it('lets a write member state a thing that has no statement yet, as at creation', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, CAROL, 'read');
    await expect(setStatement(person(CAROL), { target: DEALS, verb: 'write', grantees: [team] })).rejects.toMatchObject({ refusal: 'not_allowed' });
    await setStatement(person(ALICE), { target: DEALS, verb: 'write', grantees: [user(ALICE)] });
    await setStatement(person(ALICE), { target: DEALS, verb: 'read', grantees: [team] });
    await setStatement(machine(), { target: FINANCE, verb: 'use', grantees: [team] });
    expect(listOf(DEALS, 'write')).toEqual([user(ALICE)]);
    expect(listOf(DEALS, 'read')).toEqual([team]);
    expect(listOf(FINANCE, 'use')).toEqual([team]);
  });

  it('names only the team or members of it on a list', async () => {
    member(TEAM, ALICE, 'write');
    stated(DEALS, 'write', [user(ALICE)]);
    await expect(setStatement(person(ALICE), { target: DEALS, verb: 'read', grantees: [user(BOB)] })).rejects.toMatchObject({ refusal: 'not_a_member' });
  });

  it('names only write members on the write list, so it never ends with nobody who can write', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, CAROL, 'read');
    stated(DEALS, 'write', [user(ALICE)]);
    await expect(
      setStatement(person(ALICE), { target: DEALS, verb: 'write', grantees: [user(CAROL)] }),
    ).rejects.toMatchObject({ refusal: 'not_a_writer' });
    expect(listOf(DEALS, 'write')).toEqual([user(ALICE)]);
    await setStatement(person(ALICE), { target: DEALS, verb: 'read', grantees: [user(CAROL)] });
    expect(listOf(DEALS, 'read')).toEqual([user(CAROL)]);
  });

  it('stores a user id in its lowercase form, so it matches whoever it names', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'write');
    stated(DEALS, 'write', [user(ALICE)]);
    await setStatement(person(ALICE), { target: DEALS, verb: 'read', grantees: [user(BOB.toUpperCase())] });
    expect(listOf(DEALS, 'read')).toEqual([user(BOB)]);
    expect(await accessTo(person(BOB), { target: DEALS, verb: 'read' })).toBe(true);
    expect(await readableIds(person(BOB), { thing: 'automation', teamIds: [TEAM] })).toEqual(new Set([DEALS.id]));
  });

  it('opens the creation window only while nothing at all is stated about the thing', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'write');
    stated(DEALS, 'read', [user(BOB)]);
    await expect(
      setStatement(person(ALICE), { target: DEALS, verb: 'write', grantees: [user(ALICE)] }),
    ).rejects.toMatchObject({ refusal: 'not_allowed' });
    expect(listOf(DEALS, 'write')).toEqual([]);
  });

  it('refuses a thing that does not exist', async () => {
    member(TEAM, ALICE, 'write');
    await expect(
      setStatement(person(ALICE), { target: { thing: 'automation', id: 'd0000000-0000-4000-8000-00000000dead' }, verb: 'read', grantees: [team] }),
    ).rejects.toMatchObject({ refusal: 'not_found' });
  });
});

describe('creating an automation with its statements', () => {
  const NEW: Target<'automation'> = { thing: 'automation', id: 'd0000000-0000-4000-8000-000000000009' };
  const statements = { read: [team], write: [user(ALICE)] };

  it('passes a write member who names themselves, or the team, on the write list', async () => {
    member(TEAM, ALICE, 'write');
    await expect(checkCreation(person(ALICE), { teamId: TEAM, statements })).resolves.toBeUndefined();
    await expect(checkCreation(person(ALICE), { teamId: TEAM, statements: { ...statements, write: [team] } })).resolves.toBeUndefined();
  });

  it('refuses a creator the write list leaves out, a read member, and lists that could not be stored', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'write');
    member(TEAM, CAROL, 'read');
    await expect(checkCreation(person(ALICE), { teamId: TEAM, statements: { ...statements, write: [user(BOB)] } })).rejects.toMatchObject({ refusal: 'not_allowed' });
    await expect(checkCreation(person(CAROL), { teamId: TEAM, statements: { ...statements, write: [team] } })).rejects.toMatchObject({ refusal: 'not_allowed' });
    await expect(checkCreation(person(ALICE), { teamId: TEAM, statements: { ...statements, read: [] } })).rejects.toMatchObject({ refusal: 'empty' });
    await expect(checkCreation(person(ALICE), { teamId: TEAM, statements: { ...statements, write: [user(ALICE), user(CAROL)] } })).rejects.toMatchObject({ refusal: 'not_a_writer' });
  });

  it('states write first, then read, so the creator states the rest as a writer', async () => {
    member(TEAM, ALICE, 'write');
    thing(NEW);
    await stateCreation(person(ALICE), { target: NEW, statements });
    expect(mockTable.rows.filter((r) => r.target.id === NEW.id).map((r) => r.verb)).toEqual(['write', 'read']);
    expect(await accessTo(person(ALICE), { target: NEW, verb: 'write' })).toBe(true);
  });
});

describe('membersAdmitted', () => {
  it('names the members any of the lists admits, as membership caps them', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'read');
    member(OTHER_TEAM, CAROL, 'write');
    expect(await membersAdmitted(TEAM, [{ verb: 'read', grantees: [team] }])).toEqual(new Set([ALICE, BOB]));
    expect(await membersAdmitted(TEAM, [{ verb: 'write', grantees: [team] }])).toEqual(new Set([ALICE]));
    expect(await membersAdmitted(TEAM, [{ verb: 'use', grantees: [user(BOB), user(CAROL)] }])).toEqual(new Set([BOB]));
  });
});

describe('seenOnlyBy', () => {
  const only = (userId: string, thing: Thing, ids: string[]) => seenOnlyBy(person(userId), { thing, teamId: TEAM, ids });

  it('finds the automations whose read and write lists admit the caller alone', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'write');
    stated(DEALS, 'read', [user(ALICE)]);
    stated(DEALS, 'write', [user(ALICE)]);
    stated(NOTES, 'read', [user(ALICE)]);
    stated(NOTES, 'write', [user(BOB)]);
    expect(await only(ALICE, 'automation', [DEALS.id, NOTES.id])).toEqual(new Set([DEALS.id]));
    expect(await only(BOB, 'automation', [DEALS.id, NOTES.id])).toEqual(new Set());
  });

  it('never counts a team grant as the caller alone, even on a team of one', async () => {
    member(TEAM, ALICE, 'write');
    stated(DEALS, 'read', [team]);
    stated(DEALS, 'write', [user(ALICE)]);
    expect(await only(ALICE, 'automation', [DEALS.id])).toEqual(new Set());
  });

  it('counts only who still holds a list: a named member who left, or a reader on a write list, admits nobody', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'read');
    stated(DEALS, 'read', [user(ALICE), user(CAROL)]);
    stated(DEALS, 'write', [user(ALICE), user(BOB)]);
    expect(await only(ALICE, 'automation', [DEALS.id])).toEqual(new Set([DEALS.id]));
  });

  it('reads a connection by its use list, and a machine principal is never anyone alone', async () => {
    member(TEAM, ALICE, 'write');
    stated(FINANCE, 'use', [user(ALICE)]);
    expect(await only(ALICE, 'connection', [FINANCE.id])).toEqual(new Set([FINANCE.id]));
    expect(await seenOnlyBy(machine(), { thing: 'connection', teamId: TEAM, ids: [FINANCE.id] })).toEqual(new Set());
  });
});

describe('mayChangeStatement', () => {
  it('answers as setStatement decides: write on the automation, use on the connection, and only on a thing that exists', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'write');
    stated(DEALS, 'write', [user(ALICE)]);
    stated(DEALS, 'read', [team]);
    stated(FINANCE, 'use', [user(BOB)]);
    expect(await mayChangeStatement(person(ALICE), DEALS)).toBe(true);
    expect(await mayChangeStatement(person(BOB), DEALS)).toBe(false);
    expect(await mayChangeStatement(person(ALICE), FINANCE)).toBe(false);
    expect(await mayChangeStatement(person(BOB), FINANCE)).toBe(true);
    expect(await mayChangeStatement(person(ALICE), { thing: 'automation', id: 'd0000000-0000-4000-8000-00000000dead' })).toBe(false);
  });
});

describe('passOnWhatTheyHeld, when a member leaves the team', () => {
  it('passes a verb they were the last named holder of to the team’s admins, and logs it', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'admin');
    member(TEAM, CAROL, 'write');
    stated(DEALS, 'read', [user(ALICE)]);
    stated(DEALS, 'write', [user(ALICE), user(BOB)]);
    stated(FINANCE, 'use', [user(ALICE)]);
    stated(NOTES, 'read', [team, user(ALICE)]);

    leaves(TEAM, ALICE);
    await passOnWhatTheyHeld({ teamId: TEAM, userId: ALICE, because: 'left' });

    expect(listOf(DEALS, 'read')).toEqual([user(BOB)]);
    expect(listOf(DEALS, 'write')).toEqual([user(ALICE), user(BOB)]);
    expect(listOf(FINANCE, 'use')).toEqual([user(BOB)]);
    expect(listOf(NOTES, 'read')).toEqual([team, user(ALICE)]);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('[access]'),
      expect.objectContaining({ teamId: TEAM, userId: ALICE, thing: 'automation', thingId: DEALS.id, verb: 'read', to: [BOB] }),
    );
  });

  it('counts a named holder who already left as nobody', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'admin');
    stated(DEALS, 'read', [user(ALICE), user(CAROL)]);

    leaves(TEAM, ALICE);
    await passOnWhatTheyHeld({ teamId: TEAM, userId: ALICE, because: 'left' });
    expect(listOf(DEALS, 'read')).toEqual([user(BOB)]);
  });

  it('counts a read member on a write list as nobody who can write', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'admin');
    member(TEAM, CAROL, 'read');
    stated(DEALS, 'write', [user(ALICE), user(CAROL)]);

    leaves(TEAM, ALICE);
    await passOnWhatTheyHeld({ teamId: TEAM, userId: ALICE, because: 'left' });
    expect(listOf(DEALS, 'write')).toEqual([user(BOB)]);
  });

  it('finds what a leaver held whatever case their id arrives in', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'admin');
    stated(DEALS, 'read', [user(ALICE)]);

    leaves(TEAM, ALICE);
    await passOnWhatTheyHeld({ teamId: TEAM, userId: ALICE.toUpperCase(), because: 'left' });
    expect(listOf(DEALS, 'read')).toEqual([user(BOB)]);
  });

  it('gives it to the team when the team has no admin left, however many write members it has', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    member(TEAM, ALICE, 'admin');
    member(TEAM, BOB, 'write');
    member(TEAM, CAROL, 'read');
    stated(DEALS, 'read', [user(ALICE)]);

    leaves(TEAM, ALICE);
    await passOnWhatTheyHeld({ teamId: TEAM, userId: ALICE, because: 'left' });
    expect(listOf(DEALS, 'read')).toEqual([team]);
  });
});

describe('passOnWhatTheyHeld, when a member loses write access', () => {
  it('passes a write list they alone held to the team’s admins, and keeps what they still hold', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    member(TEAM, ALICE, 'admin');
    member(TEAM, BOB, 'admin');
    stated(DEALS, 'write', [user(ALICE)]);
    stated(DEALS, 'read', [user(ALICE)]);
    stated(FINANCE, 'use', [user(ALICE)]);

    mockTable.members.set(`${TEAM}:${ALICE}`, 'read');
    await passOnWhatTheyHeld({ teamId: TEAM, userId: ALICE, because: 'lost_write' });

    expect(listOf(DEALS, 'write')).toEqual([user(BOB)]);
    expect(listOf(DEALS, 'read')).toEqual([user(ALICE)]);
    expect(listOf(FINANCE, 'use')).toEqual([user(ALICE)]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('lost write access'),
      expect.objectContaining({ userId: ALICE, because: 'lost_write', thingId: DEALS.id, verb: 'write', to: [BOB] }),
    );
  });

  it('gives the write list to the team when nobody on it has write access any more', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    member(TEAM, ALICE, 'admin');
    stated(DEALS, 'write', [user(ALICE)]);

    mockTable.members.set(`${TEAM}:${ALICE}`, 'read');
    await passOnWhatTheyHeld({ teamId: TEAM, userId: ALICE, because: 'lost_write' });
    expect(listOf(DEALS, 'write')).toEqual([team]);
  });
});

describe('a team admin', () => {
  beforeEach(() => {
    member(TEAM, ALICE, 'admin');
    member(TEAM, BOB, 'write');
    member(TEAM, CAROL, 'read');
    stated(DEALS, 'write', [user(BOB)]);
    stated(DEALS, 'read', [user(BOB)]);
    stated(FINANCE, 'use', [user(BOB)]);
  });

  it('sees that a thing exists and who may reach it, but not its content, unless a list admits them', async () => {
    expect(await administered(person(ALICE), [TEAM, OTHER_TEAM])).toEqual(new Set([TEAM]));
    expect(await adminOf(person(ALICE), DEALS)).toBe(true);
    expect(await maySeeStatement(person(ALICE), DEALS)).toBe(true);
    expect(await maySeeStatement(person(ALICE), FINANCE)).toBe(true);
    expect(await accessTo(person(ALICE), { target: DEALS, verb: 'read' })).toBe(false);
    expect(await accessTo(person(ALICE), { target: FINANCE, verb: 'use' })).toBe(false);
    expect(await readableIds(person(ALICE), { thing: 'automation', teamIds: [TEAM] })).toEqual(new Set());
  });

  it('may change any list on the team, and once on it, reads the thing; the change is logged with who made it', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    expect(await mayChangeStatement(person(ALICE), DEALS)).toBe(true);
    await setStatement(person(ALICE), { target: DEALS, verb: 'read', grantees: [user(BOB), user(ALICE)] });
    expect(listOf(DEALS, 'read')).toEqual([user(BOB), user(ALICE)]);
    expect(await accessTo(person(ALICE), { target: DEALS, verb: 'read' })).toBe(true);
    expect(await accessTo(person(ALICE), { target: DEALS, verb: 'write' })).toBe(false);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('a team admin changed a list'),
      expect.objectContaining({ teamId: TEAM, actor: ALICE, thing: 'automation', thingId: DEALS.id, verb: 'read' }),
    );

    await setStatement(person(ALICE), { target: FINANCE, verb: 'use', grantees: [team] });
    expect(await accessTo(person(ALICE), { target: FINANCE, verb: 'use' })).toBe(true);
  });

  it('logs nothing of its own when a list already let them change it', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    stated(NOTES, 'write', [user(ALICE)]);
    await setStatement(person(ALICE), { target: NOTES, verb: 'read', grantees: [team] });
    expect(info).not.toHaveBeenCalled();
  });

  it('holds everything a write member does: a team grant on the write list admits them', async () => {
    stated(NOTES, 'write', [team]);
    expect(await accessTo(person(ALICE), { target: NOTES, verb: 'write' })).toBe(true);
    await setStatement(person(BOB), { target: DEALS, verb: 'write', grantees: [user(BOB), user(ALICE)] });
    expect(listOf(DEALS, 'write')).toEqual([user(BOB), user(ALICE)]);
  });

  it('is no power of a write or read member, nor of an admin on another team or through a read-only credential', async () => {
    member(OTHER_TEAM, BOB, 'admin');
    expect(await maySeeStatement(person(CAROL), DEALS)).toBe(false);
    expect(await mayChangeStatement(person(CAROL), DEALS)).toBe(false);
    stated(NOTES, 'read', [user(ALICE)]);
    stated(NOTES, 'write', [user(ALICE)]);
    expect(await maySeeStatement(person(BOB), NOTES)).toBe(false);
    expect(await mayChangeStatement(person(BOB), NOTES)).toBe(false);
    await expect(setStatement(person(BOB), { target: NOTES, verb: 'read', grantees: [team] })).rejects.toMatchObject({ refusal: 'not_allowed' });
    expect(await administered(person(BOB), [TEAM, OTHER_TEAM])).toEqual(new Set([OTHER_TEAM]));
    const readOnlyKey = person(ALICE, { access: 'read', pinnedTeamId: TEAM });
    expect(await administered(readOnlyKey, [TEAM])).toEqual(new Set());
    expect(await maySeeStatement(readOnlyKey, DEALS)).toBe(false);
    expect(await mayChangeStatement(readOnlyKey, DEALS)).toBe(false);
  });

  it('is never counted as one who sees a thing: "only you" stays about the lists alone', async () => {
    expect(await seenOnlyBy(person(BOB), { thing: 'automation', teamId: TEAM, ids: [DEALS.id] })).toEqual(new Set([DEALS.id]));
    expect(await seenOnlyBy(person(ALICE), { thing: 'automation', teamId: TEAM, ids: [DEALS.id] })).toEqual(new Set());
  });

  it('must still be on the write list of an automation they create, and the use list of a connection', async () => {
    await expect(
      checkCreation(person(ALICE), { teamId: TEAM, statements: { read: [user(BOB)], write: [user(BOB)] } }),
    ).rejects.toMatchObject({ refusal: 'not_allowed' });
    await expect(checkConnectionCreation(person(ALICE), { teamId: TEAM, use: [user(BOB)] })).rejects.toMatchObject({ refusal: 'not_allowed' });
    await expect(
      checkCreation(person(ALICE), { teamId: TEAM, statements: { read: [team], write: [user(ALICE)] } }),
    ).resolves.toBeUndefined();
  });

  it('cannot see or change what does not exist', async () => {
    const missing: Target<'automation'> = { thing: 'automation', id: 'd0000000-0000-4000-8000-00000000dead' };
    expect(await maySeeStatement(person(ALICE), missing)).toBe(false);
    expect(await mayChangeStatement(person(ALICE), missing)).toBe(false);
    expect(await adminOf(person(ALICE), missing)).toBe(false);
  });
});

describe('the shapes a list takes', () => {
  beforeEach(() => {
    member(TEAM, ALICE, 'write');
    stated(DEALS, 'write', [user(ALICE)]);
  });

  it('refuses a user who names nobody, naming the bad value', async () => {
    const refused = setStatement(person(ALICE), { target: DEALS, verb: 'read', grantees: [{ kind: 'user', userId: '  ' }] });
    await expect(refused).rejects.toMatchObject({ refusal: 'malformed' });
    await expect(refused).rejects.toThrow(JSON.stringify('  '));
    expect(listOf(DEALS, 'read')).toEqual([]);
  });

  it('stores a user id lowercased and a repeated entry once', async () => {
    await setStatement(person(ALICE), {
      target: DEALS,
      verb: 'read',
      grantees: [{ kind: 'user', userId: ` ${ALICE.toUpperCase()} ` }, user(ALICE), team],
    });
    expect(listOf(DEALS, 'read')).toEqual([user(ALICE), team]);
  });
});

describe('creating a connection with who may use it', () => {
  it('passes a write member who names themselves, or the team', async () => {
    member(TEAM, ALICE, 'write');
    await expect(checkConnectionCreation(person(ALICE), { teamId: TEAM, use: [user(ALICE)] })).resolves.toBeUndefined();
    await expect(checkConnectionCreation(person(ALICE), { teamId: TEAM, use: [team] })).resolves.toBeUndefined();
  });

  it('refuses a creator the use list leaves out, a read member and an empty list', async () => {
    member(TEAM, ALICE, 'write');
    member(TEAM, BOB, 'write');
    member(TEAM, CAROL, 'read');
    await expect(checkConnectionCreation(person(ALICE), { teamId: TEAM, use: [user(BOB)] })).rejects.toThrow(/could not use/);
    await expect(checkConnectionCreation(person(CAROL), { teamId: TEAM, use: [team] })).rejects.toMatchObject({ refusal: 'not_allowed' });
    await expect(checkConnectionCreation(person(ALICE), { teamId: TEAM, use: [] })).rejects.toMatchObject({ refusal: 'empty' });
  });
});

describe('stating a thing as it is created', () => {
  it('states each list in the order given, checked as any list is', async () => {
    member(TEAM, ALICE, 'write');
    await stateAtCreation(FINANCE, { teamId: TEAM, lists: [{ verb: 'use', grantees: [user(ALICE)] }] });
    expect(listOf(FINANCE, 'use')).toEqual([user(ALICE)]);
    await stateAtCreation(DEALS, {
      teamId: TEAM,
      lists: [
        { verb: 'write', grantees: [team] },
        { verb: 'read', grantees: [team] },
      ],
    });
    expect(listOf(DEALS, 'read')).toEqual([team]);
  });

  it('refuses a thing something is already stated about, and stores nothing of a list it refuses', async () => {
    stated(DEALS, 'write', [team]);
    await expect(stateAtCreation(DEALS, { teamId: TEAM, lists: [{ verb: 'read', grantees: [team] }] })).rejects.toMatchObject({
      refusal: 'already_stated',
    });
    await expect(
      stateAtCreation(NOTES, { teamId: TEAM, lists: [{ verb: 'write', grantees: [team] }, { verb: 'read', grantees: [user(BOB)] }] }),
    ).rejects.toMatchObject({ refusal: 'not_a_member' });
    expect(listOf(NOTES, 'write')).toEqual([]);
  });
});


describe('use on a library', () => {
  const SALES_LIB: Target<'automation'> = { thing: 'automation', id: 'd0000000-0000-4000-8000-000000000005' };

  beforeEach(() => {
    member(TEAM, ALICE, 'admin');
    member(TEAM, BOB, 'write');
    member(TEAM, CAROL, 'write');
    thing(LEDGER);
    thing(SALES_LIB);
    // The ledger names the finance connection and the sales library, and exports.
    mockTable.names.set(LEDGER.id, { connections: [FINANCE], libraries: [SALES_LIB] });
    mockTable.names.set(SALES_LIB.id, { connections: [], libraries: [] });
    stated(LEDGER, 'write', [user(BOB)]);
    stated(LEDGER, 'read', [team]);
    stated(LEDGER, 'use', [team]);
    stated(SALES_LIB, 'write', [user(BOB)]);
    stated(SALES_LIB, 'read', [team]);
    stated(SALES_LIB, 'use', [team]);
    stated(FINANCE, 'use', [user(BOB)]);
  });

  it('setting_a_library_use_list_needs_use_on_what_it_names: an admin without it is refused, and passes once they add themselves', async () => {
    await expect(setStatement(person(ALICE), { target: LEDGER, verb: 'use', grantees: [user(BOB)] })).rejects.toMatchObject({
      refusal: 'needs_use_on_names',
    });
    expect(listOf(LEDGER, 'use')).toEqual([team]);

    // The admin adds themselves to the connection's list, where its holders see it; the library is still named.
    mockTable.rows = mockTable.rows.filter((r) => !(r.target.id === SALES_LIB.id && r.verb === 'use'));
    stated(SALES_LIB, 'use', [user(BOB)]);
    await setStatement(person(ALICE), { target: FINANCE, verb: 'use', grantees: [user(BOB), user(ALICE)] });
    await expect(setStatement(person(ALICE), { target: LEDGER, verb: 'use', grantees: [user(BOB)] })).rejects.toMatchObject({
      refusal: 'needs_use_on_names',
    });
    await setStatement(person(ALICE), { target: SALES_LIB, verb: 'use', grantees: [user(ALICE)] });
    await setStatement(person(ALICE), { target: LEDGER, verb: 'use', grantees: [user(BOB)] });
    expect(listOf(LEDGER, 'use')).toEqual([user(BOB)]);
  });

  it('lets a writer who holds use on everything the library names change its use list', async () => {
    stated(SALES_LIB, 'use', [user(BOB)]);
    mockTable.rows = mockTable.rows.filter((r) => !(r.target.id === SALES_LIB.id && r.verb === 'use' && r.grantee.kind === 'team'));
    await setStatement(person(BOB), { target: LEDGER, verb: 'use', grantees: [team] });
    expect(listOf(LEDGER, 'use')).toEqual([team]);
  });

  it('names what is missing only to someone who may read the library', async () => {
    const unreadable = new Error('unset');
    stated(FINANCE, 'use', [user(CAROL)]);
    mockTable.rows = mockTable.rows.filter((r) => !(r.target.id === LEDGER.id && r.verb === 'read'));
    stated(LEDGER, 'read', [user(BOB)]);
    // Alice (admin) cannot read the library, and is told nothing of what it names.
    await expect(setStatement(person(ALICE), { target: LEDGER, verb: 'use', grantees: [team] })).rejects.not.toThrow(unreadable);
    await expect(setStatement(person(ALICE), { target: LEDGER, verb: 'use', grantees: [team] })).rejects.toMatchObject({
      refusal: 'needs_use_on_names',
      message: expect.not.stringContaining('name-of-'),
    });
    // Bob reads it, holds use on the connection, but not the sales library once its list drops him.
    mockTable.rows = mockTable.rows.filter((r) => !(r.target.id === SALES_LIB.id && r.verb === 'use'));
    stated(SALES_LIB, 'use', [user(CAROL)]);
    await expect(setStatement(person(BOB), { target: LEDGER, verb: 'use', grantees: [team] })).rejects.toMatchObject({
      refusal: 'needs_use_on_names',
      message: expect.stringContaining('name-of-5'),
    });
  });

  it('refuses a use list on a file that exports nothing', async () => {
    await expect(setStatement(person(BOB), { target: DEALS, verb: 'use', grantees: [team] })).rejects.toMatchObject({
      refusal: 'not_a_library',
    });
  });

  it('stands while one of its writers holds use on each connection it names, worked out when a list changes', async () => {
    await recomputeLibraryStanding(TEAM, [LEDGER.id]);
    expect(mockTable.standing.get(LEDGER.id)).toBeNull();

    // Bob, its only writer, loses the connection: the library stops standing, naming the connection.
    await setStatement(person(ALICE), { target: FINANCE, verb: 'use', grantees: [user(CAROL)] });
    expect(mockTable.standing.get(LEDGER.id)).toBe(FINANCE.id);

    // Another writer who holds it restores it.
    await setStatement(person(BOB), { target: LEDGER, verb: 'write', grantees: [user(BOB), user(CAROL)] });
    expect(mockTable.standing.get(LEDGER.id)).toBeNull();
  });

  it('is worked out again when a writer leaves the team', async () => {
    stated(LEDGER, 'write', [user(CAROL)]);
    stated(FINANCE, 'use', [user(CAROL)]);
    await recomputeLibraryStanding(TEAM);
    expect(mockTable.standing.get(LEDGER.id)).toBeNull();

    leaves(TEAM, CAROL);
    await passOnWhatTheyHeld({ teamId: TEAM, userId: CAROL, because: 'left' });
    // Bob still writes it but lost the connection long ago in this setup: only Carol held both.
    expect(mockTable.standing.get(LEDGER.id)).toBeNull();
  });

  it('a library with no writer that holds the connection does not stand after the last holder leaves', async () => {
    mockTable.rows = mockTable.rows.filter((r) => !(r.target.id === FINANCE.id));
    stated(FINANCE, 'use', [user(CAROL)]);
    stated(LEDGER, 'write', [user(BOB), user(CAROL)]);
    await recomputeLibraryStanding(TEAM);
    expect(mockTable.standing.get(LEDGER.id)).toBeNull();

    leaves(TEAM, CAROL);
    await passOnWhatTheyHeld({ teamId: TEAM, userId: CAROL, because: 'left' });
    expect(mockTable.standing.get(LEDGER.id)).toBe(FINANCE.id);
  });
});
