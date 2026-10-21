// The handbook's front page: short enough to read on every build and held to
// the prose contract. Its examples are checked with the chapters'
// (engine_claims.unit.test.ts takes `frontPageClaims()` alongside them); the
// anchors diagnostics name are held by pointers.unit.test.ts.

import { CONCEPTS, TS_EXCEPT, exampleProgram, frontPageClaims, frontSection, renderFrontPage } from '../front_page';
import { proseViolations } from '../prose_rules';

/** The page is read on every build; past this it stops being a front page. */
const WORD_CEILING = 800;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe('the front page', () => {
  const page = renderFrontPage();

  it(`stays under ${WORD_CEILING} words`, () => {
    expect(words(page)).toBeLessThanOrEqual(WORD_CEILING);
  });

  it('holds the prose contract — it may name the tools of the build loop, and nothing else is relaxed', () => {
    const asChapter = { id: 'foundations' as const, title: 'Front page', content: page };
    expect(proseViolations(asChapter, { agentFacing: true })).toEqual([]);
  });

  it('only shows examples that are checked', () => {
    const shown = [...TS_EXCEPT, ...CONCEPTS].filter((e) => e.example !== undefined).length;
    expect(frontPageClaims()).toHaveLength(shown);
    // A whole-file example is shown exactly as checked; every other one is
    // checked inside the prelude the page leaves unsaid.
    for (const entry of [...TS_EXCEPT, ...CONCEPTS]) {
      if (entry.example === undefined) continue;
      const probe = exampleProgram(entry.example);
      if ('file' in entry.example) expect(page).toContain(probe.trimEnd());
      else expect(page).not.toContain(probe);
    }
  });

  it('carries every concept with no TypeScript analogue', () => {
    expect(CONCEPTS.map((c) => c.anchor)).toEqual(['systems', 'graph-and-paths', 'identity', 'extraction', 'runs']);
  });

  it('answers each anchor alone, and names the real ones for an unknown one', () => {
    for (const entry of [...TS_EXCEPT, ...CONCEPTS]) {
      const section = frontSection(entry.anchor);
      expect(section.ok).toBe(true);
      if (section.ok) expect(section.content).toContain(entry.title);
    }
    const missing = frontSection('nope');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('maybe-absent');
  });
});
