// Checking a 0.15 program, and answering the editor about one, with 0.15's own
// checker and language service against 0.15's catalog snapshot: what the
// platform's `authoring.ts` and `language_service.ts` do for the pin it reads
// (`checkInstalled`, `completionsAt`, `hoverAt`, `definitionAt`).

import {
  MovementParseError,
  RustCheckRefused,
  checkSourceInRust,
  completionsAt as completionsInWasm,
  definitionAt as definitionInWasm,
  diagnosticSeverity,
  hoverAt as hoverInWasm,
  parseProgram,
  type Completions,
  type Definition,
  type Diagnostic,
  type HoverCard,
  type Program,
} from '@listen-fire/movement-lang';

import { gapsOf, teamSnapshot, type TeamSnapshot } from './catalog';
import { importClosure, importKeyOf, readingPin, type ImportClosure } from './imports';
import type { CheckRequest, CheckedDiagnostic, CheckedSource, EditorRequest } from './types';

const AT_START = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

function checked(diagnostic: Diagnostic): CheckedDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnosticSeverity(diagnostic),
    span: diagnostic.span,
    ...(diagnostic.upgrade === true ? { upgrade: true as const } : {}),
    ...(diagnostic.fix !== undefined
      ? { fix: { edits: diagnostic.fix.edits.map((edit) => ({ span: edit.span, text: edit.text })), ...(diagnostic.fix.safe === true ? { safe: true as const } : {}) } }
      : {}),
  };
}

function parsed(source: string, pin: string): Program | CheckedDiagnostic {
  try {
    return parseProgram(source, { languageVersion: pin });
  } catch (error) {
    if (!(error instanceof MovementParseError)) throw error;
    return { code: 'MOV_PARSE', message: error.message, severity: 'error', span: { start: error.loc, end: error.loc } };
  }
}

/** A program read for a check or a story: its parse, the files it imports, and
 *  the team's snapshot for it; or the refusal of a text 0.15 cannot read. */
export type ReadProgram =
  | { readable: false; refusal: CheckedDiagnostic }
  | { readable: true; program: Program; closure: ImportClosure; libraries: Program[]; teamCatalog: TeamSnapshot };

export async function readProgram(request: CheckRequest): Promise<ReadProgram> {
  const { source, pin, team } = request;
  const program = parsed(source, pin);
  if (!('statements' in program)) return { readable: false, refusal: program };
  const closure = importClosure(program, pin, team.files);
  const pinOf = (name: string): string => readingPin(team.files.find((f) => f.name === name)?.languageVersion ?? pin, pin);
  const libraries = Object.entries(closure.files).flatMap(([name, file]) => {
    const library = parsed(file.source, pinOf(name));
    return 'statements' in library ? [library] : [];
  });
  const teamCatalog = await teamSnapshot({
    team,
    files: closure.files,
    sources: [{ source, pin }, ...Object.entries(closure.files).map(([name, file]) => ({ source: file.source, pin: pinOf(name) }))],
    ...(request.connected !== undefined ? { reading: { ...request.connected, programs: [program, ...libraries] } } : {}),
  });
  return { readable: true, program, closure, libraries, teamCatalog };
}

/** The 0.15 checker's verdict on `source`, under `pin`, against the team. */
export async function checkSource(request: CheckRequest): Promise<CheckedSource> {
  const read = await readProgram(request);
  if (!read.readable) return { diagnostics: [read.refusal], firedMovements: [], gaps: [], notes: [] };
  const { program, closure, libraries, teamCatalog } = read;
  let diagnostics: CheckedDiagnostic[];
  try {
    diagnostics = checkSourceInRust(request.source, teamCatalog.snapshot, { languageVersion: request.pin }).map(checked);
  } catch (error) {
    if (!(error instanceof RustCheckRefused)) throw error;
    diagnostics = [{ code: 'MOV_PARSE', message: error.message, severity: 'error', span: AT_START }];
  }
  return {
    diagnostics: [...closure.diagnostics, ...diagnostics],
    firedMovements: program.statements.flatMap((statement) => (statement.kind === 'listen' ? [statement.movement] : [])),
    gaps: gapsOf([program, ...libraries], teamCatalog),
    notes: teamCatalog.notes,
  };
}

/** The editor's snapshot: every file the program may import, so an import
 *  completes, as production's editor snapshot listed every saved file. */
async function editorSnapshot(request: EditorRequest) {
  const key = importKeyOf(request.pin);
  const own = request.team.files.filter((file) => importKeyOf(file.languageVersion) === key);
  const sources = [{ source: request.source, pin: request.pin }, ...own.map((file) => ({ source: file.source, pin: readingPin(file.languageVersion, request.pin) }))];
  return (await teamSnapshot({ team: request.team, files: Object.fromEntries(own.map((file) => [file.name, { source: file.source }])), sources })).snapshot;
}

export async function completionsAt(request: EditorRequest): Promise<Completions> {
  return completionsInWasm(request.source, request.offset, await editorSnapshot(request), { languageVersion: request.pin });
}

export async function hoverAt(request: EditorRequest): Promise<HoverCard | null> {
  return hoverInWasm(request.source, request.offset, await editorSnapshot(request), { languageVersion: request.pin });
}

export async function definitionAt(request: EditorRequest): Promise<Definition | null> {
  return definitionInWasm(request.source, request.offset, await editorSnapshot(request), { languageVersion: request.pin });
}
