// Comparisons legacy-lang's tests held about the 0.12 surface, held against the
// carried 0.12.13 checker they were written against. They moved here because
// nothing outside this package may import it.
//
// Each was written as a question to legacy-lang's dialect of version 5, which
// reads through the installed parser. 0.15 changed the words inside a walk, so
// the dialect no longer answers as 0.12 did. That dialect serves only the upgrade
// warnings of pins 1 to 4, and stays on the current core until 0.12 retires (K5a
// rulings), so each difference is pinned below rather than mended: each pin states
// what the dialect answers today, so it fails if that answer changes in either
// direction, toward 0.12's or to something else.

import { LANGUAGE_VERSION } from '@listen-fire/movement-lang/language_version';
import { spellCode } from '@listen-fire/movement-lang/parser/surface';
import { mockCatalogSnapshot } from '@listen-fire/movement-lang/service/snapshot';
import { checkSourceInRust } from '@listen-fire/movement-lang/checker/rust_checker';

import { mockCatalog } from '../../../legacy-lang/checker/catalog';
import { checkProgram } from '../../../legacy-lang/checker/check';
import { parseProgram } from '../../../legacy-lang/parser/parse';
import { spellCode as dialectSpellCode } from '../../../legacy-lang/parser/surface';

type Spec = Parameters<typeof mockCatalogSnapshot>[0];

const carriedErrors = (source: string, spec: Spec): string[] =>
  checkSourceInRust(source, mockCatalogSnapshot(spec), { languageVersion: LANGUAGE_VERSION })
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => `${d.code}: ${d.message}`);

const dialectErrors = (source: string, spec: Parameters<typeof mockCatalog>[0]): string[] =>
  checkProgram(parseProgram(source, { languageVersion: 5 }), mockCatalog(spec), { languageVersion: 5 })
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => `${d.code}: ${d.message}`);

const REGISTRY = {
  adapters: {
    registry: {
      constructionArgs: [{ name: 'credentials', kind: 'credential' as const, required: true }],
      schema: {
        positions: {
          entity: { properties: { Name: 'text', City: 'text', Ghost: 'boolean' }, edges: { Holdings: { target: 'holding' } } },
          holding: { properties: { Amount: 'number' }, edges: {} },
        },
        collections: { entities: { target: 'entity' } },
        writableRoots: {},
      },
    },
  },
  credentials: { public_registry: { adapter: 'registry' } },
};

const ASKS = {
  adapters: {
    asksys: {
      constructionArgs: [{ name: 'credentials', kind: 'credential' as const, required: true }],
      schema: {
        positions: {
          check: { properties: { state: 'text', answer: 'boolean' }, edges: { responses: { target: 'response' } } },
          response: { properties: { answer: 'boolean' }, edges: { detail: { target: 'detail' } } },
          detail: { properties: { note: 'text' }, edges: {} },
        },
        collections: { checks: { target: 'check' }, Check: { target: 'Check' } },
        supportsInPlaceUpdate: true,
        writableRoots: {
          Check: {
            fields: { prompt: 'text' },
            resultShape: { externalId: 'text', url: 'text', state: 'text', answer: 'boolean' },
            edges: { Response: { target: 'response', awaitable: true } },
          },
        },
      },
    },
  },
  credentials: { ask_creds: { adapter: 'asksys' } },
};

const CHAT = {
  adapters: {
    slack: {
      constructionArgs: [],
      schema: {
        positions: {
          channel: { properties: { Name: 'text' }, edges: { Messages: { target: 'message', readable: true, sequenced: 'chronological' as const } } },
          message: { properties: { Text: 'text', Tags: { kind: 'list' as const, of: 'text' as const } }, edges: {} },
        },
        collections: { Channels: { target: 'channel' } },
      },
    },
  },
};

const HOP_WHERE =
  'import { registry } from adapters\nimport { public_registry } from credentials\nreg = connect registry using public_registry\n' +
  'function main() {\n  rows = reg-[e:entities WHERE EXISTS(e-[:Holdings]->)]->\n}';
const QUORUM =
  'import { asksys } from adapters\nimport { ask_creds } from credentials\nquestions = connect asksys using ask_creds\n\n' +
  'function m(d: <questions-[:check]->>) {\n  await until(count(d-[x:responses WHERE EXISTS(x-[:detail]->)]->) >= count(d-[:responses]->) * 2/3, { every: 10m })\n}';
const WALK_WORDS =
  'import { `@lf/slack` as slack } from adapters\nchat = connect slack\n\n' +
  'function go(c: <chat-[:channel]->>) {\n  ms = c-[m:Messages WHERE m.Tags CONTAINS "x" AND LENGTH(m.Text) > 2]->\n}';
const LOWER_IN_A_WALK = 'crm-[c:Companies WHERE LOWER(c.Name) CONTAINS "x"]->';

describe('the 0.12 surface, by the carried 0.12.13 checker', () => {
  it('a read hop\'s alias names the landed record, so a hop walked from it types too', () => {
    expect(carriedErrors(HOP_WHERE, REGISTRY)).toEqual([]);
  });

  it('the quorum narrowing form (COUNT / EXISTS over sets) type-checks', () => {
    expect(carriedErrors(QUORUM, ASKS)).toEqual([]);
  });

  it('inside walk brackets nothing is respelled', () => {
    expect(checkSourceInRust(WALK_WORDS, mockCatalogSnapshot(CHAT), { languageVersion: LANGUAGE_VERSION }).filter((d) => d.code === 'MOV_V5_SPELLING')).toEqual([]);
  });

  it('a message spells a walk\'s own words as they are', () => {
    expect(spellCode(LOWER_IN_A_WALK)).toBe(LOWER_IN_A_WALK);
    for (const [old, v5] of [
      ['EXISTS(channel)', 'channel != null'],
      ['AT(t, 0)', 't[0]'],
      ['IF … THEN "Yes" ELSE "No" END', '… ? "Yes" : "No"'],
      ['if ISNULL(x) { ERROR("…") }', 'if (x == null) { fail("…") }'],
      ['await until(() => { return EXISTS(t-[:Shipment]->) }, every: 15m)', 'await until(() => { return exists(t-[:Shipment]->) }, { every: 15m })'],
    ]) {
      expect(spellCode(old!)).toBe(v5);
    }
  });
});

describe('where legacy-lang\'s dialect no longer answers as 0.12 did', () => {
  it('a read hop\'s alias: it refuses `EXISTS` inside the walk', () => {
    expect(dialectErrors(HOP_WHERE, REGISTRY)).toEqual(['MOV_V5_SPELLING: inside walk brackets `EXISTS` is written `exists`, as it is outside them']);
  });

  it('the quorum form: it refuses `EXISTS` inside the walk', () => {
    expect(dialectErrors(QUORUM, ASKS)).toEqual(['MOV_V5_SPELLING: inside walk brackets `EXISTS` is written `exists`, as it is outside them']);
  });

  it('walk words: it respells `LENGTH` as `Text.length`', () => {
    expect(dialectErrors(WALK_WORDS, CHAT)).toEqual(['MOV_V5_SPELLING: inside walk brackets `LENGTH` is written `Text.length`, as it is outside them']);
  });

  it('a message: it spells `LOWER` as `Text.lower`', () => {
    expect(dialectSpellCode(LOWER_IN_A_WALK, '5')).toBe('crm-[c:Companies WHERE Text.lower(c.Name) CONTAINS "x"]->');
  });
});
