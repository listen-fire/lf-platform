// Comparison and absence (slack-blocks-json-fields layer 6).
//
// The TS model, adopted: comparing `T | absent` against a present value is
// LEGAL — absent is simply never equal (the engine's `left === right`) — and in
// the true branch of an `==` the value is PRESENT, so the comparison joins `?:`
// fill and traversal-as-gate as a guard form. ORDERING keeps requiring a present
// value, mirroring TS's error on `x < 3` for `x: number | undefined`.
//
// TWO adapter shapes, deliberately: a fixture matching one adapter cannot tell
// derived from hardcoded. `polls` declares each field of its result maybe
// absent (`T | absent`); `meter` is the same story with different names. The
// absence is the field's own: a 0.13 catalog has no landing that may settle
// empty (`resolvesEmpty` is retired), so an `==` narrows the one field it
// compares.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { fromCatalogSnapshot, type CatalogSnapshot } from 'movement-lang/service/snapshot';
import type { InstanceSchema } from '../catalog';
import type { SchemaFieldType } from 'movement-lang/catalog/types';

const maybe = (of: SchemaFieldType): SchemaFieldType => ({ kind: 'maybeAbsent', of });

const pollSchema: InstanceSchema = {
  positions: {
    Poll: { properties: { Question: 'text' }, edges: {} },
    'Poll Result': {
      properties: {
        Answer: maybe({ kind: 'enum', options: ['Ship', 'Hold'] }),
        Score: maybe('number'),
        Seen: maybe('datetime'),
        Payload: maybe('json'),
        Tags: maybe({ kind: 'list', of: 'text' }),
      },
      edges: { Notes: { target: 'Poll Note', readable: true } },
    },
    'Poll Note': { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Poll: { target: 'Poll' }, 'Poll Result': { target: 'Poll Result' } },
  writableRoots: {
    Poll: {
      fields: { Question: 'text' },
      requiredFields: ['Question'],
      resultShape: { externalId: 'text' },
    },
  },
};

/** The second shape — same story, none of the same names. */
const meterSchema: InstanceSchema = {
  positions: {
    Gauge: { properties: { Label: 'text' }, edges: {} },
    'Gauge Reading': {
      properties: { Grade: maybe({ kind: 'enum', options: ['A', 'B'] }), Level: maybe('number') },
      edges: {},
    },
  },
  collections: { Gauge: { target: 'Gauge' }, 'Gauge Reading': { target: 'Gauge Reading' } },
  writableRoots: {
    Gauge: {
      fields: { Label: 'text' },
      requiredFields: ['Label'],
      resultShape: { externalId: 'text' },
    },
  },
};

/** An ordinary writable sink — the require-present site an undischarged
 *  absence lands on. */
const logSchema: InstanceSchema = {
  positions: { Entry: { properties: { label: 'text', score: 'number' }, edges: {} } },
  collections: { Entry: { target: 'Entry' } },
  writableRoots: {
    Entry: { fields: { label: 'text', score: 'number' }, resultShape: { externalId: 'text' } },
  },
};

const snapshot: CatalogSnapshot = {
  adapters: {
    polls: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: { probe: pollSchema },
    },
    meter: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: { probe: meterSchema },
    },
    logbook: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: { probe: logSchema },
    },
  },
  credentials: { probe: { adapters: ['polls', 'meter', 'logbook'] } },
  plugins: {},
};

const PRELUDE = `import { polls, meter, logbook } from adapters
import { probe } from credentials

p = connect polls using probe
g = connect meter using probe
log = connect logbook using probe
`;

/** `r` and `q` are the function's parameters, so every field of either reads
 *  `T | absent`. */
const diagnosticsFor = (body: string): Diagnostic[] =>
  checkProgram(
    parseProgram(`${PRELUDE}\nfunction m(r: <p-[:\`Poll Result\`]->>, q: <g-[:\`Gauge Reading\`]->>) {\n${body}\n}`),
    fromCatalogSnapshot(snapshot),
  ).filter(d => (d.severity ?? 'error') === 'error');

const codesFor = (body: string): string[] => diagnosticsFor(body).map(d => d.code);

