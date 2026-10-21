// The TypeScript engine's check (versions 1–4): the pin and the parse
// (`parsePinned`: the platform's version table and parser, since the language
// release no longer serves these versions), then the TypeScript checker with its
// file resolver, throwing MOVENG_LANGUAGE_VERSION, MOVENG_PARSE or
// MOVENG_CHECK. The TypeScript interpreter calls it in-process. A run on the
// Rust engine is held to the Rust checker instead (the engine package's
// program_check.ts); `checkAnswer` is this check as data, in the shape the
// Rust checker answers the engine's `check.program` with.
//
// The checker MUTATES the program it checks: it records on a write's spread
// the fields it stands for (`WriteSpread.fields`), on a graph's spread what
// it copies (`MapSpread.copy`), and on a graph entry whose value is a record
// that the entry is an edge holding it (`NodeEntry.reference`). The engine
// reads all three; program_check.unit pins that there are no others. A Rust engine
// re-parses the source, so those facts cross as STAMPS, each keyed by its
// node's place in the program's JSON — the AST path scheme:
//
//   path = a JSON Pointer (RFC 6901) from the Program object to the stamped
//          node, through the keys and array indices of the Program exactly
//          as the parser emits it: `/statements/2/body/0/write/spreads/1`.
//   file = absent for the program run; a library file's path for a stamp in
//          a file it imports (the same pointer, from that file's Program).
//
// The pointer is stable because the pinned source re-parses to the same
// tree (the Rust parser emits the TypeScript AST field for field), and the
// stamped keys are ones the parser never writes.
//
// A call nested in an expression (`FIRST(MAP(xs, (x) => …))`, language
// version 3) is read once per place by `parseNestedCall`, and the checker
// stamps that read. Its place continues the pointer through the slot it is
// written in: `<slot>/nested/<start>-<end>/value` is the right-hand side the
// call reads as, `start` and `end` its extent in the slot's text (UTF-16
// offsets, as the expression grammar gives them), so a stamp inside it is
// `…/value/expr/nested/0-31/value/call/args/1/closure/body/0/value/node/spreads/0`.
// The Rust engine re-reads the call from the slot to resolve one.

import { fromCatalogSnapshot, resolveFileFromSnapshot, CURRENT_LANGUAGE_VERSION } from 'movement-lang';
import { checkProgramWithLink, languageVersionDiagnostic } from 'legacy-lang';
import { nestedCallsReadIn } from 'movement-lang';
import { rustParseProgram } from 'legacy-lang/parser/rust_parser';

import type { Catalog, Diagnostic, ExprSlot, LinkedExport, Program, ResolveFile } from 'movement-lang';
import type { ProgramLink } from 'legacy-lang';

import { MovementEngineError } from 'movement-engine/public/errors';
import {
  throwIfBlocking,
  type CheckAnswer,
  type CheckInput,
  type LinkData,
  type LinkedImportData,
  type Stamp,
} from 'movement-engine/public/movement-engine';

export interface CheckedProgram {
  program: Program;
  catalog: Catalog;
  link?: ProgramLink;
  /** Every diagnostic, warnings and the runnable retirements included. */
  diagnostics: Diagnostic[];
  resolveFile?: ResolveFile;
}

/** The resolver file imports read: the snapshot's own files, captured with
 *  the catalog the program is checked against, so imports and instance
 *  schemas describe one moment of the workspace. A snapshot with no files
 *  resolves no import. */
export function fileResolverOf(input: Pick<CheckInput, 'catalog'>): ResolveFile | undefined {
  return resolveFileFromSnapshot(input.catalog);
}

/** The pin, the parse: MOVENG_LANGUAGE_VERSION or MOVENG_PARSE. The engine
 *  package's `parsePinned`, answered from the platform's version table and
 *  read by the parser for the pin's version. */
export function parsePinned(input: Pick<CheckInput, 'source' | 'languageVersion'>): Program {
  const languageVersion = input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  // The pin is answered before the source is read: a version the platform
  // cannot honour must fail as exactly that, not as whatever the current
  // grammar makes of the text.
  const versionDiagnostic = languageVersionDiagnostic(languageVersion);
  if (versionDiagnostic !== undefined && (versionDiagnostic.severity ?? 'error') === 'error') {
    throw new MovementEngineError('MOVENG_LANGUAGE_VERSION', versionDiagnostic.message, [versionDiagnostic]);
  }
  const parsed = rustParseProgram(input.source, languageVersion);
  if (!parsed.ok) {
    const { message, loc } = parsed.refusal;
    throw new MovementEngineError('MOVENG_PARSE', `${message} (line ${loc.line}, col ${loc.col})`);
  }
  return parsed.value;
}

