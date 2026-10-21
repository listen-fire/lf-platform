// Lockstep guard: every example the handbook shows vs the engine that runs it.
// Chapters carry machine-readable EngineClaim entries (types.ts) for the
// constructs their prose says run — or don't run — and this test hands each
// claim's probe to the check a run on the Rust engine passes before it
// executes (the pin, the parse, the Rust checker; testing.ts), against the
// catalog captured from the real adapters:
//
//   - status 'runs'    → the engine must admit the probe; if the construct
//     stops checking while a chapter still says it works, this fails;
//   - status 'pending' → the engine must refuse the probe; the moment a lift
//     makes it check clean, this fails — so closing a gap cannot forget the
//     docs.
//
// Probes must parse: a probe that does not parse is refused for a reason that
// says nothing about the construct, so parseability is asserted first.
//
// Coverage is opt-out, not opt-in: every 'runs' probe is checked, and a probe
// escapes only by being listed in CHECK_EXEMPT with a reason, a list whose size
// is pinned here. The old model was an opt-in list with ONE entry against ~50
// runnable examples, which is how 87 occurrences of two retired constructs
// survived: nothing compared the other 49 to anything.

import { CORE_CHAPTERS, controlFormClaims, frontPageClaims } from '../index';
import { CAPTURED_ADAPTERS, CHECK_EXEMPT, admitProbe, checkExemption, claimsOf, parseProbe } from '../testing';

const claims = claimsOf(Object.values(CORE_CHAPTERS)).concat(
  // The handbook's front page and the language search's control forms show
  // examples too, outside any chapter; they are held the same way.
  frontPageClaims().map((claim) => ({ ...claim, chapter: 'front' })),
  controlFormClaims().map((claim) => ({ ...claim, chapter: 'language-search' })),
);

const runnable = claims.filter((c) => c.status === 'runs');
const checked = runnable.filter((c) => checkExemption(c) === undefined);

describe('the handbook\'s engine claims — lockstep with the Rust engine', () => {
  it('chapters declare engine claims (the guard has something to hold)', () => {
    expect(claims.length).toBeGreaterThan(0);
  });

  it('claimed constructs are unique across chapters', () => {
    const constructs = claims.map((c) => c.construct);
    expect(new Set(constructs).size).toBe(constructs.length);
  });

  it('the captured fixture covers every adapter the chapters construct', () => {
    for (const adapter of ['email', 'attio', 'slack', 'manual', 'cron']) {
      expect(CAPTURED_ADAPTERS).toContain(adapter);
    }
  });

  it('every exemption names a probe that exists (no stale exemptions)', () => {
    for (const entry of CHECK_EXEMPT) {
      const claim = runnable.find((c) => c.construct.includes(entry.match));
      if (!claim) throw new Error(`stale exemption: no runnable probe includes "${entry.match}"`);
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  it('the check covers the overwhelming majority of runnable examples', () => {
    // A floor, so coverage can only ever ratchet up. It stood at ONE when two
    // retired constructs rotted across ~87 occurrences.
    expect(checked.length).toBeGreaterThanOrEqual(35);
    expect(runnable.length - checked.length).toBeLessThanOrEqual(CHECK_EXEMPT.length);
  });

  it.each(claims.map((c) => [c.chapter, c.construct, c] as const))('%s — probe for "%s" parses', (_chapter, _construct, claim) => {
    expect(() => parseProbe(claim)).not.toThrow();
  });

  it.each(checked.map((c) => [c.chapter, c.construct, c] as const))(
    '%s claims "%s" runs — the engine admits it',
    (_chapter, _construct, claim) => {
      expect(() => admitProbe(claim)).not.toThrow();
    },
  );

  it.each(claims.flatMap((c) => (c.status === 'pending' ? [[c.chapter, c.construct, c] as const] : [])))(
    '%s claims "%s" does not run — the engine still refuses it (a lift here means: update the chapter)',
    (_chapter, _construct, claim) => {
      expect(() => admitProbe(claim)).toThrow(/failed checking/);
    },
  );
});