describe('comparison legality against `T | absent`', () => {
  it('== is legal — absent is never equal to a present value', () => {
    expect(codesFor(`  if (r.Answer == "Ship") { }`)).toEqual([]);
  });

  it('!= is legal', () => {
    expect(codesFor(`  if (r.Answer != "Ship") { }`)).toEqual([]);
  });

  it('IN is legal', () => {
    expect(codesFor(`  if (List.includes(["Ship", "Hold"], r.Answer)) { }`)).toEqual([]);
  });

  it('CONTAINS is legal', () => {
    expect(codesFor(`  if (List.includes(r.Tags, "urgent")) { }`)).toEqual([]);
  });

  it('ORDERED comparison still requires a present value (TS errors on `x < 3`)', () => {
    for (const op of ['>', '>=', '<', '<=']) {
      expect(codesFor(`  if (r.Score ${op} 3) { }`)).toEqual(['MOV_ABSENT_REQUIRED']);
    }
  });

  it('the ordered-comparison message says equality is fine, and names the discharges', () => {
    const message = diagnosticsFor(`  if (r.Score > 3) { }`)[0]?.message ?? '';
    expect(message).toContain('ordered comparison');
    // The fallback, not the `?:` fill: `?:` is a write-FIELD marker, and there
    // is no write field here — COALESCE is the discharge a comparison can use.
    expect(message).toContain('coalesce');
    expect(message).toContain('never equal');
  });

  it('WITHIN orders a timestamp against the clock, so it requires present too', () => {
    expect(codesFor(`  if (r.Seen WITHIN 30d) { }`)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('a json comparison is still MOV_JSON_OPAQUE — absence changes nothing there', () => {
    expect(codesFor(`  if (r.Payload == "x") { }`)).toContain('MOV_JSON_OPAQUE');
  });

  it('an expression with no name to narrow just compares — nothing to discharge', () => {
    // `DATE.PARSE` types `date | absent`; comparing it is legal, and there is no
    // reference to narrow, exactly as in TS.
    expect(
      codesFor(`  x = "12 March 2026"\n  if (Date.parse(x) == Date.from("2026-03-12")) { }`),
    ).toEqual([]);
  });
});

describe('equality narrows — the comparison IS the guard', () => {
  it('the true branch reads the value as PRESENT', () => {
    expect(
      codesFor(`  if (r.Answer == "Ship") { write log-[:Entry]-> { label: r.Answer } }`),
    ).toEqual([]);
  });

  it('the FALSE branch learns nothing (absent, or another value)', () => {
    expect(
      codesFor(
        `  if (r.Answer == "Ship") { } else { write log-[:Entry]-> { label: r.Answer } }`,
      ),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('!= narrows NOTHING in its true branch — a != match may be absent', () => {
    expect(
      codesFor(`  if (r.Answer != "Ship") { write log-[:Entry]-> { label: r.Answer } }`),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('narrowing does not leak past the arm', () => {
    expect(
      codesFor(`  if (r.Answer == "Ship") { }\n  write log-[:Entry]-> { label: r.Answer }`),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('an AND conjunct narrows for the conjuncts after it AND the body', () => {
    expect(
      codesFor(
        `  if (r.Score == 5 && r.Score > 3) { write log-[:Entry]-> { score: r.Score } }`,
      ),
    ).toEqual([]);
  });

  it('under OR it proves nothing — a true condition need not be this operand', () => {
    expect(
      codesFor(
        `  if (r.Answer == "Ship" || 1 == 1) { write log-[:Entry]-> { label: r.Answer } }`,
      ),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('comparing two maybe-absent reads proves nothing — absent == absent is TRUE', () => {
    expect(
      codesFor(
        `  if (r.Score == q.Level) { write log-[:Entry]-> { score: r.Score } }`,
      ),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('a `?:` fill is untouched by any of this', () => {
    expect(codesFor(`  write log-[:Entry]-> { label ?: r.Answer }`)).toEqual([]);
  });
});

describe('the second shape — derived, not hardcoded', () => {
  it('equality is legal and narrows on a differently-named landing', () => {
    expect(
      codesFor(`  if (q.Grade == "A") { write log-[:Entry]-> { label: q.Grade } }`),
    ).toEqual([]);
  });

  it('ordering it still requires present', () => {
    expect(codesFor(`  if (q.Level >= 3) { }`)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('the enum did-you-mean is the ONLY thing a typo’d comparison says', () => {
    const errors = diagnosticsFor(`  if (q.Grade == "Ay") { }`);
    expect(errors.map(d => d.code)).toEqual(['MOV_ENUM_UNKNOWN_VALUE']);
    expect(errors[0].message).toContain('Did you mean "A"?');
  });
});
