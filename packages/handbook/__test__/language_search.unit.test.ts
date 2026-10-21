// The language search: generated from the standard library so it cannot
// drift, ranked plainly, and every anchor it hands out readable. Searched here
// over the hand-written chapters alone; a host searches the book it assembles,
// and its tests hold the sections it adds (a system found by name, an anchor
// read through its reader).

import { splitChapterRoute } from 'engine-contracts/handbook_section';

import { CORE_CHAPTERS, frontSection, getCoreChapter } from '../index';
import { exampleText } from '../front_page';
import {
  CONTROL_FORMS,
  MAX_RESULTS,
  builtinName,
  builtinSignature,
  builtinSummary,
  languageIndex,
  retiredBuiltins,
  searchLanguage,
  searchableBuiltins,
} from '../language_search';
import { proseViolations } from '../prose_rules';

const index = languageIndex(CORE_CHAPTERS);
const top = (query: string, kind?: 'function' | 'concept' | 'recipe') =>
  searchLanguage({ query, ...(kind ? { kind } : {}) }, CORE_CHAPTERS).results.map((r) => r.name);

describe('built-ins come from the registry', () => {
  it('every documented registry function has an entry carrying its generated signature', () => {
    for (const builtin of searchableBuiltins()) {
      const entry = index.find((e) => e.kind === 'function' && e.name === builtinName(builtin) && e.detail === builtinSignature(builtin));
      if (!entry) throw new Error(`the standard library's ${builtin.name} has no search entry`);
      expect(entry.purpose).toBe(builtinSummary(builtin));
    }
  });

  it('leaves out only what the registry marks retired', () => {
    const left = retiredBuiltins();
    expect(left.some((b) => searchableBuiltins().includes(b))).toBe(false);
    expect(left.length).toBeGreaterThan(0);
    // Retired, or written as an operator rather than called (`x == null`, `xs[i]`).
    for (const b of left) expect(b.summary.startsWith('RETIRED') || ['ISNULL', 'AT', 'TONUMBER'].includes(b.name)).toBe(true);
    for (const b of left) expect(index.some((e) => e.name === b.name)).toBe(false);
  });

  it('every section of the builtins chapter is headed by a name an author writes', () => {
    const written = new Set(searchableBuiltins().map(builtinName));
    for (const entry of index.filter((e) => e.anchor?.startsWith('builtins#'))) {
      expect(written.has(entry.name)).toBe(true);
    }
  });

  it('a built-in with a section of its own borrows its example from it', () => {
    const join = index.find((e) => e.name === 'Text.join');
    expect(join?.anchor).toBe('builtins#Text.join');
    expect(join?.example).toMatch(/Text\.join\(/);
  });
});

describe('ranking', () => {
  it('finds a built-in by what it does', () => {
    expect(top('join text').slice(0, 2)).toContain('Text.join');
  });

  it('finds a built-in by its old registry name, and never shows that name', () => {
    const hit = top('TEXT.SERIALISE')[0];
    expect(hit).toBe('Json.stringify');
    expect(JSON.stringify(index.find((e) => e.name === hit))).not.toMatch(/SERIALISE/);
  });

  it('finds a built-in by name, whatever its case', () => {
    expect(top('coalesce')[0]).toBe('coalesce');
    expect(top('formatFigure')[0]).toBe('Currency.formatFigure');
  });

  it('answers "update or create a record" with identity', () => {
    expect(top('update or create a record').slice(0, 2)).toContain('A write creates or updates, by identity');
  });

  it('answers a TypeScript habit with the place it misleads', () => {
    expect(top('undefined optional chaining', 'concept')[0]).toBe('Absent, not undefined');
  });

  it('finds the control forms the grammar owns', () => {
    expect(top('wait for an approval or a timeout')).toContain('race');
  });

  it('finds a recipe', () => {
    expect(top('scheduled digest', 'recipe')[0]).toBe('patterns#scheduled-digest');
  });

  it('filters by kind, caps the results, and is deterministic', () => {
    const results = searchLanguage({ query: 'text', kind: 'function' }, CORE_CHAPTERS).results;
    expect(results.length).toBeLessThanOrEqual(MAX_RESULTS);
    for (const r of results) expect(r.kind).toBe('function');
    expect(top('text')).toEqual(top('text'));
  });

  it('says so when nothing matches', () => {
    const r = searchLanguage({ query: 'the of and' }, CORE_CHAPTERS);
    expect(r.results).toEqual([]);
    expect(r.note).toMatch(/Nothing matched/);
  });
});

describe('what the search hands out', () => {
  it('every anchor it hands out resolves to a section', () => {
    const anchors = [...new Set(index.flatMap((e) => (e.anchor ? [e.anchor] : [])))];
    for (const anchor of anchors) {
      const route = splitChapterRoute(anchor);
      const read = route.chapter === 'front' && route.section !== undefined ? frontSection(route.section) : getCoreChapter(route.chapter, route.section);
      if (!read.ok) throw new Error(`${anchor} does not resolve: ${read.error}`);
    }
  });

  it('the control forms it writes itself hold the prose contract', () => {
    for (const form of CONTROL_FORMS) {
      const asChapter = {
        id: 'reference' as const,
        title: form.name,
        content: `${form.purpose}\n\n${form.signature}\n\n\`\`\`\n${exampleText(form.example)}\n\`\`\``,
      };
      expect(proseViolations(asChapter)).toEqual([]);
    }
  });
});
