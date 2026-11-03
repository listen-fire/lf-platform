// The book this platform serves: the language's handbook (@listen-fire/handbook,
// whose own tests hold the hand-written chapters, the front page and the
// search) with the sections this platform's systems and plugins declare
// assembled on top. Held here: every route resolves in the assembled book,
// the added sections keep the prose contract and their examples run, the
// anchors diagnostics and search results hand out read through the Library
// reader.

import type { CatalogSnapshot } from 'movement-lang';
import { HANDBOOK_POINTERS, HANDBOOK_POINTER_BY_CODE } from 'movement-lang';
import { CORE_CHAPTERS, proseViolations } from '@listen-fire/handbook';
import { HANDBOOK_KG_SPEC, admitProbe, checkExemption, claimsOf, parseProbe } from '@listen-fire/handbook/testing';
import { chapterRoute } from 'engine-contracts/handbook_section';

import { readBook } from '../../library';
import { handbookCatalogWithPlatformKg, kgHandbookSpec } from './kg_handbook_spec';
import {
  buildMovementFrontMatter,
  getMovementChapter,
  getMovementDoctrine,
  getMovementHandbook,
  languageIndex,
  renderMovementIndex,
  searchLanguage,
} from '../index';

const book = getMovementHandbook();
const chapters = Object.values(book.chapters);
const added = chapters.filter((c) => !(c.id in CORE_CHAPTERS));

