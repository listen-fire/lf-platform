// Checker leftovers of the v5 surface, held in both checkers (legacy-lang's
// TypeScript one, and 0.12.13's Rust one it was written against, through the
// wasm build, on the same catalog): a three-argument `map`'s
// settings go last; the `#transform` retirement suggests a positional call;
// `Text.lower` inside walk brackets is one finding, not two; and a field read
// off text, a number or a true/false value is refused from 5 and warned
// before (both engines read null).

import { LANGUAGE_VERSION } from '@listen-fire/movement-lang/language_version';
import { mockCatalog } from '../../../legacy-lang/checker/catalog';
import { checkProgram, diagnosticSeverity, type Diagnostic } from '../../../legacy-lang/checker/check';
import { parseProgram } from '../../../legacy-lang/parser/parse';
import { mockCatalogSnapshot } from '@listen-fire/movement-lang/service/snapshot';
import { checkSourceInRust } from '@listen-fire/movement-lang/checker/rust_checker';

const spec: Parameters<typeof mockCatalog>[0] = {
  adapters: {
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: {
        positions: {
          company: { properties: { name: 'text' }, edges: { notes: { target: 'note', readable: true } } },
          note: { properties: { title: 'text' }, edges: {} },
        },
        collections: { companies: { target: 'company' } },
        writableRoots: { company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } } },
      },
    },
  },
  credentials: { crm_cred: { adapter: 'attio' } },
  plugins: {
    lookup: { args: ['q', 'limit'], argTypes: { q: 'text', limit: 'number' }, requiredArgs: ['q'], effects: { ai: true }, output: { kind: 'value', type: 'text' } },
    // A plugin that declares no output: before 5 it ran only as an extraction's stage.
    enrich: { args: ['q'], argTypes: { q: 'text' }, requiredArgs: ['q'] },
  },
};
const catalog = mockCatalog(spec);
const snapshot = mockCatalogSnapshot(spec);

const V5 = (body: string): string =>
  `import { attio } from adapters\nimport { crm_cred } from credentials\nimport { lookup } from plugins\ncrm = connect attio using crm_cred\nfunction m(t: <text>, c: <crm-[:company]->>) {\n${body}\n}\n`;
const V4 = (body: string): string =>
  `import { attio } from adapters\nimport { crm_cred } from credentials\nimport { lookup } from plugins\ncrm = attio(credentials: crm_cred)\nmovement m(t: <text>, c: <crm-[:company]->>) {\n${body}\n}\n`;

type Said = { code: string; severity: string; message: string };
const said = (found: Diagnostic[]): Said[] =>
  found.filter((d) => d.code !== 'MOV_LISTEN_MISSING').map((d) => ({ code: d.code, severity: diagnosticSeverity(d), message: d.message }));

/** What both checkers say of `source` under `version` — the same, or the test fails. */
function check(source: string, version: number): Said[] {
  const ts = said(checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }));
  // The Rust checker serves the versions the language release does (5);
  // below it the TypeScript checker alone answers (ruling A).
  const rust = version >= 5 ? said(checkSourceInRust(source, snapshot, { languageVersion: LANGUAGE_VERSION })) : ts;
  expect(rust).toEqual(ts);
  return ts;
}

