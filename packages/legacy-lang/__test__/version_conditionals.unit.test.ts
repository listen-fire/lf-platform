// The legacy packages read integer pins only: a legacy id, or '5', this copy's
// dialect of the 0.12 surface. A release's semver reaching them is a routing
// bug in the platform, refused at the entry rather than read as 5.

import { LANGUAGE_VERSION } from 'movement-lang/language_version';

import { LegacyPinRefused, assertLegacyDialect, legacyVersionNumber, pastLegacy } from '../version_conditionals';
import { CURRENT_LANGUAGE_VERSION } from '../language_version';

describe('legacyVersionNumber', () => {
  it('refuses a release pin, naming the route', () => {
    expect(() => legacyVersionNumber('0.12.0-rc.8')).toThrow(LegacyPinRefused);
    expect(() => legacyVersionNumber('0.12.0-rc.8')).toThrow(
      'the legacy packages read the integer pins; route 0.12.0-rc.8 through apps/api/src/services/translation_graph/movement/language_route.ts',
    );
    expect(() => legacyVersionNumber(LANGUAGE_VERSION)).toThrow(LegacyPinRefused);
  });

  it('reads the integer pins', () => {
    expect(legacyVersionNumber('4')).toBe(4);
    expect(legacyVersionNumber('5')).toBe(5);
    expect(legacyVersionNumber(3)).toBe(3);
  });
});

describe('assertLegacyDialect', () => {
  it('passes the integer pins and refuses a semver', () => {
    expect(() => assertLegacyDialect('4')).not.toThrow();
    expect(() => assertLegacyDialect(CURRENT_LANGUAGE_VERSION)).not.toThrow();
    expect(() => assertLegacyDialect('0.13.0')).toThrow(LegacyPinRefused);
  });
});

describe('CURRENT_LANGUAGE_VERSION', () => {
  it("is the dialect '5', not the installed release", () => {
    expect(CURRENT_LANGUAGE_VERSION).toBe('5');
  });
});

describe('pastLegacy', () => {
  it('is true for any release pin, whatever its line', () => {
    expect(pastLegacy('0.13.0', 3)).toBe(true);
    expect(pastLegacy('2', 3)).toBe(false);
  });
});
