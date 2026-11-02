// A suite that runs one program under every language version writes it once,
// in the spelling versions 1–4 read, and checks a later run against the
// program the upgrade tool rewrites it to (the same loop `listen-fire upgrade`
// runs) — so a check always reads its own version's surface, and the
// spellings must answer the same. Only the respellings are applied: a fix for
// the error a test is about never is.
//
// A suite hands in its run's pin. Version 5 is respelled by this copy's
// TypeScript checker. A release pin is respelled twice, the way a saved
// program reached it: to the 0.12 surface by the TypeScript checker (its
// dialect '5'), then to the installed release by the published checker's
// upgrade fixes (`checkSourceInRust` with `upgradingFrom`, the check
// `listen-fire upgrade` makes). The second needs the run snapshot: a settings
// listen is rewritten by what its module says (`listenSettingsBecome`).

import {
  checkSourceInRust,
  fromCatalogSnapshot,
  RustCheckRefused,
  type CatalogSnapshot,
  type Diagnostic as ReleaseDiagnostic,
} from 'movement-lang';
import { parseProgram, MovementParseError } from '../../parser/parse';
import { checkProgram, type CheckOptions, type Diagnostic } from '../check';
import type { Catalog } from '../catalog';
import { spellingCheck, upgradeSource } from '../upgrade';
import type { LanguageVersion } from 'movement-lang/language_version';
import { before } from '../../version_conditionals';

const isRespelling = (d: Diagnostic): boolean => d.code.startsWith('MOV_V5_');

/** The release line before the installed one: what a release pin's program
 *  was written in before this suite's fixtures were respelled. */
const PREVIOUS_RELEASE: LanguageVersion = '0.12.0';

/** The installed release's respellings of a program written for the line
 *  before it. Each is a fix `listen-fire upgrade` applies. */
const isReleaseRespelling = (d: ReleaseDiagnostic): boolean =>
  d.code.startsWith('MOV_V5_') || d.code === 'MOV_LISTEN_SETTINGS_RETIRED';

const isSnapshot = (catalog: Catalog | CatalogSnapshot): catalog is CatalogSnapshot =>
  !('instantiate' in catalog && typeof catalog.instantiate === 'function');

/** `source` as `version` spells it. With a catalog, the respellings only a
 *  check can decide (a built-in read by its argument's type, a call's named
 *  arguments put in order) are applied too. A release pin is respelled to the
 *  installed release only when `catalog` is the run snapshot. */
export function spelledFor(
  pin: LanguageVersion,
  source: string,
  catalog?: Catalog | CatalogSnapshot,
  options: Omit<CheckOptions, 'languageVersion'> = {},
): string {
  const release = !/^\d+$/.test(String(pin));
  const version: LanguageVersion = release ? '5' : pin;
  if (before(version, 5)) return source;
  const forChecker = catalog === undefined ? undefined : isSnapshot(catalog) ? fromCatalogSnapshot(catalog) : catalog;
  const check =
    forChecker === undefined
      ? spellingCheck(version)
      : (text: string): Diagnostic[] => {
          try {
            return checkProgram(parseProgram(text, { languageVersion: version }), forChecker, { ...options, languageVersion: version });
          } catch (error) {
            if (error instanceof MovementParseError) return [];
            throw error;
          }
        };
  const surface = upgradeSource(source, (text) => check(text).filter(isRespelling), { all: true }).source;
  if (!release || catalog === undefined || !isSnapshot(catalog)) return surface;
  return upgradeSource(
    surface,
    (text) => {
      try {
        return checkSourceInRust(text, catalog, { languageVersion: pin, upgradingFrom: PREVIOUS_RELEASE }).filter(isReleaseRespelling);
      } catch (error) {
        if (error instanceof RustCheckRefused) return [];
        throw error;
      }
    },
    { all: true },
  ).source;
}
