// A stored pin is text: a legacy id '1'..'4', or the semver of the language
// release a movement was written against. The legacy ids are this package's:
// the frozen parser reads them, this package's checker checks them and the
// TypeScript engine runs them, until those movements are upgraded. A semver is
// the installed language's, and the platform routes it there
// (apps/api/.../movement/language_route.ts); this package refuses one.
//
// Inside, this copy of the language still speaks the integers 1 to 5 it was
// written in, and keeps the table of them below: 1 to 4 are the legacy ids,
// and 5 is this copy's dialect of the 0.12 surface, never a stored pin (the
// platform reads a 0.12 movement by it for presentation, and aims upgrade
// warnings at it). The checker's texts name a version by the table, and the
// conformance corpora, written when one table served both the language and
// the platform, read it at this path by the language's old names.

import { RUN_HOST_UNITS, type LanguageVersion } from 'movement-lang/language_version';
import type { Diagnostic } from 'movement-lang/checker/diagnostic';
import { neverAsAny } from 'movement-lang/never';

import { legacyVersionNumber, since } from './version_conditionals';

export * from 'movement-lang/language_version';
export * from './version_conditionals';

/** A legacy id: a pin this package reads, checks and runs. */
export function isLegacyLanguageVersion(pin: LanguageVersion): boolean {
  return /^[1-4]$/.test(pin);
}

/** The pins the platform reads with this package; every other pin is the
 *  installed language's, by its rule. */
export const PLATFORM_SUPPORTED_LANGUAGE_VERSIONS: ReadonlySet<LanguageVersion> = new Set(['1', '2', '3', '4']);

/** Legacy ids that will be removed: they still run, with a warning. */
export const PLATFORM_DEPRECATED_LANGUAGE_VERSIONS: ReadonlySet<LanguageVersion> = new Set<LanguageVersion>();

/** What an entry point given no version reads under: this copy's dialect of
 *  the 0.12 surface. A conformance setup makes it the corpus's integer. */
export const CURRENT_LANGUAGE_VERSION: LanguageVersion = '5';

/** The units a file pinned to `pin` has in scope: none before version 5. */
export function runHostUnits(pin: LanguageVersion): readonly string[] {
  return since(pin, 5) ? RUN_HOST_UNITS : [];
}

// ---- This copy's integer versions.

export interface LanguageVersionInfo {
  version: number;
  name: string;
  is: string;
}

export const LANGUAGE_VERSIONS: readonly LanguageVersionInfo[] = [
  { version: 1, name: 'Quiet Heron', is: 'the language as of tag v0.6.0' },
  { version: 2, name: 'Bright Otter', is: 'the language from v0.7.0 through v0.9.1' },
  {
    version: 3,
    name: 'Steady Lynx',
    is: "the language from v0.10.0: a list literal is a tuple — exact at a literal index, a list of its members' union elsewhere",
  },
  {
    version: 4,
    name: 'Luminous Owl',
    is: 'the language from v0.11.0: a match yields absent on a miss, a write handle reaches its pre-write record through @old',
  },
  {
    version: 5,
    name: 'Dancing Wren',
    is: 'the 0.12 line: no engine-side store and no meta edges, a closure is a value, and `parallel` is retired',
  },
];

export function languageVersionInfo(version: LanguageVersion | number): LanguageVersionInfo | undefined {
  return LANGUAGE_VERSIONS.find((info) => String(info.version) === String(version));
}

/** `"Quiet Heron" (1)` — or `version 7` for a version this copy has never
 *  heard of. */
export function describeLanguageVersion(version: LanguageVersion | number): string {
  const info = languageVersionInfo(version);
  return info ? `"${info.name}" (${info.version})` : `version ${version}`;
}

/** What a release of this copy declared about its integer versions. */
export interface LanguageRelease {
  current: number;
  supported: ReadonlySet<number>;
  deprecated: ReadonlySet<number>;
}

export const SUPPORTED_LANGUAGE_VERSIONS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]);
export const DEPRECATED_LANGUAGE_VERSIONS: ReadonlySet<number> = new Set<number>();
export const THIS_RELEASE: LanguageRelease = {
  current: 5,
  supported: SUPPORTED_LANGUAGE_VERSIONS,
  deprecated: DEPRECATED_LANGUAGE_VERSIONS,
};

/** A version's standing in this copy's release. */
export type LanguageVersionStanding = 'supported' | 'deprecated' | 'unsupported';

export const LanguageVersionDiagnosticCodes = {
  UNSUPPORTED: 'MOV_LANGUAGE_VERSION_UNSUPPORTED',
  DEPRECATED: 'MOV_LANGUAGE_VERSION_DEPRECATED',
} as const;

export function languageVersionStanding(
  pin: LanguageVersion | number,
  release: LanguageRelease = THIS_RELEASE,
): LanguageVersionStanding {
  const version = legacyVersionNumber(pin);
  if (!release.supported.has(version)) return 'unsupported';
  if (release.deprecated.has(version)) return 'deprecated';
  return 'supported';
}

/**
 * What a movement pinned to `pin` must be told before anything else: an error
 * when it will not validate or run, a warning when it runs but will stop doing
 * so, nothing otherwise.
 */
export function languageVersionDiagnostic(
  pin: LanguageVersion | number,
  release: LanguageRelease = THIS_RELEASE,
): Diagnostic | undefined {
  const span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };
  const current = describeLanguageVersion(release.current);
  const standing = languageVersionStanding(pin, release);
  switch (standing) {
    case 'supported':
      return undefined;
    case 'unsupported':
      return {
        code: LanguageVersionDiagnosticCodes.UNSUPPORTED,
        message:
          `this automation is written in language version ${describeLanguageVersion(pin)}, ` +
          `which this release does not support, so it will not validate or run. ` +
          `To fix: validate it under ${current}, repair what that reports, and upgrade it to ${current}.`,
        span,
      };
    case 'deprecated':
      return {
        code: LanguageVersionDiagnosticCodes.DEPRECATED,
        message:
          `this automation is written in language version ${describeLanguageVersion(pin)}, ` +
          `which is deprecated and will be removed in a future release. ` +
          `Validate it under ${current}, repair what that reports, and upgrade it to ${current} before then.`,
        span,
        severity: 'warning',
      };
    default:
      return neverAsAny(standing);
  }
}
