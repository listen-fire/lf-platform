// The version conditionals of the TypeScript checker, parser and service: the
// platform's copy of the language keeps the integer versions 1 to 5, and these
// are how a construct asks which one it is under. The language's own package
// has none.
//
// A pin reaches them as text: a legacy id ('1'..'4'), or the semver of the
// language release a movement was written against. The integer 5 of this copy
// is the 0.12 line (the migration that made pins text turned 5 into '0.12.0'),
// so a pin of that line reads as 5 here. No other release's pin has a meaning
// in this copy: one that reaches it is a routing bug, and refused loudly.

import { compatibilityKey, type LanguageVersion } from 'movement-lang/language_version';

/** The language line this copy's integer 5 is. */
const VERSION_5_LINE = '0.12';

/** The integer this copy of the language reads `pin` as. The corpora, written
 *  when a pin was an integer, still hand one in at run time. */
export function legacyVersionNumber(pin: LanguageVersion | number): number {
  if (typeof pin === 'number') return pin;
  if (/^\d+$/.test(pin)) return Number(pin);
  if (compatibilityKey(pin) === VERSION_5_LINE) return 5;
  throw new Error(
    `the legacy language packages read versions 1 to 5 (5 is the ${VERSION_5_LINE} line); the pin ${pin} must be routed to the installed language instead`,
  );
}

/** `version` has (or postdates) the behaviour version `n` introduced. */
export function since(version: LanguageVersion, n: number): boolean {
  return legacyVersionNumber(version) >= n;
}

/** `version` predates the behaviour version `n` introduced. */
export function before(version: LanguageVersion, n: number): boolean {
  return legacyVersionNumber(version) < n;
}

/** Moving a program from version `from` to `to` crosses the behaviour
 *  version `n` introduced — where a warning that a construct changed meaning
 *  belongs. */
export function changedBetween(from: LanguageVersion, to: LanguageVersion, n: number): boolean {
  return before(from, n) && since(to, n);
}

/**
 * For the AST readers only (a scan over a parsed program, never a verdict):
 * `pin` has the behaviour legacy version `n` introduced. A release pin is past
 * every legacy behaviour, whatever its line, so a reader can serve any pin the
 * installed language parses without this copy giving that pin an integer.
 */
export function pastLegacy(pin: LanguageVersion, n: number): boolean {
  return /^\d+$/.test(pin) ? Number(pin) >= n : true;
}
