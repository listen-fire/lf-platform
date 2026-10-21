import { CURRENT_LANGUAGE_VERSION, checkSourceInRust } from 'movement-lang';

import type { ChapterId } from '../types';

import { proseViolations } from '../prose_rules';
import { chapterRoute } from 'engine-contracts/handbook_section';
import { CORE_CHAPTERS, INTENT_INDEX, getCoreChapter, renderCoreIndex } from '../index';
import { HANDBOOK_CATALOG } from '../testing';

// The hand-written chapters. The sections a host adds are held to the same
// prose contract and the same examples check by that host's own tests, over
// the book it assembles.
const coreChapters = Object.values(CORE_CHAPTERS);

const ALL_CHAPTERS: ChapterId[] = [
  'foundations',
  'anatomy',
  'expressions',
  'writes',
  'traversal',
  'extraction',
  'branching',
  'listeners',
  'reviews',
  'patterns',
  'use-cases',
  'runs',
  'reference',
  'builtins',
];

describe('movement_handbook registry', () => {
  it('all chapters are registered and load', () => {
    for (const id of ALL_CHAPTERS) {
      const r = getCoreChapter(id);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.content.length).toBeGreaterThan(200);
    }
  });

  it('getCoreChapter errors on an unknown id and lists options', () => {
    const r = getCoreChapter('nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/anatomy/);
  });

  it('renderCoreIndex routes the duplicate-prevention intent', () => {
    expect(renderCoreIndex()).toMatch(/duplicate/i);
  });

  // Foundations IS the model card: the chapter every consumer is sent to first
  // carries the model, the cardinal rule, and the conventions. Routing is NOT
  // among them — the index is the one place a situation is routed from, so a
  // reading map here would be a second copy to drift.
  it('the foundations chapter carries model, cardinal rule, and conventions', () => {
    const r = getCoreChapter('foundations');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const section of ['what-an-automation-is', 'the-cardinal-rule', 'conventions']) {
      expect(getCoreChapter('foundations', section).ok).toBe(true);
    }
    expect(getCoreChapter('foundations', 'reading-map').ok).toBe(false);
  });
});

describe('movement_handbook referential integrity', () => {
  // A route into a host's section (`system:slack`, `plugin:research`) is the
  // host's to serve, and its tests resolve it in the book it assembles; every
  // other route names a hand-written chapter.
  const coreRoutes = INTENT_INDEX.filter((e) => !e.chapter.startsWith('system:') && !e.chapter.startsWith('plugin:'));

  it('every intent entry routes to a hand-written chapter or a host section', () => {
    for (const e of coreRoutes) {
      expect((CORE_CHAPTERS as Record<string, unknown>)[e.chapter]).toBeDefined();
    }
  });

  // The index routes to `chapter#section`, and a route is only worth serving
  // if the section it names is FETCHABLE — so this asserts through the real
  // fetch path rather than grepping the chapter body for a heading. An anchor
  // that renamed or lost its heading fails here the way an agent would meet it.
  it('every route into a hand-written chapter resolves through the real fetch path', () => {
    for (const e of coreRoutes) {
      const r = getCoreChapter(e.chapter, e.section);
      if (!r.ok) throw new Error(`${chapterRoute(e)}: ${r.error}`);
      expect(r.content.length).toBeGreaterThan(0);
      if (e.section) expect(r.content.startsWith('### ')).toBe(true);
    }
  });

  it('an unknown section names the chapter\'s real sections', () => {
    const r = getCoreChapter('writes', 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/identity/);
  });

  it('a section fetch costs a fraction of its chapter', () => {
    const whole = getCoreChapter('writes');
    const one = getCoreChapter('writes', 'identity');
    expect(whole.ok && one.ok).toBe(true);
    if (whole.ok && one.ok) {
      expect(one.content.length).toBeLessThan(whole.content.length / 4);
      expect(one.content).toContain('unique by');
    }
  });

  it('the index routes some situations straight at a system chapter', () => {
    const systemRoutes = INTENT_INDEX.filter((e) => e.chapter.startsWith('system:'));
    expect(systemRoutes.length).toBeGreaterThan(0);
  });

  // The per-chapter contract — retired constructs, tool names, internal
  // shorthands, use-case tuning, fence balance, and the vocabulary rules — is
  // one function (prose_rules.ts) run over EVERY chapter; a host runs the same
  // function over the sections it adds.
  it.each(coreChapters.map((c) => [c.id, c] as const))('%s holds the prose contract', (_id, chapter) => {
    expect(proseViolations(chapter)).toEqual([]);
  });

  // These assert the RENDERED text — what an agent actually reads — not the
  // chapter SOURCE. The chapters are template literals that escape backticks
  // and `${`, so a source-level grep can report a construct absent while the
  // rendered handbook still teaches it (and vice versa). Both constructs below
  // were retired by the event-edge collapse, and both survived ~87 occurrences
  // across ~10 chapters because nothing checked the rendered string.
  it('no chapter, front matter, or index still teaches the retired `Email Received` event node', () => {
    const rendered = [
      renderCoreIndex(),
      ...coreChapters.map((c) => c.content),
      ...coreChapters.flatMap((c) => (c.engineClaims ?? []).map((claim) => claim.probe)),
    ].join('\n');
    // The fires edge lands straight on `Email`; the wrapper node carried no
    // facts of its own and died with rule 1's collapse.
    expect(rendered).not.toMatch(/Email Received/);
  });

  it('no chapter still teaches the retired generic event→record wrapper hop', () => {
    const rendered = [
      ...coreChapters.map((c) => c.content),
      ...coreChapters.flatMap((c) => (c.engineClaims ?? []).map((claim) => claim.probe)),
    ].join('\n');
    // `e-[msg:record]-> { … }` — an event's fields are read STRAIGHT off the
    // movement parameter. This deliberately matches the lowercase generic hop
    // only: Airtable's event node really does publish a `Record` edge, and a
    // blanket ban on the word would forbid that true one.
    expect(rendered).not.toMatch(/-\[\w*:record\]->/);
  });

  it('carries no internal vocabulary in agent-visible prose', () => {
    const everything = [
      ...INTENT_INDEX.map((e) => e.intent),
      ...coreChapters.map((c) => `${c.title}\n${c.content}`),
    ].join('\n');
    const prose = everything.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    expect(prose).not.toMatch(/\bmovements?\b/i);
    expect(prose).not.toMatch(/\basks?\b/i);
  });
});

