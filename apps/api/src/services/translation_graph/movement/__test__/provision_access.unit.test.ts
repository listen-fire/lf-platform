// The save rule: a person's save is decided before any of its text is stored.
// Same seams as run_save.unit.test.ts (kysely as in-memory tables, the team
// catalog as a fixture), with the access statements in memory beside them and
// the REAL decision (`services/access/decide.ts`), the REAL saveMovement and
// the REAL save rule (`../save_access.ts`).
//
//   - saving over an automation, by id or by name, needs write on it; one the
//     saver may not see answers as nothing there (by id) or as a taken name;
//   - creating one needs its read and write statements, stated with it;
//   - every connection the file and its imports name needs use, and a refused
//     save stores nothing, so it cannot re-provision a hidden connection's
//     listens;
//   - a run's save (an upgrade, a script) is not decided;
//   - what the statements reach is warned about, never refused.

// Order-sensitive cycle guard (mirrors save.unit.test.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('engine-contracts/expression/schemas');

import type { Access, Principal } from 'principal';
import type { Grantee, Target, Verb } from '../../../access/statement';

type StatementRow = { teamId: string; target: Target; verb: Verb; grantee: Grantee };

const mockAccess: {
  members: Map<string, Access>;
  connections: Map<string, string>;
  rows: StatementRow[];
  /** Whether the save's own transaction is open. */
  inTransaction: boolean;
  /** Each statement written, and whether it was written inside that transaction. */
  stated: { verb: Verb; inTransaction: boolean }[];
} = { members: new Map(), connections: new Map(), rows: [], inTransaction: false, stated: [] };

/** Something happening to the movements table after a save's checks and before its write: runs once. */
const mockRace: { beforeWrite?: () => void } = {};

jest.mock('../../../../lib/kysely', () => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {
    movement: [],
    trigger: [],
    translation_graph: [],
    team: [],
    movement_version: [],
    // Retiring a listener settles the runs parked on its triggers
    // (`settleRunsParkedOnTriggers`), so the delete path reads both of these.
    parked_run: [],
    trigger_run: [],
  };
  const matches = (row: Row, wheres: Array<[string, string, unknown]>) =>
    wheres.every(([col, op, val]) =>
      op === '='
        ? row[col] === val
        : op === 'in'
          ? Array.isArray(val) && (val as unknown[]).includes(row[col])
          : false,
    );
  function builder(table: string, mode: 'select' | 'insert' | 'update' | 'delete') {
    const wheres: Array<[string, string, unknown]> = [];
    let patch: Row = {};
    let values: Row = {};
    let order: { col: string; dir: string } | undefined;
    const rows = () => tables[table].filter((r) => matches(r, wheres));
    const execute = async (): Promise<Row[]> => {
      if (table === 'movement' && (mode === 'insert' || mode === 'update') && mockRace.beforeWrite !== undefined) {
        const race = mockRace.beforeWrite;
        delete mockRace.beforeWrite;
        race();
      }
      if (mode === 'insert') {
        // The database's own `movement_team_name_unique`.
        if (table === 'movement' && tables.movement.some((r) => r.team_id === values.team_id && r.name === values.name)) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "movement_team_name_unique"'), { code: '23505' });
        }
        tables[table].push({ created_at: new Date(), updated_at: new Date(), ...values });
        return [];
      }
      if (mode === 'update') {
        for (const row of rows()) Object.assign(row, patch);
        return [];
      }
      if (mode === 'delete') {
        tables[table] = tables[table].filter((r) => !matches(r, wheres));
        return [];
      }
      const out = rows().slice();
      if (order) {
        const { col, dir } = order;
        out.sort((a, b) => {
          const av = a[col] as never;
          const bv = b[col] as never;
          return (av < bv ? -1 : av > bv ? 1 : 0) * (dir === 'desc' ? -1 : 1);
        });
      }
      return out;
    };
    const api = {
      where: (col: string, op: string, val: unknown) => {
        wheres.push([col, op, val]);
        return api;
      },
      select: () => api,
      innerJoin: () => api,
      distinct: () => api,
      selectAll: () => api,
      orderBy: (col: string, dir?: string) => {
        order = { col, dir: dir ?? 'asc' };
        return api;
      },
      set: (p: Row) => {
        patch = p;
        return api;
      },
      values: (v: Row) => {
        values = v;
        return api;
      },
      execute,
      executeTakeFirst: async () => (await execute())[0],
    };
    return api;
  }
  return {
    getQb: () => ({
      selectFrom: (t: string) => builder(t, 'select'),
      insertInto: (t: string) => builder(t, 'insert'),
      updateTable: (t: string) => builder(t, 'update'),
      deleteFrom: (t: string) => builder(t, 'delete'),
    }),
    getCoreQb: () => ({
      selectFrom: (t: string) => builder(t, 'select'),
      insertInto: (t: string) => builder(t, 'insert'),
      updateTable: (t: string) => builder(t, 'update'),
      deleteFrom: (t: string) => builder(t, 'delete'),
    }),
    getKnowledgeQb: () => ({
      selectFrom: (t: string) => builder(t, 'select'),
      insertInto: (t: string) => builder(t, 'insert'),
      updateTable: (t: string) => builder(t, 'update'),
      deleteFrom: (t: string) => builder(t, 'delete'),
    }),
    getAutomationsQb: () => ({
      selectFrom: (t: string) => builder(t, 'select'),
      insertInto: (t: string) => builder(t, 'insert'),
      updateTable: (t: string) => builder(t, 'update'),
      deleteFrom: (t: string) => builder(t, 'delete'),
    }),
    __tables: tables,
    __reset: () => {
      for (const key of Object.keys(tables)) tables[key] = [];
    },
  };
});

