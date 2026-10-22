// The authoring loop's validation surface: propose → typecheck → repair.
//
// `diagnoseMovementSource` is the pure core — it mirrors EXACTLY the gate
// `saveMovement` applies, by the pin's route (./language_route.ts): the wasm
// checker for an installed pin; parse → TypeScript check → the engine's dry
// interpretability scan for a legacy id. A clean validation predicts a live save.
// Diagnostics are returned as plain data with 1-based line/col spans,
// codes, severities, and the offending source line, ready to hand to an
// authoring agent (or any other consumer) for the repair half of the loop.
//
// `validateMovementForTeam` is the I/O wrapper: it assembles the same
// per-team catalog the save path uses (referenced-construction scoped)
// and runs the core against it.

import { BridgeError, LANGUAGE_VERSION, diagnosticSeverity, neverAsAny, parseProgram as parseInstalled } from 'movement-lang';
import { checkProgram } from 'legacy-lang';
import { MovementParseError } from 'movement-lang';
import { parseProgram } from 'legacy-lang';

import type {
  Catalog,
  CatalogSnapshot,
  Diagnostic,
  LanguageVersion,
  Program,
  ResolveFile,
  Span,
} from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { CatalogGap } from './catalog';
import { getMovementRow, type MovementValidityStatus } from './store';

import { listUnsupportedConstructs } from '@listen-fire/legacy-engine/services/movement_engine/interpretable';
import { movementCatalogForTeam } from './catalog';
import { checkInstalled, routeOf } from './language_route';
import { stepTimer, type StepTimer } from './timing';


export interface AuthoringDiagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  /** 1-based line/col into the source. */
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** The offending source line, verbatim — repair context without re-reading. */
  sourceLine: string;
  /** Marks a construct whose meaning changed between the pin and the version
   *  checked, on an upgrade check (the checker's `Diagnostic.upgrade`). */
  upgrade?: true;
  /** The exact rewrite that resolves it (also spelled out in `message`):
   *  replace each 1-based range with `text`; an empty range inserts. `safe`:
   *  it provably keeps the meaning, so an upgrade may apply it unasked. */
  fix?: { edits: AuthoringEdit[]; safe?: true };
}

export interface AuthoringEdit {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
}

export interface MovementValidation {
  /** True when nothing error-severity was found — a save would go live. */
  ok: boolean;
  diagnostics: AuthoringDiagnostic[];
  /** `listen` statements found (0 = library file: nothing fires it). */
  listenerCount: number;
  /** Movements each listener fires, in file order. */
  firedMovements: string[];
}

export function toAuthoringDiagnostic(
  diagnostic: Diagnostic,
  lines: string[],
): AuthoringDiagnostic {
  const span: Span = diagnostic.span;
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnosticSeverity(diagnostic),
    line: span.start.line,
    col: span.start.col,
    endLine: span.end.line,
    endCol: span.end.col,
    sourceLine: lines[span.start.line - 1] ?? '',
    ...(diagnostic.upgrade === true ? { upgrade: true } : {}),
    ...(diagnostic.fix !== undefined
      ? {
          fix: {
            edits: diagnostic.fix.edits.map((edit) => ({
              line: edit.span.start.line,
              col: edit.span.start.col,
              endLine: edit.span.end.line,
              endCol: edit.span.end.col,
              text: edit.text,
            })),
            ...(diagnostic.fix.safe === true ? { safe: true as const } : {}),
          },
        }
      : {}),
  };
}

/** Raw checker/compile diagnostics → the authoring shape, against the
 *  source they were produced from (the save path returns raw ones). */
export function formatMovementDiagnostics(
  source: string,
  diagnostics: Diagnostic[],
): AuthoringDiagnostic[] {
  const lines = source.split('\n');
  return diagnostics.map((d) => toAuthoringDiagnostic(d, lines));
}

function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.code}@${d.span.start.line}:${d.span.start.col}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The exact gate `saveMovement` applies, minus the persistence, against an
 * injected catalog — pure given it; unit-testable without I/O. Which checker
 * judges is the pin's (`routeOf`): an installed pin is the wasm checker's
 * against the run snapshot, a legacy id is parse + TypeScript check + the
 * engine's dry interpretability scan, and any other pin is refused.
 */
export function diagnoseMovementSource(
  source: string,
  options: {
    catalog: Catalog;
    resolveCredentialId?: (credentialName: string) => string | undefined;
    /** File-import resolution (movement libraries) — same resolver the
     *  save path threads through the check and compileMovement. */
    resolveFile?: ResolveFile;
    /** The language version to validate under — a saved movement's pin.
     *  Absent ⇒ the current version. */
    languageVersion?: LanguageVersion;
    /** The movement's pin, when this validation asks whether it can move up
     *  to `languageVersion` — adds the checker's warnings for constructs whose
     *  meaning changed between the two (`CheckOptions.upgradingFrom`). */
    upgradingFrom?: LanguageVersion;
    /** The snapshot a run of the source checks and runs against, from the
     *  same assembly as `catalog`. An installed pin is checked against it and
     *  nothing else, so it is required there. */
    snapshot?: CatalogSnapshot;
  },
): MovementValidation {
  const lines = source.split('\n');
  const route = routeOf(options.languageVersion ?? LANGUAGE_VERSION);
  switch (route.kind) {
    // A pin this release cannot honour is the whole verdict: reading the text
    // under some other version's grammar would report problems that aren't.
    case 'refused':
      return {
        ok: false,
        diagnostics: [toAuthoringDiagnostic(route.diagnostic, lines)],
        listenerCount: 0,
        firedMovements: [],
      };
    case 'installed':
      return diagnoseInstalled(source, route.pin, options);
    case 'legacy':
      return diagnoseLegacy(source, route.pin, options);
    default:
      return neverAsAny(route);
  }
}

