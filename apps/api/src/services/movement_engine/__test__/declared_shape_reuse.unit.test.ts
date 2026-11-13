// A node declaration reused as an extraction's shape, and a write body's
// spread, through the real engine: the prompt a declared node assembles must be
// the inline block's, and `...e` / `?...e` must write what the lines they stand
// for would.

// ── Jest module workarounds (mirrors run.unit.test.ts) ──────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('engine-contracts/expression/schemas');

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??=
  'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.SCRAPER_API_KEY ??= 'unit-test-unused';

function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      if (prop === 'executeTakeFirst') return async () => null;
      if (prop === 'then') return undefined;
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

jest.mock('../../context', () => ({
  unsafeCurrentContext: () => undefined,
  currentContext: () => ({
    user: undefined,
    runAsync: async <T>(fn: () => Promise<T>) => fn(),
  }),
}));

// The graph's manifest without its connection requirement, so these runs
// construct `kg()` bare (the platform's real one needs a credential).
jest.mock('@listen-fire/kg/manifest', () => ({
  KG_ADAPTER_TYPE: 'kg',
  kgManifest: () => ({
      adapterType: 'kg',
      displayName: 'Knowledge Graph',
      supportedTriggers: ['mutation'],
      methods: [
        'listEntryPoints', 'describe', 'resolveEntity', 'getDedupRules',
        'getFieldValue', 'getRelated', 'createRecord', 'updateRecord',
        'getPriorMatch', 'recordLink',
      ],
      triggerKinds: ['KG_MUTATION'],
    }),
}));

// The TG-side parity run drives the PRODUCTION batcher, whose LlmClient
// wraps `anthropicChat` — the per-test responder is installed on this mock.
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => '{}'),
  anthropicChatDetailed: jest.fn(async () => ({
    text: '{}',
    stopReason: 'end_turn',
    truncated: false,
  })),
  MAX_CHAT_CONTINUATIONS: 5,
}));

// A plugin that stored a document hands back the document's id; the invoker
// looks the stored object up. No database here — the lookup is answered from
// this table, which each test fills.
const storedDocuments = new Map<string, { id: string; description: string; objectUri: string }>();
jest.mock('../../document', () => ({
  DocumentService: {
    getById: jest.fn(async (id: string) => {
      const found = storedDocuments.get(id);
      if (!found) throw new Error(`Could not find document ${id}`);
      return found;
    }),
  },
}));

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { runMovement as runMovementUnder } from '../dispatch/dispatch';

// A declared node reused as the extraction keyword's shape: the keyword is
// versions 1–4 only (MOV_EXTRACT_KEYWORD_RETIRED from 5, where every shape is
// declared and an extraction is the call), so every run here is pinned to
// version 4 in the spelling 4 reads.
const runMovement = (input: Parameters<typeof runMovementUnder>[0]): ReturnType<typeof runMovementUnder> =>
  runMovementUnder({ languageVersion: '4', ...input });
import type {
  LlmCallInput,
  LlmCallResult,
} from '../../translation_graph/engine/batched_extraction';
import type { CapturedWrite } from 'movement-engine/public/adapter';
import type {
  Adapter,
  RuntimeCapabilities,
  ExternalRecordRef,
} from 'movement-engine/public/adapter';
import { containerAssociation } from 'movement-engine/public/adapter';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import { positionData } from 'engine-contracts/catalog';
import { tenantIdOf } from 'engine-contracts';
import { makeTestHost } from 'movement-engine/public/testing';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000010');

// ── Fake adapters (per run.unit.test.ts patterns) ───────────────────────────

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: true, edgeProperties: true },
    resources: true,
  };
}

interface RecordedWrite {
  recordType: string;
  externalId?: string;
  fields: Record<string, unknown>;
}

