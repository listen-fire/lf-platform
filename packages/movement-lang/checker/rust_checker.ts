// The Rust checker (crates/movement-checker), through the movement artifact's
// `check_program` export: the checker a program that runs on the Rust engine
// is held to, at its run and wherever it is validated for one. It reports the
// TypeScript checker's diagnostics, shape and order included (PARITY.md), and
// reads the catalog as the snapshot a run is handed, file imports resolving
// against the snapshot's `files`.
//
// It loads with the engine artifact, which a browser never downloads: the
// editor's live diagnostics stay on the TypeScript checker.

import { callCheckAnswer, callCheckCompatible, callCheckProgram } from '../wasm/loader';
import type { Loc, Span } from '../parser/ast';
import type { LanguageVersion } from '../language_version';
import type { CatalogSnapshot } from '../service/snapshot';
import type { Diagnostic } from './diagnostic';
import type { DiagnosticFix, SourceEdit } from './fixes';

export interface RustCheckOptions {
  languageVersion: LanguageVersion;
  /** Checking for a move up from this version (`CheckOptions.upgradingFrom`). */
  upgradingFrom?: LanguageVersion;
}

/** A source the Rust checker could not check: it does not parse, or the
 *  snapshot does not load. */
export class RustCheckRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RustCheckRefused';
  }
}

/** Every diagnostic the Rust checker reports for `source` against
 *  `snapshot`, warnings and info included. */
export function checkSourceInRust(source: string, snapshot: CatalogSnapshot, options: RustCheckOptions): Diagnostic[] {
  const reply = callCheckProgram(source, JSON.stringify(snapshot), options.languageVersion, options.upgradingFrom ?? 0);
  const json: unknown = reply.json;
  if (!reply.ok) throw refused(json);
  const diagnostics = isRecord(json) ? json.diagnostics : undefined;
  if (!Array.isArray(diagnostics)) throw new Error('the Rust checker answered no diagnostics');
  return diagnostics.map(diagnosticOf);
}

// ── The check as data ─────────────────────────────────────────────────────────

/** A checker fact about one node, keyed by its AST path (a JSON Pointer from
 *  the Program, `file` naming a library's): a write spread's field list, a
 *  graph spread's copy plan (as plain data), or that a graph entry is a
 *  reference. */
export type Stamp = { file?: string; path: string } & (
  | { spreadFields: readonly string[] }
  | { copy: unknown }
  | { reference: true }
);

/** What an import binds: a movement or a node declaration. */
export type LinkedKind = 'movement' | 'shape';

/** One imported name, its declaration an AST path into its file. */
export interface LinkedImportData {
  local: string;
  kind: LinkedKind;
  name: string;
  file: string;
  declaration: string;
}

export interface LinkData {
  imports: LinkedImportData[];
  files: Array<{
    path: string;
    source: string;
    imports: LinkedImportData[];
    exports: Array<{ name: string; kind: LinkedKind; declaration: string }>;
  }>;
}

/** The check as the engine's `check.program` request is answered: every
 *  diagnostic, the import link, the checker's stamps. */
export interface CheckAnswer {
  diagnostics: Diagnostic[];
  link?: LinkData;
  stamps: Stamp[];
}

/** `checkSourceInRust` as data (crates/movement-checker/src/answer.rs). */
export function checkAnswerInRust(source: string, snapshot: CatalogSnapshot, options: RustCheckOptions): CheckAnswer {
  const reply = callCheckAnswer(source, JSON.stringify(snapshot), options.languageVersion, options.upgradingFrom ?? 0);
  const json: unknown = reply.json;
  if (!reply.ok) throw refused(json);
  if (!isRecord(json) || !Array.isArray(json.diagnostics) || !Array.isArray(json.stamps)) {
    throw new Error(`the Rust checker answered no check: ${JSON.stringify(json)?.slice(0, 200)}`);
  }
  return {
    diagnostics: json.diagnostics.map(diagnosticOf),
    stamps: json.stamps.map(stampOf),
    ...(json.link !== undefined ? { link: linkOf(json.link) } : {}),
  };
}

/** The engine's `check.compatible` request (an `IS <Decl>` test of a
 *  system's record), answered by the Rust checker's comparator
 *  (crates/movement-checker/src/compatible.rs): `{fits}`, or `{undescribed}`
 *  when the schema enumerates nothing at the record type. */
export function compatibleInRust(request: {
  source: string;
  languageVersion: LanguageVersion;
  declaration: string;
  schema: unknown;
  recordType: string;
  path?: readonly string[];
}): { fits: boolean } | { undescribed: true } {
  const reply = callCheckCompatible(JSON.stringify(request));
  const json: unknown = reply.json;
  if (!reply.ok) throw refused(json);
  if (isRecord(json) && json.undescribed === true) return { undescribed: true };
  if (isRecord(json) && typeof json.fits === 'boolean') return { fits: json.fits };
  throw new Error(`the Rust checker answered check.compatible with ${JSON.stringify(json)}`);
}

