// The version conditionals of the TypeScript checker, parser and service: the
// platform's copy of the language keeps versions 1 to 5, and these are how a
// construct asks which one it is under. The language's own package has none.

import type { LanguageVersion } from 'movement-lang/language_version';

/** `version` has (or postdates) the behaviour version `n` introduced. */
export function since(version: LanguageVersion, n: LanguageVersion): boolean {
  return version >= n;
}

/** `version` predates the behaviour version `n` introduced. */
export function before(version: LanguageVersion, n: LanguageVersion): boolean {
  return version < n;
}

/** Moving a program from version `from` to `to` crosses the behaviour
 *  version `n` introduced — where a warning that a construct changed meaning
 *  belongs. */
export function changedBetween(from: LanguageVersion, to: LanguageVersion, n: LanguageVersion): boolean {
  return before(from, n) && since(to, n);
}