function makeFakeAdapter(
  adapterType: string,
  opts: {
    resolveCandidates?: (record: Record<string, unknown>) => ExternalRecordRef[];
    createResult?: (n: number) => { externalId: string; url?: string };
  } = {},
): { adapter: Adapter; creates: RecordedWrite[]; updates: RecordedWrite[] } {
  const creates: RecordedWrite[] = [];
  const updates: RecordedWrite[] = [];
  const adapter: Adapter = {
    adapterType,
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity({ record }) {
      return { candidates: opts.resolveCandidates?.(record) ?? [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      const result = opts.createResult?.(creates.length + 1) ?? {
        externalId: `ext-${adapterType}-${creates.length + 1}`,
      };
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType, externalId: result.externalId, url: result.url, data: {} };
    },
    async updateRecord(input) {
      updates.push({
        recordType: input.recordType,
        externalId: input.externalId,
        fields: input.fields,
      });
      return { adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates, updates };
}

function makeResolver(byType: Record<string, Adapter>) {
  return ({ adapterType }: { adapterType: string }) => {
    const adapter = byType[adapterType];
    if (!adapter) throw new Error(`test: no fake adapter for '${adapterType}'`);
    return adapter;
  };
}

function webhookEvent(adapterType: string, payload: Record<string, unknown>): TriggerEvent {
  return {
    pipelineInputId: 'pi-movement-extraction',
    adapterType,
    triggerType: 'webhook',
    payload,
  };
}

/** A movement-engine LlmClient that records calls and answers from a
 *  queue of hand-written nested responses. */
function queuedMovementLlm(responses: unknown[]): {
  calls: LlmCallInput[];
  client: { call(input: LlmCallInput): Promise<LlmCallResult> };
} {
  const calls: LlmCallInput[] = [];
  return {
    calls,
    client: {
      async call(input: LlmCallInput): Promise<LlmCallResult> {
        calls.push(input);
        if (calls.length > responses.length) {
          throw new Error(`test: unexpected extraction call #${calls.length}:\n${input.system}`);
        }
        return { parsedJson: responses[calls.length - 1] };
      },
    },
  };
}

const wrap = (value: unknown) => ({ evidence: 'q', value });

// ── The movements under test ────────────────────────────────────────────────

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};
const attioSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', stage: 'text', thesis: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: {
      fields: { name: 'text', stage: 'text', thesis: 'text' },
      resultShape: { externalId: 'text', name: 'text', stage: 'text', thesis: 'text' },
    },
  },
};

const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: attioSchema },
  },
  credentials: {
    dealflow_inbox: { adapters: ['email'] },
    acme_main: { adapters: ['attio'] },
  },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'type Thesis = <"Consumer" | "Infra">',
  'rules = "route infra to Infra"',
].join('\n');

const ENTRY = [
  'node Entry: "each company pitched in this message" {',
  '  name: <text> "the company\'s name"',
  '  stage: <text> "the funding stage"',
  '  thesis: <Thesis> "the thesis it routes to. ${rules}"',
  '  node founder: "each founder named" { first: <text> "given names" }',
  '}',
].join('\n');

/** The same tree, spelled out inline — what `node entry: <Entry>` stands for. */
const INLINE_ENTRY = [
  '    node entry: "each company pitched in this message" {',
  '      name: <text> "the company\'s name"',
  '      stage: <text> "the funding stage"',
  '      thesis: <Thesis> "the thesis it routes to. ${rules}"',
  '      node founder: "each founder named" { first: <text> "given names" }',
  '    }',
];

function movement(declarations: string, tree: string[], after: string[] = []): string {
  return [
    PRELUDE,
    declarations,
    'movement m(msg: <inbox-[:message]->>) {',
    '  found = extract from [msg.`text`] {',
    ...tree,
    '  }',
    ...after,
    '}',
  ].join('\n');
}

const REPLY = {
  'x:extract_result#1': [
    {
      entry: [
        {
          name: wrap('Acme'),
          stage: wrap('Seed'),
          thesis: wrap('Infra'),
          founder: [{ first: wrap('Ada') }],
        },
      ],
    },
  ],
};

