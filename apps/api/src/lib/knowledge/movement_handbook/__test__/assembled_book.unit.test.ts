// The book this platform serves: the language's handbook (@listen-fire/handbook,
// whose own tests hold the hand-written chapters, the front page and the
// search) with the sections this platform's systems and plugins declare
// assembled on top. Held here: every route resolves in the assembled book,
// the added sections keep the prose contract and their examples run, the
// anchors diagnostics and search results hand out read through the Library
// reader, and the knowledge graph surface the handbook's examples are checked
// against is still the one the graph module declares.

import type { AdapterSpec, InstanceSchema, PositionSchema } from 'movement-lang';
import { HANDBOOK_POINTERS, HANDBOOK_POINTER_BY_CODE } from 'movement-lang';
import { eventAddressDisplay, eventAddressKey, narrowingPrefixKey } from 'legacy-lang';
import { KG_EVENT_RECORD_EDGE_NAME, KG_EVENT_TYPE_NAME, KG_NODE_TYPE_META_TYPE, KG_SUBSCRIBABLE_EVENTS } from '@listen-fire/kg';
import { CORE_CHAPTERS, proseViolations } from '@listen-fire/handbook';
import { HANDBOOK_KG_SPEC, admitProbe, checkExemption, claimsOf, parseProbe } from '@listen-fire/handbook/testing';
import { chapterRoute } from 'engine-contracts/handbook_section';