function parseRefusal(e: MovementParseError, lines: string[]): MovementValidation {
  const parseDiagnostic: Diagnostic = {
    code: 'MOV_PARSE',
    message: e.message,
    span: { start: e.loc, end: e.loc },
  };
  return {
    ok: false,
    diagnostics: [toAuthoringDiagnostic(parseDiagnostic, lines)],
    listenerCount: 0,
    firedMovements: [],
  };
}

function validationOf(program: Program, collected: Diagnostic[], lines: string[]): MovementValidation {
  const firedMovements: string[] = [];
  for (const statement of program.statements) {
    if (statement.kind === 'listen') firedMovements.push(statement.movement);
  }
  const diagnostics = dedupe(collected).map((d) => toAuthoringDiagnostic(d, lines));
  return {
    ok: diagnostics.every((d) => d.severity !== 'error'),
    diagnostics,
    listenerCount: firedMovements.length,
    firedMovements,
  };
}

/** The wasm's verdict, against the snapshot the run is held to. */
function diagnoseInstalled(
  source: string,
  pin: LanguageVersion,
  options: Parameters<typeof diagnoseMovementSource>[1],
): MovementValidation {
  const lines = source.split('\n');
  const { snapshot } = options;
  if (snapshot === undefined) throw new Error('a release pin is checked against its run snapshot');
  let program: Program;
  try {
    program = parseInstalled(source, { languageVersion: pin });
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    return parseRefusal(e, lines);
  }
  const diagnostics = checkInstalled({
    source,
    snapshot,
    pin,
    program,
    catalog: options.catalog,
    ...(options.upgradingFrom !== undefined ? { upgradingFrom: options.upgradingFrom } : {}),
    ...(options.resolveFile !== undefined ? { resolveFile: options.resolveFile } : {}),
  });
  return validationOf(program, diagnostics, lines);
}

/** legacy-lang's verdict: its parse and TypeScript check, then the engine's
 *  dry interpretability scan the save path applies. */
function diagnoseLegacy(
  source: string,
  languageVersion: LanguageVersion,
  options: Parameters<typeof diagnoseMovementSource>[1],
): MovementValidation {
  const lines = source.split('\n');
  let program: Program;
  try {
    program = parseProgram(source, { languageVersion });
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    return parseRefusal(e, lines);
  }

  const resolving = options.resolveFile !== undefined ? { resolveFile: options.resolveFile } : {};
  const collected: Diagnostic[] = [
    ...checkProgram(program, options.catalog, {
      languageVersion,
      ...(options.upgradingFrom !== undefined ? { upgradingFrom: options.upgradingFrom } : {}),
      ...resolving,
    }),
  ];

  // The engine gate, mirrored from the save path: the dry
  // interpretability scan names any constructs the TypeScript engine does
  // not support — error severity, since the save would refuse with
  // status 'error'. Spans aren't statically available from the scan;
  // the construct names carry the repair signal.
  for (const construct of listUnsupportedConstructs(source, { languageVersion, ...resolving })) {
    collected.push({
      code: 'MOV_ENGINE_UNSUPPORTED',
      message: `the engine does not support ${construct} yet — remove it to save this file live`,
      span: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
    });
  }
  return validationOf(program, collected, lines);
}

export interface TeamMovementValidation extends MovementValidation {
  /** Honest gaps from catalog assembly (untyped adapters, …) — context
   *  for why some checks may have stayed silent. */
  catalogNotes: string[];
  /** Structured introspection gaps — a referenced adapter that couldn't be
   *  typed because introspecting it failed. The `unverified` signal, distinct
   *  from a check error. */
  gaps: CatalogGap[];
}

export interface MovementValidityAssessment {
  status: MovementValidityStatus;
  /** Structured `validity_reason`: `{ diagnostics }` for invalid,
   *  `{ gaps }` for unverified, `null` for valid. */
  reason: unknown;
}

/**
 * Collapse a validation into the runtime validity status. Precedence:
 *   error diagnostics → `invalid` (we know it's broken)
 *   else introspection gaps → `unverified` (we couldn't check a referenced adapter)
 *   else → `valid`.
 * Parse errors surface as an error-severity `MOV_PARSE` diagnostic, so an
 * incompilable movement lands `invalid` here. See
 * plans/2026-07-13-movement-validity-lifecycle.
 */