async function run(
  source: string,
  {
    attio = makeFakeAdapter('attio'),
    movementName,
    reply = REPLY,
  }: { attio?: ReturnType<typeof makeFakeAdapter>; movementName?: string; reply?: unknown } = {},
) {
  const llm = queuedMovementLlm([reply]);
  const writes: CapturedWrite[] = [];
  await runMovement({
    source,
    event: webhookEvent('email', { subject: 'Deals', text: 'Acme (Ada) is raising a Seed.' }),
    teamId: TEAM_ID,
    catalog,
    host: makeTestHost({
      writeSink: (w) => writes.push(w),
      adapters: {
        resolve: makeResolver({ email: makeFakeAdapter('email').adapter, attio: attio.adapter }),
      },
      llm: { client: llm.client },
    }),
    ...(movementName !== undefined ? { movementName } : {}),
    dryRun: true,
  });
  return { calls: llm.calls, writes };
}

// ═════════════════════════════════════════════════════════════════════════════

describe('an extraction node that takes a declaration as its shape', () => {
});

describe('presence on a declared shape — exactly as on the inline block', () => {
  /** The model found the name, and neither the stage (text) nor the thesis
   *  (a refinement). */
  const SPARSE = {
    'x:extract_result#1': [{ entry: [{ name: wrap('Acme'), stage: null, thesis: null, founder: [] }] }],
  };
  const both = async (after: string[]) => {
    const declared = await run(movement(ENTRY, ['    node entry: <Entry>'], after), { reply: SPARSE });
    const inline = await run(movement('', INLINE_ENTRY, after), { reply: SPARSE });
    expect(declared.writes).toEqual(inline.writes);
    return declared.writes;
  };

});

describe('a guard on a typed field of a declared shape', () => {
});

describe('a spread in a write body', () => {
  const spreading = (body: string) =>
    movement(ENTRY, ['    node entry: <Entry>'], [
      '  found-[e:entry]-> {',
      `    write crm-[:companies]-> { ${body} }`,
      '  }',
    ]);

});

describe('an IMPORTED declaration', () => {
  /** Runs `node entry: <Entry>` imported from a library that declares it
   *  (and its refinement) as `library`; the importer adds `importerLines`. */
  async function extractImported(library: string, importerLines: string[] = []) {
    const source = [
      PRELUDE,
      'import { Entry } from "lib/entries"',
      ...importerLines,
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extract from [msg.`text`] {',
      '    node entry: <Entry>',
      '  }',
      '}',
    ].join('\n');
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ entry: [] }] }]);
    await runMovement({
      source,
      event: webhookEvent('email', { subject: 'Deals', text: 'Acme is raising.' }),
      teamId: TEAM_ID,
      catalog: { ...catalog, files: { 'lib/entries': { source: library } } },
      host: makeTestHost({
        adapters: {
          resolve: makeResolver({
            email: makeFakeAdapter('email').adapter,
            attio: makeFakeAdapter('attio').adapter,
          }),
        },
        llm: { client: llm.client },
      }),
      dryRun: true,
    });
    return llm.calls[0].system;
  }

});

describe('a spread of a declared structure, or of a record built in memory', () => {
  const DEAL = ['node Deal {', '  name:  <text>', '  stage: <text>', '}'].join('\n');
  const RECORD_DEAL = ['function record_deal(d: <Deal>) {', '  write crm-[:companies]-> { ...d }', '}'];

});

describe('`<text | null>` — a text nobody found arrives null', () => {
  const NULLABLE_ENTRY = ENTRY.replace('stage: <text> "the funding stage"', 'stage: <text | null> "the funding stage"');
  const NULLABLE_INLINE = INLINE_ENTRY.map((line) =>
    line.replace('stage: <text> "the funding stage"', 'stage: <text | null> "the funding stage"'),
  );
  /** Neither the name (`<text>`) nor the stage (`<text | null>`) was found. */
  const BLANK = {
    'x:extract_result#1': [{ entry: [{ name: null, stage: null, thesis: wrap('Infra'), founder: [] }] }],
  };
  /** The stage is null, the name "", in the same record; a found stage is its text. */
  const AFTER = [
    '  found-[e:entry]-> {',
    '    write crm-[:companies]-> { name: e.name, thesis ?: e.thesis, stage ?: e.stage }',
    '    if e.stage == null { write crm-[:companies]-> { name: "no stage", thesis: e.name } }',
    '  }',
  ];

});

