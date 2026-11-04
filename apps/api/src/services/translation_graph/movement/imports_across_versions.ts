// A library is imported only by programs on its own language version. Each
// version reads and runs a program in its own meaning, so a library on
// another version can be neither checked nor run as part of the importer:
// reading it under the importer's version would report problems that are not
// its own, and running it there would run it in a meaning it was not written
// in. The catalog keeps such a library out of what an import resolves to
// (./catalog.ts), and the check says why, naming both pins. A carried version
// holds its own programs to the same rule (`@listen-fire/lang-<key>`).
//
// Legacy ids ('1'..'4') are outside the rule: a release's checker reads a
// legacy library under the importer's version, as the upgrade from a legacy id
// has always relied on.

import { compatibilityKey, type Diagnostic, type LanguageVersion, type Program } from 'movement-lang';

/** The diagnostic a library import across versions is reported under. */
export const IMPORT_ACROSS_VERSIONS = 'MOV_IMPORT_LANGUAGE_VERSION';

/** Whether a program pinned to `importer` and a library pinned to `library`
 *  are on different release lines. */
export function onOtherVersions(importer: LanguageVersion, library: LanguageVersion): boolean {
  const importerKey = compatibilityKey(importer);
  const libraryKey = compatibilityKey(library);
  return importerKey !== undefined && libraryKey !== undefined && importerKey !== libraryKey;
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
