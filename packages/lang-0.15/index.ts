// Release 0.15's engine, checker, modules and listen judge, as one door. The
// platform's run host is shared by every version it runs (Henry, 2026-11-16:
// "One host, two engines"): a 0.15 pin is parsed, checked, planned, judged and
// run by 0.15's own packages here, against the catalog 0.15's own modules
// describe (`lane/`), and everything else of its run is the platform's.
//
// Only plain data leaves this file: a parse, a check or a run that fails comes
// back as its name, message and code, never as one of 0.15's classes, which the
// platform could not tell from the current release's
// (`@listen-fire/language-versions` turns them back into the current
// release's). A value or a class of this line enters the platform only through
// that registry.
//
// Never compiled in place: the image compiles it into the directory `pnpm
// deploy` installs it in, beside 0.15's packages (deploy/Dockerfile). A copy
// vendored into the api's build would resolve them from the api's own
// node_modules, which hold the current release.

import {
  MovementParseError,
  RustCheckRefused,
  checkAnswerInRust,
  checkSourceInRust,
  parseProgram,
  type CatalogSnapshot,
  type CheckAnswer,
  type Diagnostic,
  type LanguageVersion,
  type Loc,
  type Program,
} from '@listen-fire/movement-lang';
import { HOST_FAMILIES_VERSION, type SettleRaceInput } from '@listen-fire/engine-contracts';
import {
  fieldIdsOf,
  landingNode,
  listenFires,
  listenPlansOf,
  listenSchemaOf,
  plannedListensOf,
  triggerAwaitsOf,
} from '@listen-fire/engine/public/inbound';
import {
  resumeMovement,
  runMovement,
  settleRaceFrame,
  type MovementRunResult,
  type ResumeMovementInput,
  type RunMovementInput,
} from '@listen-fire/engine/public/movement-engine';
import { MovementEngineError, MovementRunFailed, RunCancelledSignal } from '@listen-fire/engine/public/errors';
import type { EngineHost } from '@listen-fire/engine/public/host';

export { LANGUAGE_VERSION } from '@listen-fire/movement-lang';
export { checkSource, completionsAt, definitionAt, hoverAt } from './lane/check';
export { outlineOf } from './lane/outline';
export { storyOf } from './lane/story';

/** A parse, as plain data: the program, or where (`loc`) and why (`message`)
 *  it does not parse. */
export type LineParse = { ok: true; program: Program } | { ok: false; message: string; loc: Loc };

/** A check, or the checker's refusal to make it (a text it cannot read). */
export type LineCheck<T> = { ok: true; value: T } | { ok: false; refused: string };

/** An error of 0.15's, as plain data. */
export interface LineError {
  name: string;
  message: string;
  /** The engine's own code, when it raised one of its errors. */
  code?: string;
  details?: unknown;
}

/** Why a segment of 0.15's engine stopped short, as plain data. */
export interface LineFailure extends LineError {
  /** What the run had done when it died. */
  partial?: MovementRunResult;
  /** The run was cancelled by request. */
  cancelled?: true;
  /** The error the run died of, when a carrier held it. */
  cause?: LineError;
}

export type LineRun = { ok: true; result: MovementRunResult } | { ok: false; failure: LineFailure };

function parse(source: string, options: { languageVersion: LanguageVersion }): LineParse {
  try {
    return { ok: true, program: parseProgram(source, options) };
  } catch (error) {
    if (!(error instanceof MovementParseError)) throw error;
    // The error's message ends with where it is; the reader rebuilds that from `loc`.
    const at = ` (line ${error.loc.line}, col ${error.loc.col})`;
    return { ok: false, message: error.message.endsWith(at) ? error.message.slice(0, -at.length) : error.message, loc: error.loc };
  }
}

function checked<T>(read: () => T): LineCheck<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof RustCheckRefused) return { ok: false, refused: error.message };
    throw error;
  }
}

function plainError(error: unknown): LineError {
  if (error instanceof MovementEngineError) {
    return { name: error.name, message: error.message, code: error.code, ...(error.details !== undefined ? { details: error.details } : {}) };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

function failureOf(error: unknown): LineFailure {
  if (error instanceof RunCancelledSignal) return { ...plainError(error), cancelled: true };
  if (error instanceof MovementRunFailed) {
    if (error.cause instanceof RunCancelledSignal) return { ...plainError(error.cause), cancelled: true, partial: error.partial };
    return { ...plainError(error), partial: error.partial, cause: plainError(error.cause) };
  }
  return plainError(error);
}

async function ran(segment: () => Promise<MovementRunResult>): Promise<LineRun> {
  try {
    return { ok: true, result: await segment() };
  } catch (error) {
    return { ok: false, failure: failureOf(error) };
  }
}

/** Release 0.15's line, for the registry's 0.15 entry. */
export const ENGINE_LINE = {
  /** 0.15's engine opens every segment on host families version 2, which has
   *  `lookup.resolveActingUser`: the platform serves that version itself. */
  hostFamiliesVersion: HOST_FAMILIES_VERSION,
  parse,
  check: (source: string, snapshot: CatalogSnapshot, options: { languageVersion: LanguageVersion }): LineCheck<Diagnostic[]> =>
    checked(() => checkSourceInRust(source, snapshot, options)),
  checkAnswer: (source: string, snapshot: CatalogSnapshot, options: { languageVersion: LanguageVersion }): LineCheck<CheckAnswer> =>
    checked(() => checkAnswerInRust(source, snapshot, options)),
  listenPlansOf,
  plannedListensOf,
  triggerAwaitsOf,
  landingNode,
  listenSchemaOf,
  fieldIdsOf,
  listenFires,
  run: (input: RunMovementInput): Promise<LineRun> => ran(() => runMovement(input)),
  resume: (input: ResumeMovementInput): Promise<LineRun> => ran(() => resumeMovement(input)),
  settleRace: (input: SettleRaceInput & { host: EngineHost }): Promise<LineRun> => ran(() => settleRaceFrame(input)),
};