jest.mock('../../../access/statement', () => {
  const actual = jest.requireActual('../../../access/statement');
  const same = (a: Target, b: Target) => a.thing === b.thing && a.id === b.id;
  const { __tables } = jest.requireMock('../../../../lib/kysely');
  return {
    ...actual,
    StatementStore: {
      teamOf: async (target: Target) =>
        target.thing === 'automation'
          ? (__tables.movement.find((row: { id: string }) => row.id === target.id)?.team_id as string | undefined)
          : mockAccess.connections.get(target.id),
      grantsOf: async (target: Target, options: { teamId: string; verb: Verb }) =>
        mockAccess.rows
          .filter((r) => r.teamId === options.teamId && same(r.target, target) && r.verb === options.verb)
          .map((r) => r.grantee),
      replaceGrants: async (target: Target, options: { teamId: string; verb: Verb; grantees: Grantee[] }) => {
        mockAccess.stated.push({ verb: options.verb, inTransaction: mockAccess.inTransaction });
        mockAccess.rows = [
          ...mockAccess.rows.filter((r) => !(same(r.target, target) && r.verb === options.verb)),
          ...options.grantees.map((grantee) => ({ teamId: options.teamId, target, verb: options.verb, grantee })),
        ];
      },
      hasAnyStatement: async (target: Target) => mockAccess.rows.some((r) => same(r.target, target)),
      membershipsOf: async (userId: string, teamIds: string[]) =>
        new Map(
          teamIds.flatMap((teamId) => {
            const access = teamId === mockTeam ? mockAccess.members.get(userId) : undefined;
            return access === undefined ? [] : [[teamId, access] as const];
          }),
        ),
      membershipsAmong: async (_teamId: string, userIds: string[]) =>
        new Map(
          userIds.flatMap((userId) => {
            const access = mockAccess.members.get(userId);
            return access === undefined ? [] : [[userId, access] as const];
          }),
        ),
      membersOf: async () => new Map(mockAccess.members),
    },
  };
});

const mockTeam = '11111111-1111-4111-8111-111111111111';

// The ledger module says nothing of who acted; email and manual do.
const mockManifests = [
  { adapterType: 'ledger', requiredCredentialType: 'LEDGER', methods: ['listEntryPoints', 'describe'] },
  { adapterType: 'email', methods: ['listEntryPoints', 'describe', 'getActorCandidates', 'extractActor'] },
  { adapterType: 'manual', methods: ['listEntryPoints', 'describe', 'getActorCandidates', 'extractActor'] },
];

jest.mock('../../adapters/team_manifests', () => ({ teamAdapterManifests: jest.fn(async () => mockManifests) }));
jest.mock('../../adapters/remote/store', () => ({ getRemoteAdapter: jest.fn(async () => null) }));

