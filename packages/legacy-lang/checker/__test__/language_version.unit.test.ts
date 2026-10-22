// Language versions: the table, the helpers, and the compile context's
// refusal of a pin this release cannot honour.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink } from '../check';
import { mockCatalog } from '../catalog';
import type { ResolveFile } from '../link';
import { storyOf } from '../../story/story';
import { LANGUAGE_VERSION } from 'movement-lang/language_version';
import { CURRENT_LANGUAGE_VERSION, DEPRECATED_LANGUAGE_VERSIONS, LANGUAGE_VERSIONS, LanguageVersionDiagnosticCodes as V, PLATFORM_DEPRECATED_LANGUAGE_VERSIONS, PLATFORM_SUPPORTED_LANGUAGE_VERSIONS, SUPPORTED_LANGUAGE_VERSIONS, THIS_RELEASE, describeLanguageVersion, languageVersionDiagnostic, languageVersionStanding, type LanguageRelease } from '../../language_version';
import { LegacyPinRefused, before, since } from '../../version_conditionals';

const catalog = mockCatalog({ adapters: {} });
const SOURCE = 'movement noop() {\n}\n';

describe('the versions table', () => {
  it("names each of this copy's integers once; the newest is its dialect of the 0.12 surface", () => {
    expect(LANGUAGE_VERSIONS.map((v) => [v.version, v.name])).toEqual([
      [1, 'Quiet Heron'],
      [2, 'Bright Otter'],
      [3, 'Steady Lynx'],
      [4, 'Luminous Owl'],
      [5, 'Dancing Wren'],
    ]);
    expect(CURRENT_LANGUAGE_VERSION).toBe('5');
    expect([...SUPPORTED_LANGUAGE_VERSIONS]).toEqual([1, 2, 3, 4, 5]);
    expect([...DEPRECATED_LANGUAGE_VERSIONS]).toEqual([]);
    expect(Math.max(...LANGUAGE_VERSIONS.map((v) => v.version))).toBe(THIS_RELEASE.current);
  });

  it('the platform reads the legacy ids 1 to 4 with this package; the installed language reads its own release', () => {
    expect([...PLATFORM_SUPPORTED_LANGUAGE_VERSIONS]).toEqual(['1', '2', '3', '4']);
    expect([...PLATFORM_DEPRECATED_LANGUAGE_VERSIONS]).toEqual([]);
  });

  it('since/before split at the version that introduced a behaviour', () => {
    expect(since('2', 2)).toBe(true);
    expect(since('1', 2)).toBe(false);
    expect(before('1', 2)).toBe(true);
    expect(before('2', 2)).toBe(false);
    expect(since('5', 5)).toBe(true);
    expect(() => since(LANGUAGE_VERSION, 5)).toThrow(LegacyPinRefused);
  });

  it('describes a known version by name and an unknown one by its integer', () => {
    expect(describeLanguageVersion(1)).toBe('"Quiet Heron" (1)');
    expect(describeLanguageVersion(9)).toBe('version 9');
  });
});

describe('standing against a release', () => {
  const next: LanguageRelease = {
    current: 3,
    supported: new Set([2, 3]),
    deprecated: new Set([2]),
  };

  it('every version the platform supports is clean; a release pin is refused, not answered', () => {
    for (const v of PLATFORM_SUPPORTED_LANGUAGE_VERSIONS) {
      expect(languageVersionStanding(v)).toBe('supported');
      expect(languageVersionDiagnostic(v)).toBeUndefined();
    }
    // The installed language's own pin is the platform's route to answer, not this copy's.
    expect(() => languageVersionStanding(LANGUAGE_VERSION)).toThrow(LegacyPinRefused);
    expect(() => languageVersionDiagnostic(LANGUAGE_VERSION)).toThrow(LegacyPinRefused);
  });

  it('a version outside the supported set is an error naming it and the fix', () => {
    const d = languageVersionDiagnostic('1', next);
    expect(d?.code).toBe(V.UNSUPPORTED);
    expect(d?.severity).toBeUndefined(); // absent ⇒ error
    expect(d?.message).toContain('"Quiet Heron" (1)');
    expect(d?.message).toContain('upgrade it to "Steady Lynx" (3)');
  });

  it('a deprecated version is a warning naming it and that it will be removed', () => {
    expect(languageVersionStanding('2', next)).toBe('deprecated');
    const d = languageVersionDiagnostic('2', next);
    expect(d?.code).toBe(V.DEPRECATED);
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain('"Bright Otter" (2)');
    expect(d?.message).toContain('will be removed');
  });

  it("the default release is this copy's: current is its integer 5, its dialect of the 0.12 surface", () => {
    expect(THIS_RELEASE.current).toBe(5);
    expect(languageVersionStanding(String(THIS_RELEASE.current))).toBe('supported');
  });
});

describe('the compile context', () => {
  it('defaults to the current version: nothing changes for a caller that passes none', () => {
    expect(checkProgram(parseProgram(SOURCE), catalog)).toEqual(
      checkProgram(parseProgram(SOURCE, { languageVersion: CURRENT_LANGUAGE_VERSION }), catalog, {
        languageVersion: CURRENT_LANGUAGE_VERSION,
      }),
    );
  });

  it('checks a supported older pin without a version diagnostic', () => {
    const codes = checkProgram(parseProgram(SOURCE, { languageVersion: '1' }), catalog, {
      languageVersion: 1,
    }).map((d) => d.code);
    expect(codes).not.toContain(V.UNSUPPORTED);
    expect(codes).not.toContain(V.DEPRECATED);
  });

  it('refuses an unsupported pin rather than checking it as the current version', () => {
    const diagnostics = checkProgram(parseProgram(SOURCE), catalog, { languageVersion: '99' });
    expect(diagnostics[0].code).toBe(V.UNSUPPORTED);
    expect(diagnostics[0].message).toContain('version 99');
  });

  it('refuses through the linked path too', () => {
    const resolveFile: ResolveFile = () => undefined;
    const { diagnostics } = checkProgramWithLink(parseProgram(SOURCE), catalog, {
      resolveFile,
      languageVersion: '99',
    });
    expect(diagnostics.map((d) => d.code)).toContain(V.UNSUPPORTED);
  });

  it('the story carries the refusal', () => {
    const result = storyOf({ source: SOURCE, catalog, languageVersion: '99' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.story)).toContain(V.UNSUPPORTED);
  });
});
