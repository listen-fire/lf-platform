import * as lang012 from '@listen-fire/lang-0.12';
import { LANGUAGE_VERSION } from 'movement-lang';
import * as currentErrors from 'movement-engine/public/errors';

import { capabilityOf, carriedVersions, currentVersion, verifyCarriedVersions, versionOf } from '..';

describe('the language versions this build carries', () => {
  it('a 0.12 pin belongs to the 0.12 entry, whichever 0.12 release wrote it', () => {
    for (const pin of ['0.12.0', '0.12.13', '0.12.99']) {
      expect(versionOf(pin)).toMatchObject({ key: '0.12', release: '0.12.13' });
    }
  });

  it('the current release pin belongs to the current entry, which checks and runs', () => {
    expect(versionOf(LANGUAGE_VERSION)).toBe(currentVersion());
    expect(currentVersion()).toMatchObject({ release: LANGUAGE_VERSION, check: { kind: 'current' }, run: { kind: 'current' } });
    expect(capabilityOf(LANGUAGE_VERSION, 'run')).toEqual({ kind: 'current' });
  });

  it('0.12 is carried, but neither checks nor runs yet: its pins are held', () => {
    expect(capabilityOf('0.12.0', 'check')).toEqual({ kind: 'held' });
    expect(capabilityOf('0.12.0', 'run')).toEqual({ kind: 'held' });
  });

  it('a key no entry carries, a legacy id and a text that is no version belong to none, and are held', () => {
    for (const pin of ['0.13.0', '0.14.2', '1.0.0', '4', '1', 'latest']) {
      expect(versionOf(pin)).toBeUndefined();
      expect(capabilityOf(pin, 'run')).toEqual({ kind: 'held' });
      expect(capabilityOf(pin, 'check')).toEqual({ kind: 'held' });
    }
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