jest.mock('../catalog', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockCatalog, mockCatalogSnapshot } = require('movement-lang');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { referencedConstructions } = require('legacy-lang');
  const { unitInstanceSchema } = jest.requireActual('../../adapters/unit_surface');
  const { MANUAL_ADAPTER_TYPE, MANUAL_SURFACE } = jest.requireActual('../../adapters/manual');
  const spec = {
    adapters: {
      email: {
        constructionArgs: [{ name: 'credentials', kind: 'position', required: false }],
        schema: {
          positions: { message: { properties: { subject: 'text', Key: 'text' }, edges: {} } },
          collections: { messages: { target: 'message' }, Emails: { target: 'message', readable: false, listenable: true } },
          writableRoots: { message: { fields: { subject: 'text' }, resultShape: { externalId: 'text', subject: 'text' } } },
        },
      },
      ledger: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        schema: {
          positions: { Entry: { properties: { Amount: 'number' }, edges: {} } },
          collections: { Entries: { target: 'Entry', readable: false, listenable: true } },
          writableRoots: {},
        },
      },
      manual: { constructionArgs: [], schema: unitInstanceSchema(MANUAL_ADAPTER_TYPE, MANUAL_SURFACE) },
    },
    credentials: { Finance: { adapter: 'ledger' }, Sales: { adapter: 'ledger' } },
  };
  const ids: Record<string, string> = { Finance: 'c0000000-0000-4000-8000-000000000001', Sales: 'c0000000-0000-4000-8000-000000000002' };
  return {
    movementCatalogForTeam: jest.fn(async () => ({
      catalog: mockCatalog(spec),
      resolveCredentialId: (name: string) => ids[name],
      credentialsByName: {},
      translation: {},
      runSnapshot: () => mockCatalogSnapshot(spec),
      notes: [],
      gaps: [],
    })),
    constructionsOf: (source: string) => referencedConstructions(source),
    loadCredentialRows: jest.fn(async () => [
      { id: ids.Finance, name: 'Finance', type: 'LEDGER' },
      { id: ids.Sales, name: 'Sales', type: 'LEDGER' },
    ]),
  };
});

jest.mock('../../adapters/registry', () => {
  const actual = jest.requireActual('../../adapters/registry');
  const routingKey = (slug: string) =>
    slug === 'email' ? { kind: 'slug', key: 'key', prefix: 'inbox+', suffix: '@example.com', routingKey: true } : null;
  return {
    adapterInboundRoutingKey: routingKey,
    inboundAddressFor: (slug: string, config: Record<string, unknown>) => {
      const field = routingKey(slug);
      const value = field ? config[field.key] : undefined;
      return typeof value === 'string' && value.length > 0 ? `${field!.prefix}${value}${field!.suffix}` : null;
    },
    getAdapterManifest: () => null,
    isPollSource: () => false,
    hasAdapter: (slug: string) => slug !== 'acme_crm',
    resolveAdapterSlug: (slug: string) => slug,
    indexManifestsByName: actual.indexManifestsByName,
  };
});


jest.mock('../save_access', () => {
  const actual = jest.requireActual('../save_access');
  return {
    ...actual,
    inOneTransaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      mockAccess.inTransaction = true;
      try {
        return await fn();
      } finally {
        mockAccess.inTransaction = false;
      }
    },
  };
});

jest.mock('../../../work/store', () => ({ enqueueWork: jest.fn(async () => undefined) }));
jest.mock('../../../inbound/listen_pause', () => ({
  ...jest.requireActual('../../../inbound/listen_pause'),
  listenPauses: jest.fn(async () => new Map()),
  loopBreakerPauses: jest.fn(async () => new Map()),
}));
jest.mock('../listen_subscriptions', () => ({ syncListenSubscriptions: jest.fn(async () => ({ notes: [] })) }));
jest.mock('../../storage/tg_table', () => ({ saveTriggerEntriesForTrigger: jest.fn(async () => undefined) }));

import { getRemoteAdapter } from '../../adapters/remote/store';
import { saveMovement, type SaveMovementInput } from '../provision';
import { STATEMENTS_ON_OVERWRITE_REFUSAL, accessWarnings } from '../save_access';

const db = jest.requireMock('../../../../lib/kysely') as {
  __tables: Record<string, Array<Record<string, unknown>>>;
  __reset: () => void;
};

const TEAM = mockTeam;
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAROL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FINANCE = 'c0000000-0000-4000-8000-000000000001';
const SALES = 'c0000000-0000-4000-8000-000000000002';
const MISSING = 'd0000000-0000-4000-8000-00000000dead';

const alice: Principal = { teamId: TEAM, userId: ALICE, access: 'write', scopes: ['*'], pinnedTeamId: null };
const carol: Principal = { teamId: TEAM, userId: CAROL, access: 'read', scopes: ['*'], pinnedTeamId: null };