/** Parse + check, throwing MOVENG_LANGUAGE_VERSION, MOVENG_PARSE or
 *  MOVENG_CHECK. Error severity only blocks: info diagnostics
 *  (MOV_LISTEN_MISSING — a dispatchable movement with no listen) never do.
 *  With the file resolver, the check RESOLVES file imports and the returned
 *  link is the engine's import structure. */
export function checkPinned(input: CheckInput, parsed?: Program): CheckedProgram {
  const languageVersion = input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  const program = parsed ?? parsePinned(input);
  const catalog = fromCatalogSnapshot(input.catalog);
  const resolveFile = fileResolverOf(input);
  const { diagnostics, link } = checkProgramWithLink(program, catalog, {
    languageVersion,
    ...(input.upgradingFrom !== undefined ? { upgradingFrom: input.upgradingFrom } : {}),
    ...(resolveFile !== undefined ? { resolveFile } : {}),
  });
  throwIfBlocking(diagnostics);
  return {
    program,
    catalog,
    diagnostics,
    ...(link !== undefined ? { link } : {}),
    ...(resolveFile !== undefined ? { resolveFile } : {}),
  };
}

/** What `checkPinned` found, as plain data a re-parse can be joined with. */
export function checkAnswer(checked: CheckedProgram): CheckAnswer {
  const stamps = stampsIn(checked.program);
  const link = checked.link;
  if (link === undefined) return { diagnostics: checked.diagnostics, stamps };
  const files: LinkData['files'] = [];
  for (const file of link.files.values()) {
    stamps.push(...stampsIn(file.program, file.path));
    const resolution = checked.resolveFile?.(file.path);
    if (resolution === undefined) {
      throw new MovementEngineError('MOVENG_RUNTIME', `the library "${file.path}" resolved for the check and not after it`);
    }
    files.push({
      path: file.path,
      source: resolution.source,
      imports: importsData(file.imports),
      exports: file.program.statements.flatMap((statement, index) =>
        (statement.kind === 'movement' || statement.kind === 'shape') && statement.exported === true
          ? [{ name: statement.name, kind: statement.kind, declaration: `/statements/${index}` }]
          : [],
      ),
    });
  }
  return { diagnostics: checked.diagnostics, link: { imports: importsData(link.imports), files }, stamps };
}

function importsData(imports: ReadonlyMap<string, LinkedExport>): LinkedImportData[] {
  return [...imports].map(([local, exported]) => {
    const index = exported.file.program.statements.indexOf(exported.declaration);
    if (index < 0) {
      throw new MovementEngineError('MOVENG_RUNTIME', `'${local}' names a declaration that is not a statement of "${exported.file.path}"`);
    }
    return { local, kind: exported.kind, name: exported.name, file: exported.file.path, declaration: `/statements/${index}` };
  });
}

/** The checker's stamps on `program`: a `fields` on a write's spread, a
 *  `copy` on a graph's, a `reference` on a graph entry — in the program and
 *  in each call nested in its expressions, as read for the check. No key the
 *  parser writes. */
function stampsIn(program: Program, file?: string): Stamp[] {
  const stamps: Stamp[] = [];
  const at = (path: string) => (file !== undefined ? { file, path } : { path });
  const visit = (node: unknown, path: string, inSpreads: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}/${i}`, inSpreads));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const fields: unknown = Reflect.get(node, 'fields');
    if (inSpreads && Array.isArray(fields) && fields.every((f) => typeof f === 'string')) {
      stamps.push({ ...at(path), spreadFields: fields });
    }
    const copy: unknown = Reflect.get(node, 'copy');
    if (copy !== undefined) stamps.push({ ...at(path), copy });
    const reference = Reflect.get(node, 'kind') === 'value' && Reflect.get(node, 'reference') === true;
    if (reference) stamps.push({ ...at(path), reference: true });
    for (const [key, child] of Object.entries(node)) {
      if (key === 'copy' || (inSpreads && key === 'fields') || (reference && key === 'reference')) continue;
      visit(child, `${path}/${pointerToken(key)}`, key === 'spreads');
    }
    if (isSlot(node)) {
      for (const read of nestedCallsReadIn(node)) visit(read.value, `${path}/nested/${read.at.start}-${read.at.end}/value`, false);
    }
  };
  visit(program, '', false);
  return stamps;
}

/** An expression's slot as the parser writes one. */
function isSlot(node: object): node is ExprSlot {
  return typeof Reflect.get(node, 'raw') === 'string' && typeof Reflect.get(node, 'span') === 'object';
}

/** RFC 6901's escaping of one reference token. */
function pointerToken(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}