// ── The record-order rules, against the real adapters ─────────────────────
//
// The traversal chapter teaches which aggregates may read which relationships,
// and the teaching is only worth anything if the captured schemas back it. So
// the refusals are pinned here, on the same fixture the examples are checked
// against (testing.ts), by the checker a run on the Rust engine is held to: an
// order the source does not have cannot be borrowed by writing `first`, and a
// source that DOES keep an order needs no `ORDER BY` to prove it.

const ORDER_PRELUDE = `import { \`@lf/attio\` as attio, \`@lf/slack\` as slack } from adapters
import { acme, team_workspace } from credentials

crm  = connect attio using acme
chat = connect slack using team_workspace
`;

function orderCheck(body: string): Array<{ code: string; message: string }> {
  const probe = `${ORDER_PRELUDE}
function m(evt: <crm-[:\`Webhook Event\`]->>) {
${body}
}`;
  return checkSourceInRust(probe, HANDBOOK_CATALOG, { languageVersion: CURRENT_LANGUAGE_VERSION })
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => ({ code: d.code, message: d.message }));
}

describe('the record-order rules hold against the captured adapter schemas', () => {
  it('Text.join over a relationship with no order is refused, naming the fix', () => {
    const found = orderCheck('  t = Text.join(chat-[c:Channels]->.Name, ", ")');
    expect(found.map((d) => d.code)).toContain('MOV_FOLD_NEEDS_ORDER');
    expect(found[0].message).toContain('ORDER BY');
  });

  it('the same Text.join with an ORDER BY on the hop is clean', () => {
    expect(orderCheck('  t = Text.join(chat-[c:Channels ORDER BY c.Name]->.Name, ", ")')).toEqual([]);
  });

  it("a chat channel's messages fold clean with no ORDER BY — the source keeps them in order", () => {
    expect(
      orderCheck(
        [
          '  channel = only(chat-[c:Channels WHERE c.Name == "general"]->)',
          '  if (channel == null) { fail("no channel") }',
          '  t = Text.join(channel-[m:Messages]->.Message, "\\n")',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('first over a relationship with no order is refused, and the message names only', () => {
    const found = orderCheck('  t = first(chat-[c:Channels]->.Name)');
    expect(found.map((d) => d.code)).toContain('MOV_FOLD_NEEDS_ORDER');
    expect(found[0].message).toContain('only(');
  });

  it('only over the same lookup is clean — it is what the WHERE meant', () => {
    expect(
      orderCheck(
        [
          '  channel = only(chat-[c:Channels WHERE c.Name == "general"]->)',
          '  if (channel == null) { fail("no channel") }',
          '  write channel-[:Messages]-> { Message: "hi" }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('LIMIT with no ORDER BY over an unordered relationship is refused', () => {
    const found = orderCheck('  n = count(chat-[c:Channels LIMIT 3]->)');
    expect(found.map((d) => d.code)).toContain('MOV_LIMIT_NEEDS_ORDER');
    expect(found[0].message).toContain('ORDER BY');
  });

  it('…and is clean on a relationship the source keeps in order', () => {
    expect(
      orderCheck(
        [
          '  channel = only(chat-[c:Channels WHERE c.Name == "general"]->)',
          '  if (channel == null) { fail("no channel") }',
          '  n = count(channel-[m:Messages LIMIT 20]->)',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a commutative aggregate reads either', () => {
    expect(orderCheck('  n = count(chat-[c:Channels]->)')).toEqual([]);
  });
});