const user = (userId: string): Grantee => ({ kind: 'user', userId });
const team: Grantee = { kind: 'team' };

/** The team may read it, and Alice may write it. */
const STATEMENTS = { read: [team], write: [user(ALICE)] };

const onLedger = (connection: string, name = 'deals') =>
  [
    'import { ledger } from adapters',
    `import { ${connection} } from credentials`,
    '',
    `books = connect ledger using ${connection}`,
    '',
    `function ${name}(e: <books-[:Entries]->>) {`,
    '  # process',
    '}',
    '',
    `listen to books-[:Entries]-> fire ${name}`,
  ].join('\n');

const manualOnly = (name: string) =>
  [
    'import { email } from adapters',
    '',
    'inbox = connect email',
    '',
    `function ${name}(go: <manual-[:Invocation]->>) {`,
    '  write inbox-[:messages]-> { subject: "hi" }',
    '}',
    '',
    `listen to manual-[:Invocations]-> fire ${name}`,
  ].join('\n');

const LIBRARY = [
  'import { ledger } from adapters',
  'import { Finance } from credentials',
  '',
  'books = connect ledger using Finance',
  '',
  'export function tally(t: <text>) {',
  '  return t',
  '}',
].join('\n');

const importsLibrary = (name: string) => `import { tally } from "helpers"\n${manualOnly(name)}`;

function stated(target: Target, verb: Verb, grantees: Grantee[]): void {
  mockAccess.rows.push(...grantees.map((grantee) => ({ teamId: TEAM, target, verb, grantee })));
}

const automation = (id: string): Target<'automation'> => ({ thing: 'automation', id });

function listOf(id: string, verb: Verb): Grantee[] {
  return mockAccess.rows.filter((r) => r.target.id === id && r.verb === verb).map((r) => r.grantee);
}

/** A save as Alice, whose answer is what a person is told. */
const asAlice = (input: Omit<SaveMovementInput, 'teamId' | 'audience'>) => saveMovement({ teamId: TEAM, audience: { for: alice }, ...input });

/** An automation saved as a run would save it, with these statements, as it stands before Alice's save. */
async function existing(
  source: string,
  statements: Partial<Record<'read' | 'write', Grantee[]>>,
  name?: string,
): Promise<string> {
  const saved = await saveMovement({ teamId: TEAM, audience: { for: 'run' }, source, acknowledgeErrors: true, ...(name !== undefined ? { name } : {}) });
  if (saved.movementId === undefined) throw new Error('the fixture did not save');
  // Only these statements: not the team's, which a run's creation states.
  const { movementId } = saved;
  mockAccess.rows = mockAccess.rows.filter((r) => r.target.id !== movementId);
  mockAccess.stated = [];
  for (const verb of ['read', 'write'] as const) {
    const grantees = statements[verb];
    if (grantees !== undefined) stated(automation(saved.movementId), verb, grantees);
  }
  return saved.movementId;
}

/** What is stored, to check a refused save stored nothing. */
function stored() {
  return {
    movements: db.__tables.movement.map((row) => ({ id: row.id, name: row.name, source: row.source })),
    triggers: db.__tables.trigger.map((row) => ({ id: row.id, credentials_id: row.credentials_id })),
    statements: mockAccess.rows.length,
  };
}

beforeEach(() => {
  db.__reset();
  db.__tables.team.push({ id: TEAM });
  mockAccess.members = new Map([
    [ALICE, 'write'],
    [BOB, 'write'],
    [CAROL, 'read'],
  ]);
  mockAccess.connections = new Map([
    [FINANCE, TEAM],
    [SALES, TEAM],
  ]);
  mockAccess.rows = [];
  mockAccess.stated = [];
  delete mockRace.beforeWrite;
  // Only Bob may use Finance; the team may use Sales.
  stated({ thing: 'connection', id: FINANCE }, 'use', [user(BOB)]);
  stated({ thing: 'connection', id: SALES }, 'use', [team]);
});

