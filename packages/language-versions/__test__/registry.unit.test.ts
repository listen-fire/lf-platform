import { LANGUAGE_VERSION, languageVersionDiagnostic } from 'movement-lang';

import {
  carriedVersions,
  checkingOf,
  correlatedAwaitsLane,
  currentVersion,
  importKeyOf,
  isCurrent,
  listeningOf,
  providedFlagsFor,
  untilUpgraded,
  refusalOf,
  resumeRefusal,
  resumingOf,
  runRefusal,
  runningOf,
  verifyCarriedVersions,
  versionOf,
} from '..';

describe('the language versions this build carries', () => {
  it('the current version is release 0.16.0, on key 0.16', () => {
    expect(LANGUAGE_VERSION).toBe('0.16.0');
    expect(currentVersion()).toMatchObject({ key: '0.16', release: '0.16.0' });
  });

  it('the current release pin belongs to the current entry, which checks and runs', () => {
    expect(versionOf(LANGUAGE_VERSION)).toBe(currentVersion());
    expect(currentVersion()).toMatchObject({
      release: LANGUAGE_VERSION,
      provides: { check: { kind: 'current' }, run: { kind: 'current' }, resume: { kind: 'current' }, listen: { kind: 'current' } },
    });
    expect(runningOf(LANGUAGE_VERSION)).toEqual({ kind: 'current' });
    expect(resumingOf(LANGUAGE_VERSION)).toEqual({ kind: 'current' });
    expect(listeningOf(LANGUAGE_VERSION)).toEqual({ kind: 'current' });
    expect(checkingOf(LANGUAGE_VERSION)).toEqual({ kind: 'current' });
    for (const needed of ['run', 'resume', 'listen'] as const) expect(refusalOf(LANGUAGE_VERSION, needed)).toBeUndefined();
    expect(isCurrent(LANGUAGE_VERSION)).toBe(true);
  });

  it('says what an automation does until it is upgraded, from what its version provides', () => {
    expect(untilUpgraded(LANGUAGE_VERSION)).toBe('its listens keep firing, and a run of it that waits (an ask, a pause) resumes');
    expect(untilUpgraded('0.14.0')).toBe('its listens do not fire, and a run of it that would wait (an ask, a pause) is stopped');
  });

  it('a key no entry carries and a text that is no version belong to none, and are refused in the language\'s own text', () => {
    for (const pin of ['0.12.0', '0.12.13', '0.13.0', '0.14.2', '1.0.0', 'latest']) {
      expect(versionOf(pin)).toBeUndefined();
      expect(runningOf(pin)).toEqual({ kind: 'held' });
      expect(resumingOf(pin)).toEqual({ kind: 'held' });
      expect(listeningOf(pin)).toEqual({ kind: 'held' });
      expect(checkingOf(pin)).toEqual({ kind: 'held' });
      expect(isCurrent(pin)).toBe(false);
      expect(runRefusal(pin)).not.toMatch(/this platform carries/);
      expect(providedFlagsFor(pin)).toEqual({ check: false, run: false, resume: false, listen: false });
    }
  });

  it('a 0.15 pin is carried as release 0.15.3: its own checker checks it, its own engine runs and resumes it, and its own lane fires its listens', () => {
    for (const pin of ['0.15.0', '0.15.3']) {
      expect(versionOf(pin)?.release).toBe('0.15.3');
      expect(isCurrent(pin)).toBe(false);
      expect(checkingOf(pin)).toEqual({ kind: 'carried', lane: expect.any(Function) });
      expect(runningOf(pin)).toEqual({ kind: 'carried', lane: expect.any(Function) });
      expect(resumingOf(pin)).toEqual({ kind: 'carried', lane: expect.any(Function) });
      expect(listeningOf(pin)).toEqual({ kind: 'carried', lane: expect.any(Function) });
      expect(versionOf(pin)?.listenRows).toEqual(expect.any(Function));
      expect(providedFlagsFor(pin)).toEqual({ check: true, run: true, resume: true, listen: true });
      for (const needed of ['run', 'resume', 'listen'] as const) expect(refusalOf(pin, needed)).toBeUndefined();
    }
    expect(untilUpgraded('0.15.3')).toBe('its listens keep firing, and a run of it that waits (an ask, a pause) resumes');
  });

  it("0.15's listen lane is its package's own planning, reading, judging and gate", async () => {
    const lane = await versionOf('0.15.3')?.listenRows?.();
    expect(lane).toBeDefined();
    expect(lane?.isListenRow({ config: { leftoverForUnfinishedRuns: true } })).toBe(false);
    for (const method of ['planListens', 'isListenRow', 'readDelivery', 'gateFiring', 'readEvent'] as const) expect(typeof lane?.[method]).toBe('function');
  });

  it('no carried version parks on keys or mints callbacks: 0.15 parks in the run host every version shares', () => {
    expect(correlatedAwaitsLane()).toBeUndefined();
  });

  it('legacy ids are carried by no entry, so every capability is held; they keep the key of 0.12, which they ran beside, for imports', () => {
    for (const pin of ['1', '2', '3', '4']) {
      expect(versionOf(pin)).toBeUndefined();
      expect(providedFlagsFor(pin)).toEqual({ check: false, run: false, resume: false, listen: false });
      expect(importKeyOf(pin)).toBe('0.12');
    }
    expect(importKeyOf('0.12.3')).toBe('0.12');
    expect(importKeyOf(LANGUAGE_VERSION)).toBe(currentVersion().key);
    expect(importKeyOf('5')).toBe('5');
  });

  it('carries the current version and 0.15: 0.12 and the legacy ids are dropped', () => {
    expect(carriedVersions().map((version) => version.key)).toEqual([currentVersion().key, '0.15']);
  });

  it('every carried package set loads as the release its entry names', async () => {
    await expect(verifyCarriedVersions()).resolves.toBeUndefined();
  });
});
