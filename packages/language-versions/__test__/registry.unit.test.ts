import * as lang012 from '@listen-fire/lang-0.12';
import { LANGUAGE_VERSION } from 'movement-lang';
import * as currentErrors from 'movement-engine/public/errors';

import {
  carriedVersions,
  checkingOf,
  currentVersion,
  importKeyOf,
  isCurrent,
  listeningOf,
  providedFlagsFor,
  refusalOf,
  resumeRefusal,
  resumingOf,
  runRefusal,
  runningOf,
  verifyCarriedVersions,
  versionOf,
  versionOfLegacyId,
} from '..';

describe('the language versions this build carries', () => {
  it('a 0.12 pin belongs to the 0.12 entry, whichever 0.12 release wrote it', () => {
    for (const pin of ['0.12.0', '0.12.13', '0.12.99']) {
      expect(versionOf(pin)).toMatchObject({ key: '0.12', release: '0.12.13' });
    }
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

  it('0.12 is checked and run by its own packages', async () => {
    const running = runningOf('0.12.0');
    expect(running.kind).toBe('carried');
    if (running.kind !== 'carried') return;
    const lane = await running.lane();
    expect(typeof lane.runSegment).toBe('function');
    expect(runRefusal('0.12.0')).toBeUndefined();
  });

  it('0.12 checks and resumes by its own lane; its listens are held, refused by what they are', async () => {
    const checking = checkingOf('0.12.0');
    expect(checking.kind).toBe('carried');
    if (checking.kind !== 'carried') return;
    expect(typeof (await checking.lane()).checkSource).toBe('function');
    const resuming = resumingOf('0.12.0');
    expect(resuming.kind).toBe('carried');
    if (resuming.kind !== 'carried') return;
    expect(typeof (await resuming.lane()).drainDueTimers).toBe('function');
    expect(listeningOf('0.12.0')).toEqual({ kind: 'held' });
    expect(isCurrent('0.12.0')).toBe(false);
    expect(resumeRefusal('0.12.4')).toBeUndefined();
    expect(refusalOf('0.12.4', 'listen')).toMatch(/but not to fire its listens/);
    expect(providedFlagsFor('0.12.4')).toEqual({ check: true, run: true, resume: true, listen: false });
    expect(refusalOf('0.12.4', 'listen')).toContain('to check, run and resume its automations');
  });

  it('a key no entry carries and a text that is no version belong to none, and are refused in the language\'s own text', () => {
    for (const pin of ['0.13.0', '0.14.2', '1.0.0', 'latest']) {
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

  it("legacy ids share 0.12's key, as they ran beside 0.12 in production, and no release's capabilities serve them", () => {
    for (const pin of ['1', '2', '3', '4']) {
      expect(versionOfLegacyId(pin)).toMatchObject({ key: '0.12' });
      expect(importKeyOf(pin)).toBe('0.12');
      expect(versionOf(pin)).toBeUndefined();
    }
    expect(importKeyOf('0.12.3')).toBe('0.12');
    expect(importKeyOf(LANGUAGE_VERSION)).toBe(currentVersion().key);
    expect(importKeyOf('5')).toBe('5');
    expect(versionOfLegacyId('0.12.0')).toBeUndefined();
  });

  it('carries each key once, the current one first', () => {
    const keys = carriedVersions().map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(carriedVersions()[0]).toBe(currentVersion());
  });

  it('every carried package set loads as the release its entry names', async () => {
    await expect(verifyCarriedVersions()).resolves.toBeUndefined();
    await expect(versionOf('0.12.0')!.load()).resolves.toMatchObject({ LANGUAGE_VERSION: '0.12.13' });
  });

  it("each version's error classes are its own: one version's throw is not the other's class", () => {
    expect(lang012.errors.MovementEngineError).not.toBe(currentErrors.MovementEngineError);
    expect(lang012.errors.RunCancelledSignal).not.toBe(currentErrors.RunCancelledSignal);
    expect(lang012.errors.RunLeaseLost).not.toBe(currentErrors.RunLeaseLost);
    const thrownBy012 = new lang012.errors.MovementEngineError('MOVENG_UNSUPPORTED', 'from 0.12');
    expect(thrownBy012).not.toBeInstanceOf(currentErrors.MovementEngineError);
  });
});