import { readBook } from '../../library';
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
    expect(() => admitProbe(claim)).not.toThrow();
  });

  it('every pending claim is still refused (a lift here means: update the section)', () => {
    for (const claim of addedClaims.filter((c) => c.status === 'pending')) {
      expect(() => admitProbe(claim)).toThrow(/failed checking/);
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

// ── The knowledge graph surface the handbook's examples are checked against ──
//
// The handbook carries a representative graph ontology over the graph's real
// event surface as a fixture (listen-fire's packages/handbook/__test__/kg_ontology.fixture.json),
// because the graph is this platform's module and the handbook cannot import
// it. Rebuilt here from the module, it must still equal the fixture: a rename
// in the graph module fails here rather than leaving the examples teaching a
// spelling the graph no longer answers to. To regenerate, write `KG_SPEC`
// below over the fixture.

const KG_NODE_TYPES = ['Company', 'Person', 'Support Ticket'];

/**
 * The graph's EVENT surface, as the adapter declares it and the host grafts it.
 *
 * Every NAME here comes from the adapter module, so a rename there breaks these
 * probes rather than quietly making the chapter teach a spelling the graph no
 * longer answers to; every KEY comes from `eventAddressKey`, so the fixture and
 * the checker cannot disagree about which position an address means. What is
 * hand-written is only the SHAPE the host's graft produces — a copy of the event
 * node per action, its record edge landing on the type the `type:` pin walks to,
 * dropped entirely under the deleted pin (there is no record left to fetch).
 *
 */
function kgEventSurface(): Pick<
  InstanceSchema,
  'positions' | 'unions' | 'eventPosition' | 'eventPositions' | 'eventNarrowingKeys' | 'eventNarrowingValues'
> {
  const properties = {
    action: { kind: 'enum' as const, options: [...KG_SUBSCRIBABLE_EVENTS] },
    type: 'text' as const,
    record: 'text' as const,
  };
  const positions: Record<string, PositionSchema> = {
    [KG_NODE_TYPE_META_TYPE]: { properties: {}, edges: {}, undescribed: true },
    [KG_EVENT_TYPE_NAME]: {
      properties,
      edges: {
        [KG_EVENT_RECORD_EDGE_NAME]: {
          target: KG_NODE_TYPE_META_TYPE,
          subject: true,
          requiresLiveRecord: true,
        },
      },
    },
  };
  const unions: Record<string, string[]> = {};
  for (const nodeType of KG_NODE_TYPES) {
    const variants: string[] = [];
    for (const action of KG_SUBSCRIBABLE_EVENTS) {
      const narrowing = { action, type: nodeType };
      const key = eventAddressKey({ event: KG_EVENT_TYPE_NAME, narrowing });
      variants.push(key);
      positions[key] = {
        properties,
        edges:
          action === 'record.deleted'
            ? {}
            : { [KG_EVENT_RECORD_EDGE_NAME]: { target: nodeType, subject: true } },
        displayName: eventAddressDisplay({ event: KG_EVENT_TYPE_NAME, narrowing }),
      };
    }
    unions[eventAddressKey({ event: KG_EVENT_TYPE_NAME, narrowing: { type: nodeType } })] = variants;
  }
  return {
    positions,
    unions,
    eventPosition: KG_EVENT_TYPE_NAME,
    eventPositions: [{ position: KG_EVENT_TYPE_NAME }],
    eventNarrowingKeys: ['type'],
    eventNarrowingValues: { [narrowingPrefixKey({})]: { type: KG_NODE_TYPES } },
  };
}

const KG_EVENT_SURFACE = kgEventSurface();

/**
 * The knowledge graph's ontology, hand-written — the one schema here that is
 * NOT captured, and could not be. Every other adapter has a vendor surface
 * that is the same for every workspace, so a capture is the truth. The KG's
 * types ARE the team's own data model: there is no workspace-independent
 * ontology to record, and capturing one team's would teach that team's nouns
 * as though they were the language's.
 *
 * So this is a REPRESENTATIVE ontology, and what the kg probes are held to is
 * the language surface over it — the root write and its `unique by`, the
 * linked write scoped to its parent, the mutation listen's config vocabulary,
 * the rooted read. Those are workspace-independent; `Company` and `Domains`
 * are set dressing, exactly as the credential aliases above are.
 *
 * Shaped to match what the real adapter projects (knowledge_graph.ts): one
 * root per node type, keyed by the type's own display name; every ontology
 * edge writable from both ends; fuzzy uniqueness resolution supported. A
 * multi-word type earns its place — it is what proves a name with a space
 * rides the same spellings a bare one does.
 */
const KG_ONTOLOGY: InstanceSchema = {
  ...KG_EVENT_SURFACE,
  positions: {
    ...KG_EVENT_SURFACE.positions,
    Company: {
      properties: { Name: 'text', Domains: { kind: 'list', of: 'text' }, Stage: 'text' },
      edges: {
        Team: { target: 'Person', readable: true, writable: true },
        'Support Tickets': { target: 'Support Ticket', readable: true, writable: true },
      },
    },
    Person: { properties: { Name: 'text', Email: 'text' }, edges: {} },
    'Support Ticket': {
      properties: { Status: 'text', Priority: 'number' },
      edges: { Reporter: { target: 'Person', readable: true, writable: true } },
    },
  },
  collections: { Company: { target: 'Company' }, Person: { target: 'Person' }, 'Support Ticket': { target: 'Support Ticket' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    Company: {
      fields: { Name: 'text', Domains: { kind: 'list', of: 'text' }, Stage: 'text' },
      requiredFields: [],
      fuzzyResolution: true,
      resultShape: { externalId: 'text', Name: 'text' },
    },
    Person: {
      fields: { Name: 'text', Email: 'text' },
      requiredFields: [],
      resultShape: { externalId: 'text', Name: 'text' },
    },
    'Support Ticket': {
      fields: { Status: 'text', Priority: 'number' },
      requiredFields: [],
      resultShape: { externalId: 'text', Status: 'text' },
    },
  },
};

/**
 * The graph is an ordinary adapter now — constructed like any other, and firing
 * an event entry like any other, so its listen vocabulary rides the spec
 * exactly as a captured adapter's does. Mirrors `KG_MANIFEST`: `type` is the
 * required address hop, `events` names the uniform `record.*` currency, and
 * `fields` is the changed-property filter.
 */
const KG_SPEC: AdapterSpec & { schema: InstanceSchema } = {
  constructionArgs: [],
  canFire: true,
  triggerConfig: ['type', 'events', 'fields'],
  triggerConfigRequired: ['type'],
  triggerConfigOptions: { events: [...KG_SUBSCRIBABLE_EVENTS] },
  triggerConfigFormats: { fields: 'fields' },
  schema: KG_ONTOLOGY,
};

describe('the handbook\'s knowledge graph fixture', () => {
  it('is the surface the graph module declares', () => {
    expect(HANDBOOK_KG_SPEC).toEqual(KG_SPEC);
  });
});
