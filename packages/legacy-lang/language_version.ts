// A pin is text: a legacy id '1'..'4', or the semver of the language release a
// movement was written against (movement-lang/language_version: the rule that
// says which release reads which pin). The legacy ids are this package's: the
// frozen parser reads them, this package's checker checks them and the
// TypeScript engine runs them, until those movements are upgraded.
//
// Inside, this copy of the language still speaks the integers 1 to 5 it was
// written in (version_conditionals.ts maps a pin to one), and keeps the table
// of them below: the checker's texts name a version by it, and the conformance
// corpora, written when one table served both the language and the platform,
// read it at this path by the language's old names.

import {
  LANGUAGE_VERSION,
  languageVersionDiagnostic as languageVersionDiagnosticOf,
  languageVersionStanding as languageVersionStandingOf,
  RUN_HOST_UNITS,
  type LanguageVersion,
  type LanguageVersionStanding as LanguageStanding,
} from 'movement-lang/language_version';
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

/** What an entry point given no version reads under: the installed language.
 *  A conformance setup makes it the corpus's integer. */
export const CURRENT_LANGUAGE_VERSION: LanguageVersion = LANGUAGE_VERSION;

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

/** A legacy pin's standing in this copy's release, or a release pin's by the
 *  installed language's rule. */
export type LanguageVersionStanding = 'supported' | 'deprecated' | 'unsupported' | LanguageStanding;

export const LanguageVersionDiagnosticCodes = {
  UNSUPPORTED: 'MOV_LANGUAGE_VERSION_UNSUPPORTED',
  DEPRECATED: 'MOV_LANGUAGE_VERSION_DEPRECATED',
} as const;

/** A pin that is not an integer is a release's version, and the installed
 *  language's rule answers for it; an integer is read in this copy's own
 *  versions, against `release`. */
function releasePin(pin: LanguageVersion | number): LanguageVersion | undefined {
  return typeof pin === 'string' && !/^\d+$/.test(pin) ? pin : undefined;
}

export function languageVersionStanding(
  pin: LanguageVersion | number,
  release: LanguageRelease = THIS_RELEASE,
): LanguageVersionStanding {
  const semver = releasePin(pin);
  if (semver !== undefined) return languageVersionStandingOf(semver);
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
  const semver = releasePin(pin);
  if (semver !== undefined) return languageVersionDiagnosticOf(semver);
  const span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };
  const current = describeLanguageVersion(release.current);
  const standing = languageVersionStanding(pin, release);
  switch (standing) {
    case 'supported':
    case 'compatible':
      return undefined;
    case 'unsupported':
    case 'newer':
    case 'olderKey':
    case 'malformed':
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
