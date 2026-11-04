// One rule for imports across versions: an import is allowed only between
// files on the same compatibility key, and a legacy id is on 0.12's. The 0.12
// lane holds its programs to the same answer (`@listen-fire/lang-0.12`).

import { LANGUAGE_VERSION, compatibilityKey } from 'movement-lang';

import { importKeyOf, onOtherVersions } from '../imports_across_versions';

describe('the key an import is compared by', () => {
  it("is a release's compatibility key, and 0.12's for a legacy id", () => {
    expect(importKeyOf('0.12.4')).toBe('0.12');
    expect(['1', '2', '3', '4'].map(importKeyOf)).toEqual(['0.12', '0.12', '0.12', '0.12']);
    expect(importKeyOf(LANGUAGE_VERSION)).toBe(compatibilityKey(LANGUAGE_VERSION));
  });

  it('allows a legacy id and a 0.12 release to import each other, and nothing else across versions', () => {
    expect(onOtherVersions('4', '0.12.13')).toBe(false);
    expect(onOtherVersions('0.12.13', '2')).toBe(false);
    expect(onOtherVersions(LANGUAGE_VERSION, '4')).toBe(true);
    expect(onOtherVersions('4', LANGUAGE_VERSION)).toBe(true);
    expect(onOtherVersions(LANGUAGE_VERSION, '0.12.13')).toBe(true);
  });
});
