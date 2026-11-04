// An import is allowed only between files on the same compatibility key. Each
// version reads and runs a program in its own meaning, so a library on
// another version can be neither checked nor run as part of the importer:
// reading it under the importer's version would report problems that are not
// its own, and running it there would run it in a meaning it was not written
// in. The catalog keeps such a library out of what an import resolves to
// (./catalog.ts), and the check says why, naming both pins. A carried version
// holds its own programs to the same rule, with the same answer for legacy ids
// (`@listen-fire/lang-<key>`).
//
// Because of the rule, files connected by imports move between versions
// together: an upgrade moves the whole import group, or nothing
// (`importGroupOf`, ./language_upgrade.ts), so it never stops an importer.

import { compatibilityKey, type Diagnostic, type LanguageVersion, type Program } from 'movement-lang';
import { isLegacyLanguageVersion, referencedFileImports } from 'legacy-lang';

import type { MovementRow } from './store';

/** The diagnostic a library import across versions is reported under. */
export const IMPORT_ACROSS_VERSIONS = 'MOV_IMPORT_LANGUAGE_VERSION';

/** The key the legacy ids ('1' to '4') are on: they ran beside 0.12, and
 *  they join 0.12's entry with its run host. */
const LEGACY_IDS_KEY = '0.12';

/** The key two pins are compared by: a release's compatibility key, and
 *  0.12's for a legacy id. */
export function importKeyOf(pin: LanguageVersion): string {
  if (isLegacyLanguageVersion(pin)) return LEGACY_IDS_KEY;
  return compatibilityKey(pin) ?? pin;
}

/** Whether a program pinned to `importer` and a library pinned to `library`
 *  are on different versions, so the import is not allowed. */
export function onOtherVersions(importer: LanguageVersion, library: LanguageVersion): boolean {
  return importKeyOf(importer) !== importKeyOf(library);
}

/**
 * One error per library `program` reaches on another version: on the import
 * that names it, or at the top of the file when it is reached through another
 * library.
 */
export function importsAcrossVersions(
  program: Program,
  pin: LanguageVersion,
  across: ReadonlyMap<string, LanguageVersion>,
): Diagnostic[] {
  const direct = new Map(
    program.statements.flatMap((statement) =>
      statement.kind === 'import' && statement.source.kind === 'file' ? [[statement.source.path, statement.span] as const] : [],
    ),
  );
  return [...across].map(([path, libraryPin]) => {
    const span = direct.get(path);
    const reached = span === undefined ? ', through another library it imports,' : '';
    return {
      code: IMPORT_ACROSS_VERSIONS,
      message:
        `this automation is on language ${pin}, and the library '${path}' it imports${reached} is on language ${libraryPin}: ` +
        `a library is imported only by automations on its own language version. Upgrade them so both are on the same version.`,
      severity: 'error',
      span: span ?? { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
    };
  });
}

/**
 * The import group of `movement` among the team's `rows`: it, and every
 * automation and library on its version connected to it by imports, in either
 * direction and through any number of files. Each library comes before the
 * files that import it, so a member can be checked against the members it
 * imports as they will be once moved.
 */
export function importGroupOf(movement: MovementRow, rows: readonly MovementRow[]): MovementRow[] {
  const key = importKeyOf(movement.languageVersion);
  const onVersion = new Map(rows.filter((row) => importKeyOf(row.languageVersion) === key).map((row) => [row.name, row]));
  onVersion.set(movement.name, movement);
  const imports = new Map(
    [...onVersion.values()].map((row) => [row.name, referencedFileImports(row.source).filter((path) => onVersion.has(path))]),
  );
  const neighbours = new Map<string, Set<string>>([...onVersion.keys()].map((name) => [name, new Set<string>()]));
  for (const [name, paths] of imports) {
    for (const path of paths) {
      neighbours.get(name)?.add(path);
      neighbours.get(path)?.add(name);
    }
  }
  const connected = new Set<string>([movement.name]);
  const frontier = [movement.name];
  for (let name = frontier.pop(); name !== undefined; name = frontier.pop()) {
    for (const next of neighbours.get(name) ?? []) {
      if (connected.has(next)) continue;
      connected.add(next);
      frontier.push(next);
    }
  }
  // Libraries first: each file after everything it imports (a cycle, which
  // the checker reports, is broken where the walk meets it).
  const ordered: MovementRow[] = [];
  const placed = new Set<string>();
  const place = (name: string): void => {
    if (placed.has(name)) return;
    placed.add(name);
    for (const path of imports.get(name) ?? []) if (connected.has(path)) place(path);
    const row = onVersion.get(name);
    if (row !== undefined) ordered.push(row);
  };
  for (const name of [...connected].sort()) place(name);
  return ordered;
}