describe('saving over an automation needs write on it', () => {
  it('by id: a writer saves; a reader is refused as read only; anyone else is told it is not there', async () => {
    const deals = await existing(manualOnly('deals'), { read: [user(ALICE)], write: [user(BOB)] });
    const before = stored();

    const readOnly = await asAlice({ id: deals, source: manualOnly('deals2') });
    expect(readOnly).toMatchObject({ ok: false, refused: { kind: 'read_only' }, errors: ['You may read this automation but not change it.'] });
    expect(stored()).toEqual(before);

    mockAccess.rows = mockAccess.rows.filter((r) => r.target.id !== deals);
    stated(automation(deals), 'write', [user(BOB)]);
    const hidden = stored();
    // The guards that hand back the stored text never run for someone who may not see it.
    const unseen = await asAlice({ id: deals, source: manualOnly('deals2'), expectedRevision: 'stale', baseUpdatedAt: new Date(0).toISOString() });
    const missing = await asAlice({ id: MISSING, source: manualOnly('deals2'), expectedRevision: 'stale', baseUpdatedAt: new Date(0).toISOString() });
    expect(JSON.stringify(unseen)).toBe(JSON.stringify(missing).split(MISSING).join(deals));
    expect(JSON.stringify(unseen)).not.toContain('Invocations');
    expect(stored()).toEqual(hidden);

    stated(automation(deals), 'write', [user(ALICE)]);
    const written = await asAlice({ id: deals, source: manualOnly('deals2') });
    expect(written).toMatchObject({ ok: true, movementId: deals });
    expect(db.__tables.movement.find((row) => row.id === deals)?.source).toBe(manualOnly('deals2'));
  });

  it('by name: a writer overwrites it, never creating a second; a reader is refused; anyone else is told the name is taken', async () => {
    const deals = await existing(manualOnly('deals'), { read: [user(ALICE)], write: [user(BOB)] });
    const before = stored();

    expect(await asAlice({ name: 'deals', source: manualOnly('deals') })).toMatchObject({ ok: false, refused: { kind: 'read_only' } });
    expect(stored()).toEqual(before);

    mockAccess.rows = mockAccess.rows.filter((r) => r.target.id !== deals);
    stated(automation(deals), 'write', [user(BOB)]);
    const hidden = stored();
    // Statements given, so a create would pass: a name taken by what she may not see is still refused.
    const taken = await asAlice({ name: 'deals', source: manualOnly('deals'), statements: STATEMENTS });
    expect(taken).toEqual({
      ok: false,
      errors: ['The name "deals" is taken. Save under another name.'],
      catalogNotes: [],
      refused: { kind: 'name_taken', name: 'deals' },
    });
    expect(stored()).toEqual(hidden);

    stated(automation(deals), 'write', [user(ALICE)]);
    const overwritten = await asAlice({ source: manualOnly('deals') });
    expect(overwritten).toMatchObject({ ok: true, movementId: deals });
    expect(db.__tables.movement).toHaveLength(1);
  });
});

describe('a save that means to create', () => {
  it('is refused a held name as taken, whatever the saver may do to its holder, and overwrites nothing', async () => {
    const deals = await existing(manualOnly('deals'), { read: [user(ALICE)], write: [user(ALICE)] });
    // The test restates the holder's lists between asks, so what must not change is the rows, not the statement count.
    const { movements, triggers } = stored();
    const taken = {
      ok: false,
      errors: ['The name "deals" is taken. Save under another name.'],
      catalogNotes: [],
      refused: { kind: 'name_taken', name: 'deals' },
    };

    // She may write it: without the intent this would overwrite, and with statements be told of setAccess.
    expect(await asAlice({ intent: 'create', name: 'deals', source: manualOnly('deals'), statements: STATEMENTS })).toEqual(taken);

    mockAccess.rows = mockAccess.rows.filter((r) => r.target.id !== deals);
    stated(automation(deals), 'read', [user(ALICE)]);
    stated(automation(deals), 'write', [user(BOB)]);
    expect(await asAlice({ intent: 'create', name: 'deals', source: manualOnly('deals'), statements: STATEMENTS })).toEqual(taken);

    mockAccess.rows = mockAccess.rows.filter((r) => r.target.id !== deals);
    stated(automation(deals), 'write', [user(BOB)]);
    expect(await asAlice({ intent: 'create', name: 'deals', source: manualOnly('deals'), statements: STATEMENTS })).toEqual(taken);
    expect(stored()).toMatchObject({ movements, triggers });
  });

  it('creates when the name is free', async () => {
    const created = await asAlice({ intent: 'create', source: manualOnly('fresh'), statements: STATEMENTS });
    expect(created).toMatchObject({ ok: true });
    expect(db.__tables.movement).toHaveLength(1);
  });
});