export function assessMovementValidity(input: {
  diagnostics: AuthoringDiagnostic[];
  gaps: CatalogGap[];
}): MovementValidityAssessment {
  const errors = input.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) return { status: 'invalid', reason: { diagnostics: errors } };
  if (input.gaps.length > 0) return { status: 'unverified', reason: { gaps: input.gaps } };
  return { status: 'valid', reason: null };
}

/**
 * Validate a movement source against the team's REAL catalog — the same
 * referenced-construction-scoped assembly `saveMovement` uses, so the
 * verdict predicts the save.
 */
export async function validateMovementForTeam(input: {
  teamId: string;
  source: string;
  /** The language version to validate under — a saved movement's pin, or an
   *  explicit request. Absent ⇒ the current version. */
  languageVersion?: LanguageVersion;
  /** The movement's pin, when validating it for a move up to
   *  `languageVersion` — see `diagnoseMovementSource`. */
  upgradingFrom?: LanguageVersion;
}): Promise<TeamMovementValidation> {
  // Catalog assembly scopes itself to the source by scanning its constructions
  // and expression slots. A malformed expression can make one of those scans
  // throw — which must NEVER 500 the validator. Fall back to the whole-workspace
  // catalog (which doesn't scan the source), so `diagnoseMovementSource` still
  // runs and the checker reports the parse error as a diagnostic. Non-source
  // (infra) failures propagate unchanged.
  const timer = stepTimer('authoring: validate', { teamId: input.teamId });
  try {
    return await runValidate(input, timer);
  } finally {
    timer.done();
  }
}

/**
 * The editor's lint for a pin whose checker is not in the browser: the
 * validation `validateMovementForTeam` gives, under the pin of the movement
 * being edited (`id`), else an explicit pin, else the installed release.
 * Null when `id` names no movement of this team.
 */
export async function checkMovementSource(input: {
  teamId: string;
  source: string;
  id?: string;
  languageVersion?: LanguageVersion;
}): Promise<{ diagnostics: AuthoringDiagnostic[] } | null> {
  let pin = input.languageVersion ?? LANGUAGE_VERSION;
  if (input.id !== undefined) {
    const row = await getMovementRow({ teamId: input.teamId, id: input.id });
    if (row === null) return null;
    pin = row.languageVersion;
  }
  const validation = await validateMovementForTeam({
    teamId: input.teamId,
    source: input.source,
    languageVersion: pin,
  });
  return { diagnostics: validation.diagnostics };
}

async function runValidate(
  input: {
    teamId: string;
    source: string;
    languageVersion?: LanguageVersion;
    upgradingFrom?: LanguageVersion;
  },
  timer: StepTimer,
): Promise<TeamMovementValidation> {
  let teamCatalog;
  /** Why the scoped scan failed, when it did — the fallback catalog describes
   *  nothing, so this is the only account of what went unchecked. */
  let scanFailure: string | undefined;
  try {
    teamCatalog = await timer.step('catalog', () =>
      movementCatalogForTeam(input.teamId as TeamId, {
        source: input.source,
        ...(input.languageVersion !== undefined ? { languageVersion: input.languageVersion } : {}),
      }),
    );
  } catch (e) {
    if (!(e instanceof BridgeError || e instanceof MovementParseError)) throw e;
    scanFailure = e.message;
    // `types: []` — describe NOTHING. Source that will not parse never reaches
    // type-checking, so no schema can inform the diagnostic; fetching every
    // type of every connected system to report a missing bracket is a
    // whole-graph load bought for nothing.
    teamCatalog = await timer.step('catalog', () =>
      movementCatalogForTeam(input.teamId as TeamId, { types: [] }),
    );
  }
  timer.note(teamCatalog.cost ?? {});
  const validation = await timer.step('diagnose', async () =>
    diagnoseMovementSource(input.source, {
      catalog: teamCatalog.catalog,
      resolveCredentialId: teamCatalog.resolveCredentialId,
      resolveFile: teamCatalog.resolveFile,
      ...(teamCatalog.runSnapshot !== undefined ? { snapshot: teamCatalog.runSnapshot() } : {}),
      ...(input.languageVersion !== undefined ? { languageVersion: input.languageVersion } : {}),
      ...(input.upgradingFrom !== undefined ? { upgradingFrom: input.upgradingFrom } : {}),
    }),
  );
  const notes = [...teamCatalog.notes];
  const gaps = [...teamCatalog.gaps];
  if (scanFailure !== undefined) {
    // The fallback catalog describes NOTHING, so every schema-typed check ran
    // against an empty world and stayed silent. Usually the source also failed
    // to parse and the parse error carries the verdict — but not always, and a
    // source that parses would otherwise come back a clean `ok` that means only
    // "nothing was checked". A gap makes that `unverified`, which is what it is.
    const detail =
      `the source could not be scanned for the systems it uses, so nothing was ` +
      `checked against live schemas — ${scanFailure}`;
    gaps.push({ adapter: 'every system', detail });
    notes.push(detail);
  }
  return { ...validation, catalogNotes: notes, gaps };
}