describe('version 5 checker leftovers, in both checkers', () => {
  it("a three-argument map's settings go after the function", () => {
    const [d] = check(V5('  a = map([1, 2], (x) => x, 5)'), 5);
    expect(d?.code).toBe('MOV_BUILTIN_ARGS');
    expect(d?.message).toContain('after the function — `map(xs, f, { onError: "warn", concurrency: 4 })`');
    expect(d?.message).not.toContain('between');
    // Versions 1–4 keep their order, and their words.
    expect(check(V4('  a = MAP([1, 2], (x) => x, 5)'), 4)[0]?.message).toContain('between the collection and the function');
  });

  it('the #transform retirement suggests a positional call', () => {
    const [d] = check(V5('  e = crm-[k:companies]->-[:#transform { plugin: "lookup" }]->'), 5);
    expect(d?.code).toBe('MOV_TRANSFORM_HOP_RETIRED');
    expect(d?.message).toContain("'out = lookup(q)'");
    expect(d?.message).not.toContain('q:');
  });

  it('no #transform retirement suggests the retired extraction stage', () => {
    const messages = [
      ...check(V5('  e = crm-[k:companies]->-[:#transform { plugin: "lookup" }]->'), 5),
      ...check(V5('  e = crm-[k:companies]->-[:#transform { plugin: "enrich" }]->'), 5),
      ...check(V5('  e = crm-[k:companies]->-[:#transform { plugin: "nothing" }]->'), 5),
      ...check(V5('  e = crm-[k:companies]->-[:#transform]->'), 5),
      ...check(V5('  e = crm-[k:companies]->-[:#other]->'), 5),
    ].filter((d) => d.code.endsWith('_RETIRED'));
    expect(messages.length).toBeGreaterThanOrEqual(5);
    for (const { message } of messages) {
      expect(message).not.toContain('through');
      expect(message).not.toContain('extract from');
      expect(message).not.toMatch(/\w+: …/);
    }
    // A stage-only plugin is called like any other.
    expect(check(V5('  e = crm-[k:companies]->-[:#transform { plugin: "enrich" }]->'), 5)[0]?.message).toContain("'out = enrich(q)'");
  });

  it('Text.lower inside walk brackets is one finding, its fix LOWER', () => {
    const found = said(checkSourceInRust(V5('  b = c-[n:notes WHERE Text.lower(n.title) == "x"]->'), snapshot, { languageVersion: LANGUAGE_VERSION }));
    expect(found.map((d) => d.code)).toEqual(['MOV_V5_SPELLING']);
    expect(found[0]?.message).toContain('is written `LOWER`');
  });

  // The dialect reads version 5 through the installed parser, and 0.15 made
  // `Text.lower` the spelling inside a walk, so it finds nothing here. It serves
  // only the upgrade warnings of pins 1 to 4, and stays on the current core until
  // 0.12 retires (K5a rulings). Pinned to what it answers, so a change of that
  // answer in either direction fails here.
  it('Text.lower inside walk brackets: the TypeScript dialect finds nothing', () => {
    const source = V5('  b = c-[n:notes WHERE Text.lower(n.title) == "x"]->');
    expect(said(checkProgram(parseProgram(source, { languageVersion: 5 }), catalog, { languageVersion: 5 }))).toEqual([]);
  });

  it('a field read off text is refused from 5, and warned under 3 and 4', () => {
    const body = '  d = t.Name\n  write crm-[:companies]-> { name: t.Name }';
    const five = check(V5(body), 5);
    expect(five.map((d) => [d.code, d.severity])).toEqual([
      ['MOV_TEXT_HAS_NO_FIELDS', 'error'],
      ['MOV_TEXT_HAS_NO_FIELDS', 'error'],
    ]);
    expect(five[0]?.message).toContain("'t' is text, and a text has no fields");
    for (const version of [3, 4] as const) {
      const older = check(V4(body), version);
      expect(older.map((d) => [d.code, d.severity])).toEqual([
        ['MOV_TEXT_HAS_NO_FIELDS', 'warning'],
        ['MOV_TEXT_HAS_NO_FIELDS', 'warning'],
      ]);
      expect(older[0]?.message).toContain('it reads null; from it, this is refused');
    }
    // A field read off a record is untouched.
    expect(check(V5('  d = c.name'), 5)).toEqual([]);
  });

  it('a field read off a number or a true/false value is refused from 5, and warned under 3 and 4', () => {
    // Both engines read either as null under 3 and 4, as they read text's.
    for (const [value, noun] of [['3', 'a number'], ['true', 'a true/false value']] as const) {
      const [five, ...rest] = check(V5(`  n = ${value}\n  d = n.size`), 5);
      expect(rest).toEqual([]);
      expect([five?.code, five?.severity]).toEqual(['MOV_TEXT_HAS_NO_FIELDS', 'error']);
      expect(five?.message).toContain(`'n' is ${noun}, and ${noun} has no fields — 'size' is not something it holds`);
      for (const version of [3, 4] as const) {
        const older = check(V4(`  n = ${value}\n  d = n.\`size\``), version);
        expect(older.map((d) => [d.code, d.severity])).toEqual([['MOV_TEXT_HAS_NO_FIELDS', 'warning']]);
        expect(older[0]?.message).toContain(`'n' is ${noun}`);
      }
    }
  });
});

// Indexing a call's result is TypeScript's indexing (5_design: `xs[0]` for
// `AT`), read on the value the call hands back, hoisted call or not.
describe("an index on a call's result", () => {
  it('reads the result in both checkers, a hoisted call too', () => {
    for (const line of [
      '  y = sort(tags, (k) => Text.upper(k))[0]',
      '  y = sort(tags, (k) => Text.upper(k), { order: "desc" })[0]',
      '  y = sort(tags, (k) => k)[0]',
    ]) {
      expect(check(V5(`  tags = [t, "a"]\n${line}`), 5)).toEqual([]);
    }
  });
});

// A slot can arrive without the tree its program's parse cached (a program
// rebuilt from stored JSON, a slot the checker builds itself); the checker
// then reads its text again, and must read it under the program's version.
describe('a version 5 slot read again is read under 5', () => {
  const body = [
    '  u = Text.upper(t)',
    '  xs = [t, u]',
    '  y = xs[0]',
    '  if (y == "a" && u != "b") {',
    '    z = sort(xs, (x) => x, { order: "desc" })',
    '  }',
  ].join('\n');

  it('a program whose slots lost their cached parse checks as the parsed one does', () => {
    const parsed = parseProgram(V5(body), { languageVersion: 5 });
    const rebuilt = structuredClone(parsed);
    const found = said(checkProgram(rebuilt, catalog, { languageVersion: 5 }));
    expect(found).toEqual(said(checkProgram(parsed, catalog, { languageVersion: 5 })));
    expect(found.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