describe('creating an automation needs who may read and write it', () => {
  it('is refused without both, naming what is missing, and stores nothing', async () => {
    const before = stored();
    expect(await asAlice({ source: manualOnly('fresh') })).toMatchObject({
      ok: false,
      refused: { kind: 'missing_statement', missing: ['read', 'write'] },
    });
    expect(await asAlice({ source: manualOnly('fresh'), statements: { write: [user(ALICE)] } })).toMatchObject({
      ok: false,
      refused: { kind: 'missing_statement', missing: ['read'] },
      errors: [expect.stringContaining('who may read it')],
    });
    expect(stored()).toEqual(before);
  });

  it('states write first, then read, with the insert in one transaction', async () => {
    const created = await asAlice({ source: manualOnly('fresh'), statements: STATEMENTS });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(mockAccess.stated).toEqual([
      { verb: 'write', inTransaction: true },
      { verb: 'read', inTransaction: true },
    ]);
    expect(listOf(created.movementId, 'write')).toEqual([user(ALICE)]);
    expect(listOf(created.movementId, 'read')).toEqual([team]);
    expect(db.__tables.movement[0]).toMatchObject({ created_by_user_id: null });
  });

  it('records who created it when the caller says', async () => {
    const created = await asAlice({ source: manualOnly('fresh'), statements: STATEMENTS, userId: ALICE });
    expect(created.ok).toBe(true);
    expect(db.__tables.movement[0]).toMatchObject({ created_by_user_id: ALICE });
  });

  it('refuses statements it could not store, before storing anything', async () => {
    const before = stored();
    // Nobody creates what they could not change.
    const notHers = await asAlice({ source: manualOnly('fresh'), statements: { ...STATEMENTS, write: [user(BOB)] } });
    expect(notHers).toMatchObject({ ok: false, refused: { kind: 'statement', reason: 'not_allowed' }, errors: [expect.stringContaining('write list')] });
    // Only people on the team can be named.
    const stranger = await asAlice({ source: manualOnly('fresh'), statements: { ...STATEMENTS, read: [user(MISSING)] } });
    expect(stranger).toMatchObject({ ok: false, refused: { kind: 'statement', reason: 'not_a_member' } });
    // A read member creates nothing.
    const reader = await saveMovement({ teamId: TEAM, audience: { for: carol }, source: manualOnly('fresh'), statements: STATEMENTS });
    expect(reader).toMatchObject({ ok: false, refused: { kind: 'statement', reason: 'not_allowed' } });
    expect(stored()).toEqual(before);
  });

  it('is not decided for a run, and gives what a run creates the team to read and write, with the insert', async () => {
    const saved = await saveMovement({ teamId: TEAM, audience: { for: 'run' }, source: manualOnly('fresh') });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(mockAccess.stated).toEqual([
      { verb: 'write', inTransaction: true },
      { verb: 'read', inTransaction: true },
    ]);
    expect(listOf(saved.movementId, 'write')).toEqual([team]);
    expect(listOf(saved.movementId, 'read')).toEqual([team]);
  });

  it('states the two a run gives it, over the defaults', async () => {
    const carol = user(CAROL);
    const saved = await saveMovement({
      teamId: TEAM,
      audience: { for: 'run' },
      source: manualOnly('given'),
      statements: { read: [carol], write: [team] },
    });
    if (!saved.ok) throw new Error('not saved');
    expect(listOf(saved.movementId, 'read')).toEqual([carol]);
    expect(listOf(saved.movementId, 'write')).toEqual([team]);
  });

  it.each([
    ['read', { read: [team] }, 'write'],
    ['write', { write: [team] }, 'read'],
  ])('refuses a run given only %s of the two, as a mistake, stating nothing for the defaults', async (_, given, missing) => {
    await expect(
      saveMovement({ teamId: TEAM, audience: { for: 'run' }, source: manualOnly('partial'), statements: given }),
    ).rejects.toThrow(`only some of the statements: ${missing} missing`);
    // The two the fixture's connections began with: none for the automation.
    expect(stored().statements).toBe(2);
  });
});

