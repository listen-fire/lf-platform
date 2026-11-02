// A listen's config is an ADDRESS plus filters, and nothing in it belongs to
// one adapter. Three surfaces, all declared:
//
//   - a `narrows` hop (`type: "company"`, `folder: "inbox"`) — a quoted value
//     that pins one leg of the event address;
//   - `events: [...]` — the subscribable kinds, from `triggerConfigOptions`;
//   - a `'fields'`-format key (`fields: [domains]`, `watch: [size]`) — BARE
//     property names of whatever the address lands on.
//
// The knowledge graph used to own a private version of all three (`type:
// <company>`, `changes: [...]`, `fields: [...]`, checked by a kg-only branch
// against an ambient schema). It is an ordinary adapter now (D25), so its
// listen rides the general mechanism and this suite tests the mechanism.
//
// TWO DIFFERENTLY-SHAPED ADAPTERS throughout: a fixture matching one adapter's
// shape cannot tell derived behaviour from hardcoded behaviour. `kg` pins a
// `type` and files its filter under `fields`; `vault` pins a `folder`, files
// its filter under `watch`, and subscribes to a `file.*` vocabulary. Wherever
// a diagnostic quotes a key, a value, or a property, both shapes are asserted.
//
// A 0.13 catalog no longer says which keys, hop values, kinds or names a
// listen takes (catalog snapshot version 3), so the checker validates none of
// them: what stays here is what still holds.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import {
  mockCatalog,
  type SchemaFieldType,
  type InstanceSchema,
  type PositionSchema,
} from '../catalog';
import { spelledFor } from './surface_spelling';
import { eventAddressDisplay, eventAddressKey, narrowingPrefixKey } from '../event_address';

/** The event surface an adapter with ONE address hop publishes: the wide event
 *  node, the per-(hop, action) positions the host grafts on demand, and a
 *  union at each hop value. Built through `eventAddressKey`/`Display` exactly
 *  as the host builds it, so these tests assert the checker AGREES on the key
 *  rather than asserting their own arithmetic. */
function eventSurface(input: {
  event: string;
  actions: string[];
  hop: string;
  /** hop value → the properties the address lands on. */
  landings: Record<string, Record<string, SchemaFieldType>>;
}): InstanceSchema {
  const { event, actions, hop, landings } = input;
  const action: SchemaFieldType = { kind: 'enum', options: actions };
  const positions: Record<string, PositionSchema> = {
    [event]: { properties: { action, [hop]: 'text' }, edges: {} },
  };
  const unions: Record<string, string[]> = {};
  const unionDisplayNames: Record<string, string> = {};
  for (const [value, properties] of Object.entries(landings)) {
    const variants: string[] = [];
    for (const kind of actions) {
      const narrowing = { [hop]: value, action: kind };
      const key = eventAddressKey({ event, narrowing });
      variants.push(key);
      positions[key] = {
        properties: { action, [hop]: 'text', ...properties },
        edges: {},
        displayName: eventAddressDisplay({ event, narrowing }),
      };
    }
    const unionKey = eventAddressKey({ event, narrowing: { [hop]: value } });
    unions[unionKey] = variants;
    unionDisplayNames[unionKey] = eventAddressDisplay({
      event,
      narrowing: { [hop]: value },
    });
  }
  return {
    positions,
    collections: {},
    unions,
    unionDisplayNames,
    writableRoots: {},
    eventPosition: event,
    eventPositions: [{ position: event }],
    eventNarrowingKeys: [hop],
    eventNarrowingValues: {
      [narrowingPrefixKey({})]: { [hop]: Object.keys(landings) },
    },
  };
}

const textList: SchemaFieldType = { kind: 'list', of: 'text' };

const KG_ACTIONS = ['record.created', 'record.updated', 'record.deleted'];
const KG_SCHEMA = eventSurface({
  event: 'Record Change',
  actions: KG_ACTIONS,
  hop: 'type',
  landings: {
    company: { name: 'text', domains: textList },
    person: { name: 'text', email: 'text' },
  },
});

const VAULT_ACTIONS = ['file.added', 'file.removed'];
const VAULT_SCHEMA = eventSurface({
  event: 'Change',
  actions: VAULT_ACTIONS,
  hop: 'folder',
  landings: {
    inbox: { title: 'text', size: 'number' },
    archive: { title: 'text' },
  },
});

