// An empty identity key is no key, at every pin. Version 1 ("Quiet Heron")
// once matched "" like any other value; that branch is retired (ruling 20 of
// the repo split), so a version-1 run now decides the version-5 way.

import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

import { candidateIsAllExact, isBlankIdentityValue, type UniquenessConstraints } from 'engine-contracts/uniqueness';

const byName: UniquenessConstraints = { any: [{ all: [{ field: 'name' }] }] };

const exact = (languageVersion: number, asserted: string, candidate: string) =>
  candidateIsAllExact(byName, { asserted: { name: asserted }, candidate: { name: candidate }, languageVersion });

describe('a blank identity key', () => {
  it('is no key: it never matches, not even another blank', () => {
    expect(isBlankIdentityValue('', CURRENT_LANGUAGE_VERSION)).toBe(true);
    expect(isBlankIdentityValue('  ', CURRENT_LANGUAGE_VERSION)).toBe(true);
    expect(isBlankIdentityValue(null, CURRENT_LANGUAGE_VERSION)).toBe(true);
    expect(exact(CURRENT_LANGUAGE_VERSION, '', '')).toBe(false);
    expect(exact(CURRENT_LANGUAGE_VERSION, 'Acme', '')).toBe(false);
  });

  it('is no key in a version-1 run too: the version-1 branch is retired', () => {
    expect(isBlankIdentityValue('', 1)).toBe(true);
    expect(exact(1, '', '')).toBe(false);
  });
});
