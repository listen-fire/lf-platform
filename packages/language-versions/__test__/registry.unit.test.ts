import { LANGUAGE_VERSION } from 'movement-lang';

import {
  carriedVersions,
  checkingOf,
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

  it('carries the current version alone: 0.12 and the legacy ids are dropped, and 0.15 is carried only once 0.16 is current', () => {
    expect(carriedVersions()).toEqual([currentVersion()]);
  });

  it('every carried package set loads as the release its entry names', async () => {
    await expect(verifyCarriedVersions()).resolves.toBeUndefined();
  });
});
