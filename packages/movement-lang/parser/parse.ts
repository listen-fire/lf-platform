// The statement layer's entry points. The grammar is the Rust parser
// (crates/movement-parser), loaded as WebAssembly by wasm/loader.ts; this file
// is the TypeScript surface over it. Expression positions come back as ExprSlot
// spans whose trees the bridge reads (expression/bridge.ts).

import { CURRENT_LANGUAGE_VERSION, type LanguageVersion } from '../language_version';
import type { ExprSlot, Loc, Program, RValue } from './ast';
import { originalSlot } from '../expression/bridge';
import { rustParseNestedCall, rustParseProgram, type StatementParse } from './rust_parser';

export class MovementParseError extends Error {
  readonly loc: Loc;

  constructor(message: string, loc: Loc) {
    super(`${message} (line ${loc.line}, col ${loc.col})`);
    this.name = 'MovementParseError';
    this.loc = loc;
  }
}

/** The compile context a parse runs under. */
export interface ParseOptions {
  /** The language version the source is written against — what a version
   *  conditional in the grammar reads. Absent ⇒ the current version. */
  languageVersion?: LanguageVersion;
}

export function parseProgram(source: string, options?: ParseOptions): Program {
  const languageVersion = options?.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  return refusedAsError(rustParseProgram(source, languageVersion));
}

/**
 * A call written inside an expression — `f(x)` in `f(x) + 1`, `extract(c, S)`
 * in `ONLY(extract(c, S))` — read as the right-hand side of a binding, which
 * is what it means (language version 3): the expression is the same as binding
 * the call to a fresh name first and reading the name. `at` is the call's
 * extent in `slot.raw`, as the expression grammar found it; the statement
 * grammar reads it because a call's arguments are its own (a closure's
 * statements, a type, a node literal). Spans are the file's.
 */
export function parseNestedCall(
  slot: ExprSlot,
  at: { start: number; end: number },
  languageVersion: LanguageVersion,
): RValue {
  return readNestedCall(slot, { at, languageVersion, parse: () => rustParseNestedCall(slot, at, languageVersion) });
}

/**
 * `parseNestedCall`'s read, once per place in the program, with the parse
 * it records given: the platform reads a pin this release no longer serves
 * through its own parser, into the same record `nestedCallsReadIn` answers.
 *
 * @internal
 */
export function readNestedCall(
  slot: ExprSlot,
  read: { at: { start: number; end: number }; languageVersion: LanguageVersion; parse: () => StatementParse<RValue> },
): RValue {
  // Read once per place in the program, as a call on its own line is: the
  // checker records what it settles on the call's statements (a spread's copy
  // plan, a walk's), and the engine runs those same statements.
  const origin = originalSlot(slot);
  let reads = nestedCallReads.get(origin);
  if (reads === undefined) {
    reads = new Map();
    nestedCallReads.set(origin, reads);
  }
  const { at } = read;
  const key = `${read.languageVersion}@${at.start}-${at.end}`;
  let nested = reads.get(key);
  if (nested === undefined) {
    nested = { at: { start: at.start, end: at.end }, value: refusedAsError(read.parse()) };
    reads.set(key, nested);
  }
  return nested.value;
}

/** A nested call as `parseNestedCall` read it: its extent in the slot's text
 *  and the right-hand side it is. */
export interface NestedCallRead {
  at: { start: number; end: number };
  value: RValue;
}

const nestedCallReads = new WeakMap<ExprSlot, Map<string, NestedCallRead>>();

/** Every nested call read in `slot` so far, in the order first read: what the
 *  checker settled on each is on the value, which a re-parse of the source
 *  does not carry (the check answer's stamps, apps/api program_check). */
export function nestedCallsReadIn(slot: ExprSlot): NestedCallRead[] {
  return [...(nestedCallReads.get(slot)?.values() ?? [])];
}

/** A statement parse's value, or its refusal thrown as `MovementParseError`.
 *  @internal For the platform's reader of old pins. */
export function refusedAsError<T>(parse: StatementParse<T>): T {
  if (parse.ok) return parse.value;
  throw new MovementParseError(parse.refusal.message, parse.refusal.loc);
}
