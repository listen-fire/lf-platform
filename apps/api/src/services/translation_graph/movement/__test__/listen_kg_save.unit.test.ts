// A graph listen's reconciliation: a listen on a node type's `Changes`
// provisions one kg trigger row carrying the listen's plan, keeps its identity
// across saves, and retires it when the listen goes.
//
// REAL: saveMovement/provision. Mocked: the DB (in-memory tables), the
// catalog assembly, the adapter registry manifests, adapter resolution, and
// the subscription sync (a subscription per listenable edge is
// listen_subscriptions.integration's subject).

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('engine-contracts/expression/schemas');

jest.mock('../../../../lib/kysely', () => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {
    movement: [],
    trigger: [],
    translation_graph: [],
    team: [],
    webhook_subscription: [],
    // The subscription sync reads the team's engine (none here: the platform).
    team_engine: [],
    movement_version: [],
    // Retiring a listener settles the runs parked on it
    // (`settleRunsParkedOnTriggers`), so the retire path reads both of these.
    parked_run: [],
    trigger_run: [],
  };
  const matches = (row: Row, wheres: Array<[string, string, unknown]>) =>
    wheres.every(([col, op, val]) => {
      if (op === '=') return row[col] === val;
      if (op === 'in') return Array.isArray(val) && (val as unknown[]).includes(row[col]);
      if (op === 'is') return (row[col] ?? null) === val;
      if (op === 'is not') return (row[col] ?? null) !== val;
      return false;
    });
  function builder(table: string, mode: 'select' | 'insert' | 'update' | 'delete') {
    const wheres: Array<[string, string, unknown]> = [];
    let patch: Row = {};
    let values: Row = {};
    const rows = () => tables[table].filter((r) => matches(r, wheres));
    const execute = async (): Promise<Row[]> => {
      if (mode === 'insert') {
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
      return rows().slice();
    };
    const api = {
      where: (col: string, op: string, val: unknown) => {
        wheres.push([col, op, val]);
        return api;
      },
      select: () => api,
      selectAll: () => api,
      orderBy: () => api,
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


jest.mock('../../adapters/registry', () => {
  const manifests = [
    {
      adapterType: 'attio',
      displayName: 'Attio',
      supportedTriggers: ['snapshot', 'webhook'],
      methods: ['createRecord', 'ensureEventSubscription', 'removeEventSubscription'],
      requiredCredentialType: 'ATTIO',
      triggerKinds: ['ATTIO'],
      subscribableEvents: ['record.created', 'record.updated', 'record.deleted'],
    },
    {
      adapterType: 'email',
      displayName: 'Email',
      supportedTriggers: ['webhook'],
      methods: [],
      triggerConfig: [
        { kind: 'slug', key: 'key', prefix: 'inbox+', suffix: '@example.com', routingKey: true },
      ],
      triggerKinds: ['CUSTOM_EMAIL'],
    },
    {
      adapterType: 'kg',
      displayName: 'Knowledge Graph',
      supportedTriggers: ['mutation'],
      methods: ['createRecord'],
      triggerKinds: ['KG_MUTATION'],
      subscribableEvents: ['record.created', 'record.updated', 'record.deleted'],
      // The watched type is an ordinary address hop (D40) — the same
      // declaration Airtable's `base`/`table` make.
      listenConfig: [
        { key: 'type', required: true, narrows: { collection: 'Node Type', matchField: 'Id' } },
        { key: 'fields', format: 'fields' },
      ],
    },
  ];
  const aliasToSlug: Record<string, string> = {
    ATTIO: 'attio',
    CUSTOM_EMAIL: 'email',
    KG_MUTATION: 'kg',
  };
  const getManifest = (slug: string) =>
    manifests.find((m) => m.adapterType === (aliasToSlug[slug] ?? slug)) ?? null;
  return {
    listAdapterManifests: () => manifests,
    isPollSource: () => false,
    getAdapterManifest: getManifest,
    resolveAdapterSlug: (kind: string) => aliasToSlug[kind] ?? kind,
    hasAdapter: (kind: string) => manifests.some((m) => m.adapterType === (aliasToSlug[kind] ?? kind)),
    adapterInboundRoutingKey: (slug: string) =>
      (getManifest(slug)?.triggerConfig ?? []).find(
        (f: { routingKey?: boolean }) => f.routingKey === true,
      ) ?? null,
    inboundAddressFor: (slug: string, config: Record<string, unknown>) => {
      const field = (getManifest(slug)?.triggerConfig ?? []).find(
        (f: { routingKey?: boolean }) => f.routingKey === true,
      ) as { key: string; prefix?: string; suffix?: string } | undefined;
      const value = field ? config[field.key] : undefined;
      return typeof value === 'string' && value.length > 0
        ? `${field?.prefix ?? ''}${value}${field?.suffix ?? ''}`
        : null;
    },
  };
});

// Adapter resolution: a fake whose subscription methods record their calls.
const ensureCalls: Array<{
  adapterType: string;
  credentialsId?: string;
  events: string[];
  callbackUrl: string;
  current?: { externalId?: string; events: string[] };
}> = [];
const removeCalls: Array<{ adapterType: string; callbackUrl: string; externalId?: string }> = [];

// The graph adapter's introspection — the SAME `listEntryPoints()` /
// `describe(typeId)` pair every adapter's resolver is built from. The
// framework identity IS the node type's NAME; the store's own id rides
// `externalId`.
const KG_ENTRIES = [
  {
    typeId: 'company',
    displayName: 'company',
    externalId: 'nt-company',
    writable: true,
    readable: true,
  },
];
const KG_DESCRIBE: Record<string, unknown> = {
  company: {
    typeId: 'company',
    displayName: 'company',
    fields: [
      { fieldId: 'pt-name', displayName: 'name', kind: 'string', writable: true, required: false },
      {
        fieldId: 'pt-domains',
        displayName: 'domains',
        kind: 'string',
        cardinality: 'many',
        writable: true,
        required: false,
      },
    ],
    references: [],
  },
};

jest.mock('../../adapters/resolve', () => ({
  resolveAdapter: jest.fn(
    async ({ adapterType, credentialsId }: { adapterType: string; credentialsId?: string }) => ({
      adapterType,
      // Introspection — only the KG adapter publishes a non-empty surface in
      // this suite (its display→UUID mapping drives the kg-listen config
      // translation); other adapters never reach the introspection path here.
      listEntryPoints: async () =>
        adapterType === 'kg' ? KG_ENTRIES : [],
      describe: async (typeId: string) =>
        adapterType === 'kg' ? (KG_DESCRIBE[typeId] ?? null) : null,
      // The root hop publishes the `Node Type` MEMBERS a listen's `type:` pin
      // selects between — the same walk Airtable's bases ride, so the address
      // resolves through `resolveListenAddress` with nothing kg-shaped in the
      // host.
      ...(adapterType === 'kg'
        ? {
            edgesFrom: async () => ({
              descriptor: {
                typeId: '__meta__',
                displayName: 'Knowledge Graph',
                fields: [],
                references: [],
              },
              targetPositions: Object.fromEntries(
                KG_ENTRIES.map((e) => [
                  `Node Type::${e.typeId}`,
                  {
                    adapterType: 'kg',
                    recordType: 'Node Type',
                    identity: {
                      kind: 'stable',
                      recordId: e.typeId,
                      data: { Id: e.typeId, Name: e.displayName },
                    },
                  },
                ]),
              ),
            }),
          }
        : {}),
      ensureEventSubscription: async (input: {
        events: string[];
        callbackUrl: string;
        current?: { externalId?: string; events: string[] };
      }) => {
        ensureCalls.push({ adapterType, credentialsId, ...input });
        return input.current?.externalId !== undefined
          ? { externalId: input.current.externalId }
          : { externalId: `wh-${ensureCalls.length}`, secret: `secret-${ensureCalls.length}` };
      },
      removeEventSubscription: async (input: { callbackUrl: string; externalId?: string }) => {
        removeCalls.push({ adapterType, ...input });
      },
    }),
  ),
}));

// A new listener asks for the poll reconcile, and a listen paused by the loop
// breaker is that suite's subject: neither is this one's.
jest.mock('../listen_subscriptions', () => ({
  syncListenSubscriptions: jest.fn(async () => ({ notes: [] })),
}));
jest.mock('../../../work/store', () => ({ enqueueWork: jest.fn(async () => {}) }));
jest.mock('../../../inbound/listen_pause', () => ({ listenPauses: jest.fn(async () => new Map()) }));

jest.mock('../../storage/tg_table', () => ({
  saveTriggerEntriesForTrigger: jest.fn(async () => undefined),
}));

// The catalog: kg schema, an events-capable attio, an email. The KG's
// display→UUID resolution no longer rides on the catalog — it's derived at
// the engine boundary from the KG adapter's OWN introspection (the
// resolveAdapter mock below publishes it).
jest.mock('../catalog', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockCatalog, mockCatalogSnapshot } = require('movement-lang');
  // A company's changes arrive on its `Changes` (ruling 9).
  const kgSchema = {
    positions: {
      company: {
        properties: { name: 'text', domains: { kind: 'list', of: 'text' } },
        edges: { Changes: { target: 'company Change', readable: false, listenable: true } },
      },
      'company Change': { properties: { Kind: 'text' }, edges: {} },
    },
    collections: { company: { target: 'company' } },
    writableRoots: {},
  };
  const spec = {
    adapters: {
      kg: { constructionArgs: [], schema: kgSchema },
    },
  };
  return {
    // The address resolver reads an instance's entry-position args off the
    // catalog; nothing here declares any, so it is the identity.
    positionArgValues: () => ({}),
    movementCatalogForTeam: jest.fn(async () => ({
      catalog: mockCatalog(spec),
      // The same world as the run sees it: a current pin is checked against it.
      runSnapshot: () => mockCatalogSnapshot(spec),
      resolveCredentialId: (name: string) =>
        undefined,
      credentialsByName: {},
      resolveFile: () => undefined,
      notes: [],
      gaps: [],
    })),
  };
});

import { saveMovement } from '../provision';

const db = jest.requireMock('../../../../lib/kysely') as {
  __tables: Record<string, Array<Record<string, unknown>>>;
  __reset: () => void;
};

const TEAM = 'team-1';

const KG_SOURCE = `import { kg } from adapters

graph = connect kg

function on_company_change(change: <graph-[:\`company Change\`]->>) {
  x = change.Kind
}

listen to graph-[:company]->-[c:Changes WHERE c.Kind == "updated"]-> fire on_company_change
`;

const KG_SOURCE_V2 = KG_SOURCE.replace('x = change.Kind', 'y = change.Kind');
const KG_LIBRARY = `import { kg } from adapters

graph = connect kg

function on_company_change(change: <graph-[:\`company Change\`]->>) {
  x = change.Kind
}
`;

beforeEach(() => {
  db.__reset();
  db.__tables.team.push({ id: TEAM });
  ensureCalls.length = 0;
  removeCalls.length = 0;
});

describe('a graph listen — trigger derivation', () => {
  it("derives a kg trigger row carrying the listen's plan", async () => {
    const result = await saveMovement({ teamId: TEAM, source: KG_SOURCE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.validity.status).toBe('valid');
    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0]).toMatchObject({
      kind: 'kg',
      credentialsId: null,
      inboundAddress: null,
      movementName: 'on_company_change',
    });

    const [trigger] = db.__tables.trigger;
    expect(trigger).toMatchObject({
      kind: 'kg',
      name: 'movement/on_company_change/on_company_change',
      config: { listen: expect.objectContaining({ pipeline: expect.stringMatching(/^listen:on_company_change:on_company_change:[0-9a-f]{8}$/) }) },
      run_mode: 'live',
    });
    expect(trigger.movement_id).toBe(db.__tables.movement[0].id);

  });

  it('an unchanged kg listen keeps its trigger id across saves (run history preserved)', async () => {
    const first = await saveMovement({ teamId: TEAM, source: KG_SOURCE });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const id = first.listeners[0].triggerId;

    const second = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: KG_SOURCE_V2,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.listeners[0].triggerId).toBe(id);
    expect(second.listeners[0].reused).toBe(true);
    expect(db.__tables.trigger).toHaveLength(1);
  });

  it('removing the kg listen retires its trigger row', async () => {
    const first = await saveMovement({ teamId: TEAM, source: KG_SOURCE });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: KG_LIBRARY,
    });
    expect(second.ok).toBe(true);
    expect(db.__tables.trigger).toHaveLength(0);
  });
});
