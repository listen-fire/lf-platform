// The files a 0.15 program imports, and the rule that an import is allowed
// only between files on the same compatibility key. A file on another version
// is not offered to this release's checker at all: reading it under 0.15 would
// report problems that are not its own, and running it would run it under a
// meaning it was not written in. The platform holds the current version's
// programs to the same rule, with the same answer for legacy ids.

import { LANGUAGE_VERSION, compatibilityKey, parseProgram, type Program, type Span } from '@listen-fire/movement-lang';

import type { CheckedDiagnostic, TeamFile } from './types';

/** The diagnostic a library import across versions is reported under. */
export const IMPORT_ACROSS_VERSIONS = 'MOV_IMPORT_LANGUAGE_VERSION';

function fileImportsOf(program: Program): { path: string; span: Span }[] {
  return program.statements.flatMap((statement) =>
    statement.kind === 'import' && statement.source.kind === 'file' ? [{ path: statement.source.path, span: statement.span }] : [],
  );
}

function sourceImports(source: string, pin: string): string[] {
  try {
    return fileImportsOf(parseProgram(source, { languageVersion: pin })).map((i) => i.path);
  } catch {
    // A library that does not parse imports nothing this walk can see; the
    // checker reports it when it reads the library.
    return [];
  }
}

/** The pins from before the language was versioned by its release. They ran
 *  beside 0.15 and join its line, so 0.15's parser does not name them. */
const LEGACY_IDS: ReadonlySet<string> = new Set(['1', '2', '3', '4']);

/** The key two pins are compared by: a release's compatibility key, and this
 *  line's key for a legacy id. */
export function importKeyOf(pin: string): string {
  if (LEGACY_IDS.has(pin)) return ownKey();
  return compatibilityKey(pin) ?? pin;
}

function ownKey(): string {
  const key = compatibilityKey(LANGUAGE_VERSION);
  if (key === undefined) throw new Error(`language ${LANGUAGE_VERSION} has no compatibility key`);
  return key;
}

/** The pin a file on this line is read under: its own, or the importer's
 *  for a legacy id. */
export function readingPin(file: string, importer: string): string {
  return LEGACY_IDS.has(file) ? importer : file;
}

export interface ImportClosure {
  /** The files on the program's own version, by import path: what its
   *  imports resolve against. */
  files: Record<string, { source: string }>;
  /** Each import, direct or not, of a file on another version. */
  diagnostics: CheckedDiagnostic[];
}

/**
 * The import closure of `program` among the team's `files`. A file on another
 * version stops the walk there and is reported on the program's own import
 * it was reached through, naming both pins.
 */
export function importClosure(program: Program, pin: string, files: readonly TeamFile[]): ImportClosure {
  const byName = new Map(files.map((file) => [file.name, file]));
  const own = importKeyOf(pin);
  const resolved: Record<string, { source: string }> = {};
  const diagnostics: CheckedDiagnostic[] = [];
  const seen = new Set<string>();
  for (const direct of fileImportsOf(program)) {
    const frontier: { path: string; via: string[] }[] = [{ path: direct.path, via: [] }];
    while (frontier.length > 0) {
      const next = frontier.shift();
      if (next === undefined || seen.has(next.path)) continue;
      seen.add(next.path);
      const file = byName.get(next.path);
      if (file === undefined) continue;
      if (importKeyOf(file.languageVersion) !== own) {
        const through = next.via.length > 0 ? ` (through ${next.via.map((p) => `'${p}'`).join(', ')})` : '';
        diagnostics.push({
          code: IMPORT_ACROSS_VERSIONS,
          message:
            `this automation is on language ${pin}, and the library '${next.path}' it imports${through} is on language ${file.languageVersion}: ` +
            `a library is imported only by automations on its own language version. Upgrade them so both are on the same version.`,
          severity: 'error',
          span: direct.span,
        });
        continue;
      }
      resolved[next.path] = { source: file.source };
      for (const nested of sourceImports(file.source, readingPin(file.languageVersion, pin))) {
        frontier.push({ path: nested, via: [...next.via, next.path] });
      }
    }
  }
  return { files: resolved, diagnostics };
}
