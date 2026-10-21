// The version table is the language package's (movement-lang/language_version);
// this file adds the conditionals the TypeScript checker, parser and service
// branch on, and the platform's own table. It exists so a conformance corpus,
// written against the one module that held all of them, still finds them at
// that path.
//
// The language release names the versions it supports. The platform supports
// more: the versions the language has dropped that saved movements are still
// pinned to, read by the frozen parser (wasm/frozen_parser.ts) and checked
// and run by this package's checker and the TypeScript engine, until those
// movements are upgraded. A platform reader of a pin's standing reads this
// table, so a saved version 4 movement is never "unsupported" here.

import {
  CURRENT_LANGUAGE_VERSION,
  languageVersionDiagnostic as languageVersionDiagnosticOf,
  languageVersionStanding as languageVersionStandingOf,
  type LanguageRelease,
  type LanguageVersion,
  type LanguageVersionStanding,
} from 'movement-lang/language_version';
import type { Diagnostic } from 'movement-lang/checker/diagnostic';

export * from 'movement-lang/language_version';
export * from './version_conditionals';

/** The versions the platform parses, checks and runs. */
export const PLATFORM_SUPPORTED_LANGUAGE_VERSIONS: ReadonlySet<LanguageVersion> = new Set([1, 2, 3, 4, 5]);

/** Platform-supported versions that will be removed: they still run, with a warning. */
export const PLATFORM_DEPRECATED_LANGUAGE_VERSIONS: ReadonlySet<LanguageVersion> = new Set<LanguageVersion>();

/** What the platform declares about versions, in the shape a language release does. */
export const PLATFORM_RELEASE: LanguageRelease = {
  current: CURRENT_LANGUAGE_VERSION,
  supported: PLATFORM_SUPPORTED_LANGUAGE_VERSIONS,
  deprecated: PLATFORM_DEPRECATED_LANGUAGE_VERSIONS,
};

// The corpora were written when one table served both, and read it at this
// path by the language's names: here those names are the platform's table.
export const SUPPORTED_LANGUAGE_VERSIONS: ReadonlySet<LanguageVersion> = PLATFORM_SUPPORTED_LANGUAGE_VERSIONS;
export const DEPRECATED_LANGUAGE_VERSIONS: ReadonlySet<LanguageVersion> = PLATFORM_DEPRECATED_LANGUAGE_VERSIONS;
export const THIS_RELEASE: LanguageRelease = PLATFORM_RELEASE;

/** movement-lang's `languageVersionStanding`, asked of the platform by default. */
export function languageVersionStanding(
  version: LanguageVersion,
  release: LanguageRelease = PLATFORM_RELEASE,
): LanguageVersionStanding {
  return languageVersionStandingOf(version, release);
}

/** movement-lang's `languageVersionDiagnostic`, asked of the platform by default. */
export function languageVersionDiagnostic(
  version: LanguageVersion,
  release: LanguageRelease = PLATFORM_RELEASE,
): Diagnostic | undefined {
  return languageVersionDiagnosticOf(version, release);
}