describe('the assembled book', () => {
  it('adds sections of this platform\'s own', () => {
    expect(added.some((c) => c.id.startsWith('system:'))).toBe(true);
    expect(added.some((c) => c.id.startsWith('plugin:'))).toBe(true);
  });

  it('getMovementChapter errors on an unknown id and lists options', () => {
    const r = getMovementChapter('nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/anatomy/);
  });

  // The index routes to `chapter#section`, some of them straight at a system's
  // or a plugin's section, and a route is only worth serving if the section it
  // names is FETCHABLE from the book as served.
  it('every intent route resolves through the real fetch path', () => {
    for (const e of book.intentIndex) {
      expect(book.chapters[e.chapter]).toBeDefined();
      const r = getMovementChapter(e.chapter, e.section);
      if (!r.ok) throw new Error(`${chapterRoute(e)}: ${r.error}`);
      expect(r.content.length).toBeGreaterThan(0);
      if (e.section) expect(r.content.startsWith('### ')).toBe(true);
    }
  });

  // The front matter is foundations + the index, and nothing else: the model
  // card arrives ONCE, whether a reader meets it here or fetches the chapter.
  // It used to be paraphrased into a second preface constant, so every
  // consumer read the model twice and the two copies drifted.
  it('buildMovementFrontMatter is the foundations chapter plus the index', () => {
    const fm = buildMovementFrontMatter();
    const chapter = getMovementChapter('foundations');
    expect(chapter.ok).toBe(true);
    if (chapter.ok) expect(fm).toContain(chapter.content);
    expect(getMovementDoctrine()).toBe(chapter.ok ? chapter.content : undefined);
    expect(fm).toMatch(/When you need to:/); // index
    expect(fm).toMatch(/no magic values/i); // conventions, via foundations
    // One copy: the model card is stated once, not restated as a preface.
    expect(fm.match(/### what-an-automation-is/g) ?? []).toHaveLength(1);
    expect(renderMovementIndex()).toMatch(/duplicate/i);
  });

  // A system's own section is bound by the same prose contract as a
  // hand-written chapter; nothing about it is exempt.
  it.each(added.map((c) => [c.id, c] as const))('%s holds the prose contract', (_id, chapter) => {
    expect(proseViolations(chapter)).toEqual([]);
  });

  it('nothing served still teaches the retired event node or the generic event→record hop', () => {
    const rendered = [
      buildMovementFrontMatter(),
      ...chapters.map((c) => c.content),
      ...chapters.flatMap((c) => (c.engineClaims ?? []).map((claim) => claim.probe)),
    ].join('\n');
    expect(rendered).not.toMatch(/Email Received/);
    expect(rendered).not.toMatch(/-\[\w*:record\]->/);
  });

  it('carries no internal vocabulary in agent-visible prose', () => {
    const everything = [
      buildMovementFrontMatter(),
      ...book.intentIndex.map((e) => e.intent),
      ...chapters.map((c) => `${c.title}\n${c.content}`),
    ].join('\n');
    const prose = everything.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    expect(prose).not.toMatch(/\bmovements?\b/i);
    expect(prose).not.toMatch(/\basks?\b/i);
  });
});

// The added sections' examples, held exactly as the handbook holds its own
// (listen-fire's packages/handbook/__test__/engine_claims.unit.test.ts): against the catalog
// captured from the real adapters, by the check a run on the Rust engine passes
// before it executes.
describe('the added sections\' engine claims', () => {
  const claims = claimsOf(chapters);
  const addedClaims = claimsOf(added);
  // The graph as this platform's module declares it (kg_handbook_spec.ts).
  let catalog: CatalogSnapshot;
  beforeAll(async () => {
    catalog = await handbookCatalogWithPlatformKg();
  });

  it("listen-fire's handbook fixture is the graph as kgHandbookSpec declares it", async () => {
    expect(HANDBOOK_KG_SPEC).toEqual(await kgHandbookSpec());
  });

  it('claimed constructs are unique across the whole book', () => {
    const constructs = claims.map((c) => c.construct);
    expect(new Set(constructs).size).toBe(constructs.length);
  });

  it('the added sections declare claims (the guard has something to hold)', () => {
    expect(addedClaims.length).toBeGreaterThan(0);
  });

  it.each(addedClaims.map((c) => [c.chapter, c.construct, c] as const))('%s — probe for "%s" parses', (_chapter, _construct, claim) => {
    expect(() => parseProbe(claim)).not.toThrow();
  });

  it.each(
    addedClaims.filter((c) => c.status === 'runs' && checkExemption(c) === undefined).map((c) => [c.chapter, c.construct, c] as const),
  )('%s claims "%s" runs — the engine admits it', (_chapter, _construct, claim) => {
    expect(() => admitProbe(claim, catalog)).not.toThrow();
  });

  it('every pending claim is still refused (a lift here means: update the section)', () => {
    for (const claim of addedClaims.filter((c) => c.status === 'pending')) {
      expect(() => admitProbe(claim, catalog)).toThrow(/failed checking/);
    }
  });
});

describe('through the Library reader', () => {
  const pointers = [...new Set([...Object.values(HANDBOOK_POINTERS), ...Object.values(HANDBOOK_POINTER_BY_CODE)])];

  it.each(pointers.flatMap((anchor) => [false, true].map((frontPageInsteadOfChapters) => [anchor, frontPageInsteadOfChapters] as const)))(
    'the diagnostic anchor %s resolves (front page instead of chapters: %s)',
    (anchor, frontPageInsteadOfChapters) => {
      const read = readBook({ bookId: 'automations', chapter: anchor, frontPageInsteadOfChapters }) as { content?: string; error?: string };
      expect(read.error).toBeUndefined();
      expect(read.content?.length ?? 0).toBeGreaterThan(40);
    },
  );

  it('every anchor the search hands out reads with the front page instead of chapters', () => {
    const anchors = [...new Set(languageIndex().flatMap((e) => (e.anchor ? [e.anchor] : [])))];
    for (const anchor of anchors) {
      const read = readBook({ bookId: 'automations', chapter: anchor, frontPageInsteadOfChapters: true }) as { content?: string };
      if (!read.content) throw new Error(`${anchor} does not read with the front page instead of chapters: ${JSON.stringify(read)}`);
    }
  });

  it('the search finds a system by name', () => {
    const names = searchLanguage({ query: 'slack' }).results.map((r) => r.name);
    expect(names.some((name) => name.startsWith('system:slack'))).toBe(true);
  });
});