describe('every connection the file and its imports name needs use', () => {
  it('refuses a file naming a connection the saver may not use, naming it and the file, and stores nothing', async () => {
    const before = stored();
    const refused = await asAlice({ source: onLedger('Finance'), statements: STATEMENTS, acknowledgeErrors: true });
    expect(refused).toMatchObject({
      ok: false,
      refused: { kind: 'connections', connections: [{ connection: 'Finance', file: 'deals' }] },
      errors: [expect.stringContaining('"Finance" (named in "deals")')],
    });
    expect(stored()).toEqual(before);
  });

  // A construction runs where it is written, a closure's body included, so the
  // rule reads every body the file holds.
  it.each([
    ['inside a closure body', ['  later = () => {', '    books = connect ledger using Finance', '  }']],
    ['inside an await arm', ['  first = await race([() => { books = connect ledger using Finance }, () => { }])']],
  ])('refuses a file naming a connection the saver may not use %s', async (_, body) => {
    const source = [
      'import { ledger } from adapters',
      'import { Finance } from credentials',
      '',
      'function deals(go: <manual-[:Invocation]->>) {',
      ...body,
      '}',
      '',
      'listen to manual-[:Invocations]-> fire deals',
    ].join('\n');
    const before = stored();
    const refused = await asAlice({ source, statements: STATEMENTS, acknowledgeErrors: true });
    expect(refused).toMatchObject({ ok: false, refused: { kind: 'connections', connections: [{ connection: 'Finance', file: 'deals' }] } });
    expect(stored()).toEqual(before);
  });

  it('answers a connection that does not exist exactly as one the saver may not use', async () => {
    const hidden = await asAlice({ source: onLedger('Finance'), statements: STATEMENTS, acknowledgeErrors: true });
    const nowhere = await asAlice({ source: onLedger('Nowhere'), statements: STATEMENTS, acknowledgeErrors: true });
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(nowhere).split('Nowhere').join('Finance'));
  });

  it('refuses a file whose import names one, naming the connection and the imported file when the saver can read it', async () => {
    await existing(LIBRARY, { read: [user(ALICE)] }, 'helpers');
    const refused = await asAlice({ source: importsLibrary('deals'), statements: STATEMENTS, acknowledgeErrors: true });
    expect(refused).toMatchObject({
      ok: false,
      refused: { kind: 'connections', connections: [{ connection: 'Finance', file: 'helpers' }], unreadableFiles: [] },
      errors: [expect.stringContaining('"Finance" (named in "helpers")')],
    });
  });

  it('names only the imported file, never its connection, when the saver may not read that file', async () => {
    await existing(LIBRARY, { read: [user(BOB)] }, 'helpers');
    const before = stored();
    const refused = await asAlice({ source: importsLibrary('deals'), statements: STATEMENTS, acknowledgeErrors: true });
    expect(refused).toEqual({
      ok: false,
      errors: ['A file this imports names a connection you may not use: helpers. A save may name only connections you may use.'],
      catalogNotes: [],
      refused: { kind: 'connections', connections: [], unreadableFiles: ['helpers'] },
    });
    expect(JSON.stringify(refused)).not.toContain('Finance');
    expect(stored()).toEqual(before);
  });

  it("asks for use on a remote module's own connection when a construction names none", async () => {
    jest.mocked(getRemoteAdapter).mockResolvedValue({ credentials_id: FINANCE } as never);
    const source = ['import { acme_crm } from adapters', '', 'crm = connect acme_crm', '', manualOnly('deals')].join('\n');
    const refused = await asAlice({ source, statements: STATEMENTS, acknowledgeErrors: true });
    jest.mocked(getRemoteAdapter).mockResolvedValue(null);
    expect(refused).toMatchObject({ ok: false, refused: { kind: 'connections', connections: [{ connection: "acme_crm's own connection", file: 'deals' }] } });
  });

  it('saves a file naming only connections the saver may use', async () => {
    const saved = await asAlice({ source: onLedger('Sales'), statements: STATEMENTS });
    expect(saved).toMatchObject({ ok: true });
  });

  it("never re-provisions a hidden connection's listens: a consented save by a writer without use on it is refused", async () => {
    const deals = await existing(onLedger('Finance'), { read: [user(ALICE)], write: [user(ALICE)] });
    expect(db.__tables.trigger.map((row) => row.credentials_id)).toEqual([FINANCE]);
    const before = stored();

    // Invalid text that still names Finance, saved anyway.
    const broken = `${onLedger('Finance')}\nlisten to books-[:Nonsense]-> fire deals\n`;
    const refused = await asAlice({ id: deals, source: broken, acknowledgeErrors: true });

    expect(refused).toMatchObject({ ok: false, refused: { kind: 'connections' } });
    expect(stored()).toEqual(before);
  });
});