const catalog = mockCatalog({
  adapters: {
    kg: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['type', 'events', 'fields'],
      triggerConfigRequired: ['type'],
      triggerConfigOptions: { events: KG_ACTIONS },
      triggerConfigFormats: { fields: 'fields' },
      schema: KG_SCHEMA,
    },
    vault: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['folder', 'events', 'watch'],
      triggerConfigRequired: ['folder'],
      triggerConfigOptions: { events: VAULT_ACTIONS },
      triggerConfigFormats: { watch: 'fields' },
      schema: VAULT_SCHEMA,
    },
  },
  credentials: {
    native_knowledge: { adapter: 'kg' },
    vault_main: { adapter: 'vault' },
  },
});

const checkAll = (source: string): Diagnostic[] => checkProgram(parseProgram(spelledFor(5, source, catalog)), catalog);
const check = (source: string): Diagnostic[] =>
  checkAll(source).filter(d => (d.severity ?? 'error') === 'error');
const codes = (source: string): string[] => check(source).map(d => d.code);
const messageOf = (source: string, code: string): string | undefined =>
  check(source).find(d => d.code === code)?.message;

function expectClean(source: string): void {
  expect(check(source).map(d => `${d.code}: ${d.message}`)).toEqual([]);
}

const PRELUDE = [
  'import { kg, vault } from adapters',
  'import { native_knowledge, vault_main } from credentials',
  '',
  'graph = kg(credentials: native_knowledge)',
  'files = vault(credentials: vault_main)',
].join('\n');

/** The signature names the FULL address, both shapes. */
const KG_COMPANY =
  '<graph-[:`Record Change` WHERE `action` == "record.created" AND `type` == "company"]->>';
const VAULT_INBOX =
  '<files-[:`Change` WHERE `action` == "file.added" AND `folder` == "inbox"]->>';

/** One movement over one address, plus the listens that fire it. Each shape
 *  reads a property of its OWN landing, so a wrong address shows up as a read
 *  error rather than as silence. */
const kgProgram = (listens: string[], param = KG_COMPANY) =>
  [
    PRELUDE,
    `movement on_company_change(rec: ${param}) {`,
    '  ERROR("${rec.`name`}")',
    '}',
    ...listens.map(config => `listen to graph ${config} fire on_company_change`),
  ].join('\n');

const vaultProgram = (listens: string[], param = VAULT_INBOX) =>
  [
    PRELUDE,
    `movement on_file(f: ${param}) {`,
    '  ERROR("${f.`title`}")',
    '}',
    ...listens.map(config => `listen to files ${config} fire on_file`),
  ].join('\n');

// ── The address hop ──

describe('a narrows hop is an ordinary quoted config value', () => {
  it('the full form checks clean — hop, events, and the fields filter', () => {
    expectClean(kgProgram(['{ type: "company", events: ["record.created"], fields: [domains] }']));
    expectClean(vaultProgram(['{ folder: "inbox", events: ["file.added"], watch: [size] }']));
  });

  // The graph's `type: <company>` was the last angle-bracketed listen config in
  // the language. The fix-it now runs the other way.
  it('an angle-bracketed hop value is MOV_LISTEN_BAD_CONFIG with the quoted fix-it', () => {
    const kgMessage = messageOf(kgProgram(['{ type: <company> }']), C.LISTEN_BAD_CONFIG);
    expect(kgMessage).toContain('is a type reference');
    expect(kgMessage).toContain('type: "company"');

    const vaultMessage = messageOf(vaultProgram(['{ folder: <inbox> }']), C.LISTEN_BAD_CONFIG);
    expect(vaultMessage).toContain('folder: "inbox"');
  });

  it('two listens on different hop values are not duplicates; two on the same one are', () => {
    const distinct = [
      PRELUDE,
      `movement on_company_change(rec: ${KG_COMPANY}) {`,
      '  ERROR("${rec.`name`}")',
      '}',
      `movement on_person_change(rec: <graph-[:\`Record Change\` WHERE \`action\` == "record.created" AND \`type\` == "person"]->>) {`,
      '  ERROR("${rec.`email`}")',
      '}',
      'listen to graph { type: "company", events: ["record.created"] } fire on_company_change',
      'listen to graph { type: "person", events: ["record.created"] } fire on_person_change',
    ].join('\n');
    expectClean(distinct);

    expect(
      codes(
        kgProgram([
          '{ type: "company", events: ["record.created"] }',
          '{ type: "company", events: ["record.created"] }',
        ]),
      ),
    ).toEqual([C.LISTEN_DUPLICATE]);
  });
});

