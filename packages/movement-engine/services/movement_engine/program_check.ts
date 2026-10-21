// The check every run on this engine passes before it executes: the
// language-version pin, the parse and the Rust checker (crates/movement-
// checker, in the movement artifact), throwing MOVENG_LANGUAGE_VERSION,
// MOVENG_PARSE or MOVENG_CHECK. A run is checked before its segment opens
// (`checkPinnedInRust`), then by the engine itself as the segment starts (its
// native check). The `check.program` host call (rust_host.ts), which only a
// segment started without the native check makes, is answered by the same
// checker as data (`checkAnswerInRust`): its diagnostics, the import link and
// the checker's stamps.
//
// The stamps are what the checker settles on nodes that the engine reads: on
// a write's spread the fields it stands for, on a graph's spread what it
// copies, on a graph entry whose value is a record that the entry is an edge
// holding it. Each is keyed by its node's place in the program's JSON — the
// AST path scheme:
//
//   path = a JSON Pointer (RFC 6901) from the Program object to the stamped
//          node, through the keys and array indices of the Program exactly
//          as the parser emits it: `/statements/2/body/0/write/spreads/1`.
//   file = absent for the program run; a library file's path for a stamp in
//          a file it imports (the same pointer, from that file's Program).
//
// A call nested in an expression (`FIRST(MAP(xs, (x) => …))`) continues the
// pointer through the slot it is written in: `<slot>/nested/<start>-<end>/value`
// is the right-hand side the call reads as, `start` and `end` its extent in
// the slot's text (UTF-16 offsets).

import {
  CURRENT_LANGUAGE_VERSION,
  languageVersionDiagnostic,
  checkAnswerInRust as rustCheckAnswer,
  checkSourceInRust,
} from 'movement-lang';
import { rustParseProgram } from 'movement-lang/parser/rust_parser';

import type { CatalogSnapshot, CheckAnswer, Diagnostic, LanguageVersion, Program } from 'movement-lang';

import { MovementEngineError } from './errors';

/**
 * Diagnostics an author may no longer WRITE, but a saved program may still
 * RUN. A retirement refuses the construct where a program is authored; it must
 * not stop automations that were saved while the construct was legal, so the
 * run gate lets exactly these through and the engine still executes them.
 */
const RETIRED_BUT_STILL_RUNNABLE = new Set<string>(['MOV_WRITE_SHAPE_RETIRED']);

export interface CheckInput {
  source: string;
  catalog: CatalogSnapshot;
  languageVersion?: LanguageVersion;
  /** Checking for a move up from this version (`upgradingFrom`). */
  upgradingFrom?: LanguageVersion;
}

/** The pin, the parse: MOVENG_LANGUAGE_VERSION or MOVENG_PARSE. */
export function parsePinned(input: Pick<CheckInput, 'source' | 'languageVersion'>): Program {
  const languageVersion = input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  // The pin is answered before the source is read: a version this release
  // cannot honour must fail as exactly that, not as whatever the current
  // grammar makes of the text.
  const versionDiagnostic = languageVersionDiagnostic(languageVersion);
  if (versionDiagnostic !== undefined && (versionDiagnostic.severity ?? 'error') === 'error') {
    throw new MovementEngineError('MOVENG_LANGUAGE_VERSION', versionDiagnostic.message, [
      versionDiagnostic,
    ]);
  }
  const parsed = rustParseProgram(input.source, languageVersion);
  if (!parsed.ok) {
    const { message, loc } = parsed.refusal;
    throw new MovementEngineError('MOVENG_PARSE', `${message} (line ${loc.line}, col ${loc.col})`);
  }
  return parsed.value;
}

/** The pin, the parse and the Rust checker, the check a run on the Rust
 *  engine is held to, before anything of the run reaches its host. Error
 *  severity only blocks: info diagnostics (MOV_LISTEN_MISSING — a
 *  dispatchable movement with no listen) never do. The engine checks again
 *  as its segment starts (its native check), and it is that check whose
 *  stamps and link the run reads; this one answers only whether the run may
 *  open a segment at all. */
export function checkPinnedInRust(input: CheckInput): Diagnostic[] {
  const languageVersion = input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  parsePinned(input);
  const diagnostics = checkSourceInRust(input.source, input.catalog, {
    languageVersion,
    ...(input.upgradingFrom !== undefined ? { upgradingFrom: input.upgradingFrom } : {}),
  });
  throwIfBlocking(diagnostics);
  return diagnostics;
}

/** `checkPinnedInRust`, answered as data (the `check.program` host call):
 *  every diagnostic, the import link and the checker's stamps. */
export function checkAnswerInRust(input: CheckInput): CheckAnswer {
  const languageVersion = input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  parsePinned(input);
  const answer = rustCheckAnswer(input.source, input.catalog, {
    languageVersion,
    ...(input.upgradingFrom !== undefined ? { upgradingFrom: input.upgradingFrom } : {}),
  });
  throwIfBlocking(answer.diagnostics);
  return answer;
}

/** MOVENG_CHECK for any blocking diagnostic: error severity, except the
 *  retirements a saved program may still run. */
export function throwIfBlocking(diagnostics: Diagnostic[]): void {
  const blocking = diagnostics.filter(
    (d) => (d.severity ?? 'error') === 'error' && !RETIRED_BUT_STILL_RUNNABLE.has(d.code),
  );
  if (blocking.length > 0) {
    throw new MovementEngineError(
      'MOVENG_CHECK',
      `the movement program failed checking:\n${blocking
        .map((d) => `  ${d.code} (line ${d.span.start.line}): ${d.message}`)
        .join('\n')}`,
      blocking,
    );
  }
}

// The check as data: the Rust checker's answer shape.
export type { CheckAnswer, LinkData, LinkedImportData, Stamp } from 'movement-lang';