describe('statements apply only when creating', () => {
  it('refuses a save that overwrites, by id or by name, telling the author to use setAccess, and stores nothing', async () => {
    const deals = await existing(manualOnly('deals'), { read: [user(ALICE)], write: [user(ALICE)] });
    const before = stored();
    const refusal = {
      ok: false,
      errors: [STATEMENTS_ON_OVERWRITE_REFUSAL],
      catalogNotes: [],
      refused: { kind: 'statement', reason: 'on_overwrite', message: STATEMENTS_ON_OVERWRITE_REFUSAL },
    };
    expect(STATEMENTS_ON_OVERWRITE_REFUSAL).toMatch(/only when creating.*setAccess/);

    expect(await asAlice({ id: deals, source: manualOnly('deals'), statements: STATEMENTS })).toEqual(refusal);
    expect(await asAlice({ source: manualOnly('deals'), statements: STATEMENTS })).toEqual(refusal);
    expect(stored()).toEqual(before);
    expect(await asAlice({ id: deals, source: manualOnly('deals') })).toMatchObject({ ok: true, movementId: deals });
  });

  it('is told a reader\'s refusal first, so the statements show nothing of what she may not change', async () => {
    const deals = await existing(manualOnly('deals'), { read: [user(ALICE)], write: [user(BOB)] });
    expect(await asAlice({ id: deals, source: manualOnly('deals'), statements: STATEMENTS })).toMatchObject({ refused: { kind: 'read_only' } });
  });
});

describe('what the checks decided is what the write does', () => {
  it('never recreates a row deleted after the name was checked, by name or by id', async () => {
    const deals = await existing(manualOnly('deals'), { read: [user(ALICE)], write: [user(ALICE)] });
    const gone = () => {
      db.__tables.movement = db.__tables.movement.filter((row) => row.id !== deals);
    };

    mockRace.beforeWrite = gone;
    const byName = await asAlice({ source: manualOnly('deals') });
    expect(byName).toMatchObject({ ok: false, refused: { kind: 'name_gone', name: 'deals' } });
    expect(db.__tables.movement).toEqual([]);
    expect(mockAccess.stated).toEqual([]);

    const again = await existing(manualOnly('deals'), { read: [user(ALICE)], write: [user(ALICE)] });
    mockRace.beforeWrite = () => {
      db.__tables.movement = db.__tables.movement.filter((row) => row.id !== again);
    };
    const byId = await asAlice({ id: again, source: manualOnly('deals') });
    expect(byId).toEqual({ ok: false, errors: [`movement ${again} not found`], catalogNotes: [] });
    expect(db.__tables.movement).toEqual([]);
  });

  it('answers a name taken after the check as taken, and overwrites nothing and states nothing', async () => {
    // Another creator, or a run's save, lands first.
    mockRace.beforeWrite = () => {
      db.__tables.movement.push({ id: 'rival', team_id: TEAM, name: 'fresh', source: 'the rival text', created_at: new Date(), updated_at: new Date() });
    };
    const result = await asAlice({ source: manualOnly('fresh'), statements: STATEMENTS });

    expect(result).toEqual({
      ok: false,
      errors: ['The name "fresh" is taken. Save under another name.'],
      catalogNotes: [],
      refused: { kind: 'name_taken', name: 'fresh' },
    });
    expect(db.__tables.movement.map((row) => ({ id: row.id, source: row.source }))).toEqual([{ id: 'rival', source: 'the rival text' }]);
    expect(mockAccess.stated).toEqual([]);
  });
});

describe('what a save warns about, never refusing', () => {
  it('warns when its readers are wider than a connection’s users', async () => {
    // Bob and Carol may read it; only Alice may use Sales.
    mockAccess.rows = mockAccess.rows.filter((r) => r.target.id !== SALES);
    stated({ thing: 'connection', id: SALES }, 'use', [user(ALICE)]);
    const saved = await asAlice({ source: onLedger('Sales'), statements: STATEMENTS });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.warnings).toContain(
      'Some who may read this automation may not use the connection "Sales": its runs show them what it reads through that connection.',
    );
  });

  it('does not warn when everyone who may read it may use its connections', async () => {
    const saved = await asAlice({ source: onLedger('Sales'), statements: { ...STATEMENTS, read: [team] } });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.warnings.filter((w) => w.includes('connection "Sales"'))).toEqual([]);
  });
});