describe('`node X extends Y` as an extraction shape', () => {
  /** Entry, with one field the first prompt must not see. */
  const RECAP = [
    ENTRY,
    'node `Recap Entry` extends Entry {',
    '  diverse_founder: <text | null> "whether a founder is from an under-represented group"',
    '}',
  ].join('\n');
  /** The same tree as one declaration — what `extends` stands for. */
  const RECAP_FLAT = [
    'node `Recap Entry`: "each company pitched in this message" {',
    '  name: <text> "the company\'s name"',
    '  stage: <text> "the funding stage"',
    '  thesis: <Thesis> "the thesis it routes to. ${rules}"',
    '  node founder: "each founder named" { first: <text> "given names" }',
    '  diverse_founder: <text | null> "whether a founder is from an under-represented group"',
    '}',
  ].join('\n');

  /** `node entry: <Recap>`, with `library` at lib/entries and the importer's
   *  own declarations. */
  async function extractFrom(library: string, importerLines: string[]) {
    const source = [
      PRELUDE,
      ...importerLines,
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extract from [msg.`text`] {',
      '    node entry: <Recap>',
      '  }',
      '}',
    ].join('\n');
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ entry: [] }] }]);
    await runMovement({
      source,
      event: webhookEvent('email', { subject: 'Deals', text: 'Acme is raising.' }),
      teamId: TEAM_ID,
      catalog: { ...catalog, files: { 'lib/entries': { source: library } } },
      host: makeTestHost({
        adapters: {
          resolve: makeResolver({
            email: makeFakeAdapter('email').adapter,
            attio: makeFakeAdapter('attio').adapter,
          }),
        },
        llm: { client: llm.client },
      }),
      dryRun: true,
    });
    return llm.calls[0].system;
  }

  const LIBRARY = [
    'lens = "the library\'s lens"',
    'type Verdict = <"Keep" | "Drop">',
    'export node Entry: "each company, by ${lens}" {',
    '  name: <text> "the name, by ${lens}"',
    '  verdict: <Verdict> "whether to keep it"',
    '}',
  ].join('\n');

});

// ── The write spreads, under version 5 ──────────────────────────────────────
//
// Everything above extracts with the keyword, so it runs under 4. From 5 the
// same records come from the call over the same declaration, and a write
// body spreads them exactly as it did.

const PRELUDE_V5 = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  '',
  'inbox = connect email using dealflow_inbox',
  'crm   = connect attio using acme_main',
  'type Thesis = <"Consumer" | "Infra">',
  'rules = "route infra to Infra"',
].join('\n');

/** The one record the message describes: its entries, each the tree
 *  `declarations`' Entry spells out. */
const pitchOf = (declarations: string): string =>
  ['node Pitch: "the companies pitched in this message" {', declarations.replace('node Entry:', 'node entry:'), '}'].join('\n');

/** extractOne's envelope: the one record, its entries beneath it. */
const RECORD_REPLY = {
  record: {
    entry: [{ name: wrap('Acme'), stage: wrap('Seed'), thesis: wrap('Infra'), founder: [{ first: wrap('Ada') }] }],
  },
};

function movementV5(declarations: string, after: string[]): string {
  return [
    PRELUDE_V5,
    declarations,
    pitchOf(declarations),
    'function m(msg: <inbox-[:message]->>) {',
    '  found = extractOne([msg.`text`], Pitch)',
    '  if (found == null) { fail("nothing extracted") }',
    ...after,
    '}',
  ].join('\n');
}