function refused(json: unknown): RustCheckRefused {
  const error = isRecord(json) && isRecord(json.error) ? json.error : undefined;
  return new RustCheckRefused(typeof error?.message === 'string' ? error.message : 'the Rust checker refused the check');
}

function stampOf(value: unknown): Stamp {
  if (!isRecord(value) || typeof value.path !== 'string' || (value.file !== undefined && typeof value.file !== 'string')) {
    throw new Error(`the Rust checker answered a stamp that is not one: ${JSON.stringify(value)}`);
  }
  const at = { path: value.path, ...(typeof value.file === 'string' ? { file: value.file } : {}) };
  if (Array.isArray(value.spreadFields) && value.spreadFields.every((f) => typeof f === 'string')) {
    return { ...at, spreadFields: value.spreadFields };
  }
  if (value.copy !== undefined) return { ...at, copy: value.copy };
  if (value.reference === true) return { ...at, reference: true };
  throw new Error(`the Rust checker answered a stamp that stamps nothing: ${JSON.stringify(value)}`);
}

function linkOf(value: unknown): LinkData {
  if (!isRecord(value) || !Array.isArray(value.imports) || !Array.isArray(value.files)) {
    throw new Error(`the Rust checker answered a link that is not one: ${JSON.stringify(value)?.slice(0, 200)}`);
  }
  return {
    imports: value.imports.map(linkedImportOf),
    files: value.files.map((file: unknown) => {
      if (!isRecord(file) || typeof file.path !== 'string' || typeof file.source !== 'string' || !Array.isArray(file.imports) || !Array.isArray(file.exports)) {
        throw new Error(`the Rust checker answered a linked file that is not one: ${JSON.stringify(file)?.slice(0, 200)}`);
      }
      return {
        path: file.path,
        source: file.source,
        imports: file.imports.map(linkedImportOf),
        exports: file.exports.map((exported: unknown) => {
          if (!isRecord(exported) || typeof exported.name !== 'string' || typeof exported.declaration !== 'string') {
            throw new Error(`the Rust checker answered an export that is not one: ${JSON.stringify(exported)}`);
          }
          return { name: exported.name, kind: linkedKindOf(exported.kind), declaration: exported.declaration };
        }),
      };
    }),
  };
}

function linkedImportOf(value: unknown): LinkedImportData {
  if (
    !isRecord(value) ||
    typeof value.local !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.file !== 'string' ||
    typeof value.declaration !== 'string'
  ) {
    throw new Error(`the Rust checker answered an import that is not one: ${JSON.stringify(value)}`);
  }
  return { local: value.local, kind: linkedKindOf(value.kind), name: value.name, file: value.file, declaration: value.declaration };
}

function linkedKindOf(value: unknown): LinkedKind {
  if (value === 'movement' || value === 'shape') return value;
  throw new Error(`the Rust checker answered the import kind ${JSON.stringify(value)}`);
}

function diagnosticOf(value: unknown): Diagnostic {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    throw new Error(`the Rust checker answered a diagnostic that is not one: ${JSON.stringify(value)}`);
  }
  const severity = value.severity;
  if (severity !== undefined && severity !== 'warning' && severity !== 'info') {
    throw new Error(`the Rust checker answered the severity ${JSON.stringify(severity)}`);
  }
  return {
    code: value.code,
    message: value.message,
    span: spanOf(value.span),
    ...(severity !== undefined ? { severity } : {}),
    ...(value.upgrade === true ? { upgrade: true } : {}),
    ...(value.fix !== undefined ? { fix: fixOf(value.fix) } : {}),
  };
}

function fixOf(value: unknown): DiagnosticFix {
  const edits = isRecord(value) ? value.edits : undefined;
  if (!Array.isArray(edits)) throw new Error(`the Rust checker answered a fix with no edits: ${JSON.stringify(value)}`);
  return {
    edits: edits.map((edit): SourceEdit => {
      if (!isRecord(edit) || typeof edit.text !== 'string') throw new Error(`the Rust checker answered an edit that is not one: ${JSON.stringify(edit)}`);
      return { span: spanOf(edit.span), text: edit.text };
    }),
    ...(isRecord(value) && value.safe === true ? { safe: true as const } : {}),
  };
}

function spanOf(value: unknown): Span {
  if (!isRecord(value)) throw new Error(`the Rust checker answered a span that is not one: ${JSON.stringify(value)}`);
  return { start: locOf(value.start), end: locOf(value.end) };
}

function locOf(value: unknown): Loc {
  if (!isRecord(value) || typeof value.line !== 'number' || typeof value.col !== 'number') {
    throw new Error(`the Rust checker answered a position that is not one: ${JSON.stringify(value)}`);
  }
  return { line: value.line, col: value.col };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