// ── The events vocabulary ──

describe('events is the subscribable-kind vocabulary (triggerConfigOptions)', () => {
  it('a declared kind subscribes clean — always a list', () => {
    expectClean(kgProgram(['{ type: "company", events: ["record.created"] }']));
    expectClean(vaultProgram(['{ folder: "inbox", events: ["file.added"] }']));
  });
});

// ── The changed-attribute filter ──

describe("a 'fields'-format key is bare property names of the landed address", () => {
  it('names the address lands on check clean, under either adapter\'s key', () => {
    expectClean(kgProgram(['{ type: "company", events: ["record.created"], fields: [name, domains] }']));
    expectClean(vaultProgram(['{ folder: "inbox", events: ["file.added"], watch: [title, size] }']));
  });

  it('an adapter with no schema leaves the names unvalidated — unknown stays silent', () => {
    const blind = mockCatalog({
      adapters: {
        kg: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          triggerConfig: ['type', 'events', 'fields'],
          triggerConfigOptions: { events: KG_ACTIONS },
          triggerConfigFormats: { fields: 'fields' },
        },
      },
      credentials: { native_knowledge: { adapter: 'kg' } },
    });
    const source = [
      'import { kg } from adapters',
      'import { native_knowledge } from credentials',
      'graph = kg(credentials: native_knowledge)',
      'movement m(rec: <graph-[:`Record Change`]->>) {',
      '  ERROR("nothing to see")',
      '}',
      'listen to graph { type: "company", events: ["record.created"], fields: [whatever] } fire m',
    ].join('\n');
    expect(
      checkProgram(parseProgram(spelledFor(5, source, blind)), blind).filter(d => (d.severity ?? 'error') === 'error'),
    ).toEqual([]);
  });
});

// ── The universal 2-way-sync flag ──
//
// `suppress_self` is valid on EVERY listener, default off, boolean-literal
// only. NOT a loop detector: it declares "ignore my own writes echoing back
// into this system."

describe('suppress_self — the universal listen flag', () => {
  it('rides alongside an adapter\'s own vocabulary, either shape', () => {
    expectClean(
      kgProgram(['{ type: "company", events: ["record.created"], suppress_self: true }']),
    );
    expectClean(
      vaultProgram(['{ folder: "inbox", events: ["file.added"], suppress_self: true }']),
    );
  });

  it('suppress_self: false checks clean (explicit default-off)', () => {
    expectClean(
      kgProgram(['{ type: "company", events: ["record.created"], suppress_self: false }']),
    );
  });

  it('omitting it is clean — the default is off', () => {
    expectClean(kgProgram(['{ type: "company", events: ["record.created"] }']));
  });

  it('a non-boolean value is MOV_LISTEN_BAD_CONFIG (boolean literal only)', () => {
    expect(
      messageOf(
        kgProgram(['{ type: "company", events: ["record.created"], suppress_self: "yes" }']),
        C.LISTEN_BAD_CONFIG,
      ),
    ).toContain('boolean literal');

    expect(
      messageOf(
        vaultProgram(['{ folder: "inbox", events: ["file.added"], suppress_self: 3 }']),
        C.LISTEN_BAD_CONFIG,
      ),
    ).toContain('boolean literal');
  });
});

// ── Nothing is ambient ──

describe('the graph is imported AND constructed, like any adapter (D25)', () => {
  it('a known adapter used unconstructed names both missing lines', () => {
    const source = [
      'import { vault } from adapters',
      'import { vault_main } from credentials',
      'files = vault(credentials: vault_main)',
      `movement m(f: ${VAULT_INBOX}) {`,
      '  ERROR("${kg}")',
      '}',
      'listen to files { folder: "inbox", events: ["file.added"] } fire m',
    ].join('\n');
    const found = check(source);
    expect(found.map(d => d.code)).toContain(C.NAME_UNRESOLVED);
    const message = found.find(d => d.code === C.NAME_UNRESOLVED)?.message;
    expect(message).toContain('import { kg } from adapters');
    expect(message).toContain("connect kg using …");
  });

  it('importing and constructing brings the graph into scope — listen included', () => {
    expect(codes(kgProgram(['{ type: "company", events: ["record.created"] }']))).toEqual([]);
  });

  // The graph's name is no longer its address, so it aliases like any other
  // adapter import (asserted positively in check.unit.test.ts's aliased-import
  // fixture). MOV_KG_IMPORT_ALIASED is gone with the privilege.
});
