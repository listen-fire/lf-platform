// Checking a 0.12 program, and answering the editor about one, with 0.12's own
// checker and language service against 0.12's catalog snapshot: what
// production's `authoring.ts` and `language_service.ts` did at 0.12.13 for a
// pin it read (`checkInstalled`, `completionsAt`, `hoverAt`, `definitionAt`).

import {
  MovementParseError,
  RustCheckRefused,
  checkSourceInRust,
  compatibilityKey,
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

import { gapsOf, teamSnapshot } from './catalog';
import { importClosure } from './imports';
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

/** The 0.12 checker's verdict on `source`, under `pin`, against the team. */
export async function checkSource(request: CheckRequest): Promise<CheckedSource> {
  const { source, pin, team } = request;
  const program = parsed(source, pin);
  if (!('statements' in program)) return { diagnostics: [program], firedMovements: [], gaps: [], notes: [] };
  const closure = importClosure(program, pin, team.files);
  const { snapshot, notes, typed } = await teamSnapshot(team, closure.files);
  let diagnostics: CheckedDiagnostic[];
  try {
    diagnostics = checkSourceInRust(source, snapshot, { languageVersion: pin }).map(checked);
  } catch (error) {
    if (!(error instanceof RustCheckRefused)) throw error;
    diagnostics = [{ code: 'MOV_PARSE', message: error.message, severity: 'error', span: AT_START }];
  }
  const libraries = Object.entries(closure.files).flatMap(([name, file]) => {
    const pinOf = team.files.find((f) => f.name === name)?.languageVersion ?? pin;
    const library = parsed(file.source, pinOf);
    return 'statements' in library ? [library] : [];
  });
  return {
    diagnostics: [...closure.diagnostics, ...diagnostics],
    firedMovements: program.statements.flatMap((statement) => (statement.kind === 'listen' ? [statement.movement] : [])),
    gaps: gapsOf([program, ...libraries], { snapshot, notes, typed }),
    notes,
  };
}

/** The editor's snapshot: every file on the program's own version, so an
 *  import completes, as production's editor snapshot listed every saved file. */
async function editorSnapshot(request: EditorRequest) {
  const key = compatibilityKey(request.pin);
  const own = request.team.files.filter((file) => compatibilityKey(file.languageVersion) === key);
  return (await teamSnapshot(request.team, Object.fromEntries(own.map((file) => [file.name, { source: file.source }])))).snapshot;
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