async function runV5(
  source: string,
  { attio = makeFakeAdapter('attio'), reply = RECORD_REPLY }: { attio?: ReturnType<typeof makeFakeAdapter>; reply?: unknown } = {},
) {
  const writes: CapturedWrite[] = [];
  await runMovementUnder({
    source,
    event: webhookEvent('email', { subject: 'Deals', text: 'Acme (Ada) is raising a Seed.' }),
    teamId: TEAM_ID,
    catalog,
    host: makeTestHost({
      writeSink: (w) => writes.push(w),
      adapters: {
        resolve: makeResolver({ email: makeFakeAdapter('email').adapter, attio: attio.adapter }),
      },
      llm: {
        extractCall: {
          call: async () => ({ parsedJson: reply, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }),
        },
      },
    }),
    dryRun: true,
  });
  return { writes };
}

describe('a spread in a write body, of a record extractOne handed back (version 5)', () => {
  const spreading = (body: string) =>
    movementV5(ENTRY, ['  found-[e:entry]-> {', `    write crm-[:companies]-> { ${body} }`, '  }']);

  it('`...e` is refused where a field it writes may be absent, naming `?...e`', async () => {
    await expect(runV5(spreading('unique by (name), ...e'))).rejects.toThrow(/MOV_ABSENT_REQUIRED.*'thesis'.*\?\.\.\.e/);
  });

  it('`?...e` writes every FIELD of the record — never its nested nodes', async () => {
    const { writes } = await runV5(spreading('unique by (name), ?...e'));
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Acme', stage: 'Seed', thesis: 'Infra' } }),
    ]);
  });

  it('an explicit line wins over the spread for its field', async () => {
    const { writes } = await runV5(spreading('stage: "Series A", ?...e'));
    expect(writes).toEqual([
      expect.objectContaining({ fields: { stage: 'Series A', name: 'Acme', thesis: 'Infra' } }),
    ]);
  });

  it('`?...e` is set-if-empty: a matched record keeps the values it has', async () => {
    const attio = makeFakeAdapter('attio', {
      resolveCandidates: () => [{ adapterType: 'attio', externalId: 'existing-1', data: {} }],
    });
    attio.adapter.readRecord = async () => ({ name: 'Acme', stage: 'Series B', thesis: null });
    const { writes } = await runV5(spreading('unique by (name), ?...e'), { attio });
    // `stage` is already set, so the fill leaves it; `thesis` is empty and fills.
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'update', externalId: 'existing-1', fields: { thesis: 'Infra' } }),
    ]);
  });

  it('writes every field of a `node { … }` literal built from it, and none of its edges', async () => {
    const source = movementV5(ENTRY, [
      '  found-[e:entry]-> {',
      '    n = node { name: e.name, stage: "Seed", founder: node { name: "Ada" } }',
      '    write crm-[:companies]-> { ...n }',
      '  }',
    ]);
    const { writes } = await runV5(source);
    expect(writes).toEqual([expect.objectContaining({ kind: 'create', fields: { name: 'Acme', stage: 'Seed' } })]);
  });

  it("a collecting node's entry merged by `?...e` holds an unfound one absent, so `!= null` is a real test", async () => {
    const nullable = ENTRY.replace('stage: <text> "the funding stage"', 'stage: <text | null> "the funding stage"');
    const source = movementV5(nullable, [
      '  deduped = node { entries: <Entry> order by arrival }',
      '  found-[e:entry]-> { write deduped-[:entries]-> { unique by (name), ?...e } }',
      '  deduped-[x:entries]-> {',
      '    if (x.stage != null) {',
      '      write crm-[:companies]-> { name: x.name, stage: x.stage }',
      '    } else {',
      '      write crm-[:companies]-> { name: x.name, thesis: "no stage" }',
      '    }',
      '  }',
    ]);
    const unfound = { record: { entry: [{ name: wrap('Acme'), stage: null, thesis: wrap('Infra'), founder: [] }] } };
    expect((await runV5(source, { reply: unfound })).writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Acme', thesis: 'no stage' } }),
    ]);
    expect((await runV5(source)).writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Acme', stage: 'Seed' } }),
    ]);
  });
});
