// Which checker judges a movement, by its pin. A legacy id ('1'..'4') is
// legacy-lang's: its TypeScript checker and the TypeScript engine's
// interpretability scan. A release pin the installed language reads is the
// wasm's, against the run snapshot: the check its run on the Rust engine
// enforces, so the verdict an author sees is the one the run holds. Any other
// pin is refused with the language's own text, and nothing reads it.
//
// Every verdict on a current pin goes through here; no caller hands a semver
// to legacy-lang's checker or legacy-engine's scan. Presentation (completion,
// hover, definition, the story) is not here: it follows `routeOf`'s kind, the
// wasm for an installed pin and legacy-lang under its own id for a legacy one.

import {
  LANGUAGE_VERSION,
  RustCheckRefused,
  checkSourceInRust,
  compatible,
  fromCatalogSnapshot,
  languageVersionDiagnostic,
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

export type PinRoute =
  | { kind: 'legacy'; pin: LanguageVersion }
  | { kind: 'installed'; pin: LanguageVersion }
  | { kind: 'refused'; diagnostic: Diagnostic };

export function routeOf(pin: LanguageVersion): PinRoute {
  if (isLegacyLanguageVersion(pin)) return { kind: 'legacy', pin };
  if (compatible(pin, LANGUAGE_VERSION)) return { kind: 'installed', pin };
  const diagnostic = languageVersionDiagnostic(pin);
  if (diagnostic === undefined) {
    throw new Error(`the installed language neither reads nor refuses the pin '${pin}'`);
  }
  return { kind: 'refused', diagnostic };
}

/**
 * legacy-lang's own integer for the 0.12 surface: the target of a legacy →
 * installed move's upgrade warnings, and the only 5 left in the platform. No
 * presentation surface reads a pin as it.
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
