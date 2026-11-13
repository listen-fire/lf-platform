// Which checker judges a movement, by its pin. A legacy id ('1'..'4') is
// legacy-lang's: its TypeScript checker and the TypeScript engine's
// interpretability scan. A pin of 0.12, whose engine this platform no longer
// carries, is legacy-lang's too: its frozen parser and checker read it in their
// dialect of the 0.12 surface, so it can still be judged and upgraded, and
// nothing presents or runs it. Any other release pin chooses a carried version
// by its compatibility key (`@listen-fire/language-versions`):
//   - the current version's pin is the wasm's, against the run snapshot: the
//     check its run on the Rust engine enforces, so the verdict an author sees
//     is the one the run holds;
//   - a carried version that checks is its own checker's, through its package,
//     against its own catalog (`carried_check.ts`): never this release's
//     checker, which would read the text under a grammar it was not written in;
//   - a carried version that does not check, and a key this build does not
//     carry, are refused alike with the language's own text, and nothing
//     reads them.
//
// Every verdict, the story and the editor's answers on a pin go through here;
// no caller hands a semver to legacy-lang's checker or the interpretability scan.

import {
  RustCheckRefused,
  checkSourceInRust,
  compatibilityKey,
  fromCatalogSnapshot,
  languageVersionDiagnostic,
  neverAsAny,
  parseProgram,
  resolveFileFromSnapshot,
  type Catalog,
  type CatalogSnapshot,
  type Diagnostic,
  type LanguageVersion,
  type Program,
  type ResolveFile,
} from 'movement-lang';
import { isLegacyLanguageVersion, upgradeWarnings, withUpgradeWarnings } from 'legacy-lang';
import { checkingOf, type CheckingLane } from '@listen-fire/language-versions';

export type PinRoute =
  | { kind: 'legacy'; pin: LanguageVersion }
  /** A release this platform no longer runs: judged under legacy-lang's
   *  `dialect`, presented by nothing, refused everywhere else with
   *  `diagnostic`. */
  | { kind: 'dropped'; pin: LanguageVersion; dialect: LanguageVersion; diagnostic: Diagnostic }
  | { kind: 'installed'; pin: LanguageVersion }
  | { kind: 'carried'; pin: LanguageVersion; lane: () => Promise<CheckingLane> }
  | { kind: 'refused'; diagnostic: Diagnostic };

export function routeOf(pin: LanguageVersion): PinRoute {
  if (isLegacyLanguageVersion(pin)) return { kind: 'legacy', pin };
  if (compatibilityKey(pin) === DROPPED_RELEASE_KEY) return { kind: 'dropped', pin, dialect: LEGACY_UPGRADE_DIALECT, diagnostic: refusalOf(pin) };
  const checking = checkingOf(pin);
  switch (checking.kind) {
    case 'current':
      return { kind: 'installed', pin };
    case 'carried':
      return { kind: 'carried', pin, lane: checking.lane };
    case 'held':
      return { kind: 'refused', diagnostic: refusalOf(pin) };
    default:
      return neverAsAny(checking);
  }
}

/** The installed language's refusal of a pin it does not read. */
function refusalOf(pin: LanguageVersion): Diagnostic {
  const diagnostic = languageVersionDiagnostic(pin);
  if (diagnostic === undefined) throw new Error(`the installed language neither reads nor refuses the pin '${pin}'`);
  return diagnostic;
}

/** The compatibility key of the release whose engine this platform carried
 *  until it dropped it: its pins are read by legacy-lang's frozen parser,
 *  whose dialect of the same surface keeps them checkable and upgradable. */
export const DROPPED_RELEASE_KEY = '0.12';

/** Whether this release reads `pin` only through legacy-lang's frozen parser
 *  (a legacy id, or a release it dropped): it runs nothing on it, and a
 *  deploy names it until it is upgraded. */
export function readOnlyByFrozenParser(pin: LanguageVersion): boolean {
  const kind = routeOf(pin).kind;
  return kind === 'legacy' || kind === 'dropped';
}

/**
 * legacy-lang's own integer for the 0.12 surface: the target of a legacy →
 * installed move's upgrade warnings, and what a dropped 0.12 pin is judged
 * under. No presentation surface reads a pin as it.
 */
export const LEGACY_UPGRADE_DIALECT = '5';

/**
 * The wasm checker's diagnostics for `source` under an installed pin, against
 * the run snapshot. A move up from a legacy id adds what changed meaning on the
 * way, which only legacy-lang's checker can say (no release reads a legacy id);
 * its program, catalog and file resolver default to the snapshot's.
 */
export function checkInstalled(input: {
  source: string;
  snapshot: CatalogSnapshot;
  pin: LanguageVersion;
  upgradingFrom?: LanguageVersion;
  program?: Program;
  catalog?: Catalog;
  resolveFile?: ResolveFile;
}): Diagnostic[] {
  const { source, snapshot, pin, upgradingFrom } = input;
  const fromLegacy = upgradingFrom !== undefined && isLegacyLanguageVersion(upgradingFrom);
  let checked: Diagnostic[];
  try {
    checked = checkSourceInRust(source, snapshot, {
      languageVersion: pin,
      ...(upgradingFrom !== undefined && !fromLegacy ? { upgradingFrom } : {}),
    });
  } catch (error) {
    if (!(error instanceof RustCheckRefused)) throw error;
    return [{ code: 'MOV_PARSE', message: error.message, span: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } } }];
  }
  if (!fromLegacy) return checked;
  const resolveFile = input.resolveFile ?? resolveFileFromSnapshot(snapshot);
  return withUpgradeWarnings(
    checked,
    upgradeWarnings(input.program ?? parseProgram(source, { languageVersion: pin }), input.catalog ?? fromCatalogSnapshot(snapshot), {
      languageVersion: LEGACY_UPGRADE_DIALECT,
      upgradingFrom,
      ...(resolveFile !== undefined ? { resolveFile } : {}),
    }),
  );
}
