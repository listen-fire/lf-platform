// The version conditionals of the TypeScript checker, parser and service: the
// platform's copy of the language keeps the integer versions 1 to 5, and these
// are how a construct asks which one it is under. The language's own package
// has none.
//
// A pin reaches them as an integer: a legacy id ('1'..'4'), or '5', this copy's
// dialect of the 0.12 surface, which the platform hands in as the target of
// upgrade warnings only, never as a stored pin and never to a presentation
// surface (completion, hover, definition, the story: `assertLegacyPresentationPin`).
// A release's semver has no meaning here: the platform routes it to the
// installed language, and one that reaches this copy is a routing bug, refused
// loudly.

import type { LanguageVersion } from 'movement-lang/language_version';

/** The integer this copy spells the 0.12 surface as: the checker's upgrade
 *  target, never presented. */
const UPGRADE_TARGET = 5;

/** A release pin handed to the legacy packages, which read the integer pins only. */
export class LegacyPinRefused extends Error {
  constructor(
    readonly pin: string,
    message = `the legacy packages read the integer pins; route ${pin} through apps/api/src/services/translation_graph/movement/language_route.ts`,
  ) {
    super(message);
    this.name = 'LegacyPinRefused';
  }
}

/** The integer this copy of the language reads `pin` as. The corpora, written
 *  when a pin was an integer, still hand one in at run time. */
export function legacyVersionNumber(pin: LanguageVersion | number): number {
  if (typeof pin === 'number') return pin;
  if (/^\d+$/.test(pin)) return Number(pin);
  throw new LegacyPinRefused(pin);
}

/** The entry guard of the legacy checker, service, story and scan: a pin this
 *  copy cannot read is refused before any work, not midway through it. */
export function assertLegacyDialect(pin: LanguageVersion | number): void {
  legacyVersionNumber(pin);
}

/**
 * The entry guard of completion, hover, definition and the story. This copy
 * presents the legacy ids ('1'..'4'); a release pin is the installed language's,
 * and '5' is the checker's upgrade target, not a pin anyone presents, so both
 * are refused before any work. Any other integer is not the guard's to judge:
 * the checker reports an unsupported version by name, and the story carries
 * that report (the conformance corpora hold a pin of 99 to it).
 */
export function assertLegacyPresentationPin(pin: LanguageVersion | number): void {
  if (legacyVersionNumber(pin) !== UPGRADE_TARGET) return;
  throw new LegacyPinRefused(
    String(pin),
    `the legacy packages present only the legacy ids '1' to '4'; route ${pin} through apps/api/src/services/translation_graph/movement/language_route.ts to the installed language's service`,
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
