// Which parser reads a text: the language release's own (movement-lang's
// wasm) reads the versions it supports; every other pin, and version 0 (the
// expression surface a probe's text is read in, as versions 1 to 4 read it),
// is read by the parser frozen at the last commit that read versions 1 to 5
// (wasm/frozen_parser.ts). The two answer in the same shapes, wrapped by the
// same code (movement-lang's `parserOver`), so a caller cannot tell which
// read it.

import { SUPPORTED_LANGUAGE_VERSIONS } from 'movement-lang/language_version';
import type { ExprSlot, Program, RValue } from 'movement-lang/parser/ast';
import type { MExpr } from 'movement-lang/parser/expression/tree';
import {
  parserOver,
  rustParseExpression as liveParseExpression,
  rustParseNestedCall as liveParseNestedCall,
  rustParseProgram as liveParseProgram,
  type StatementParse,
} from 'movement-lang/parser/rust_parser';
import { callFrozenParser } from '../wasm/frozen_parser';

export type { StatementParse, StatementRefusal } from 'movement-lang/parser/rust_parser';

// Called through, not captured, so a test's spy on the loader sees each call.
const frozen = parserOver((fn, input, extra) => callFrozenParser(fn, input, extra));

/** Whether the language release's own parser reads `languageVersion`. */
export function readByLanguage(languageVersion: number): boolean {
  return SUPPORTED_LANGUAGE_VERSIONS.has(languageVersion);
}

export function rustParseProgram(source: string, languageVersion: number): StatementParse<Program> {
  return readByLanguage(languageVersion)
    ? liveParseProgram(source, languageVersion)
    : frozen.program(source, languageVersion);
}

export function rustParseNestedCall(
  slot: ExprSlot,
  at: { start: number; end: number },
  languageVersion: number,
): StatementParse<RValue> {
  return readByLanguage(languageVersion)
    ? liveParseNestedCall(slot, at, languageVersion)
    : frozen.nestedCall(slot, at, languageVersion);
}

/** Throws `ExpressionSyntaxError`. A text that is not a program's slot reads
 *  as versions 1 to 4 read it (version 0), so a probe's text never takes the
 *  version 5 surface's meaning — unless the caller reads it as a part of a
 *  program, under that program's `languageVersion`. */
export function rustParseExpression(source: string, languageVersion = 0): MExpr {
  return readByLanguage(languageVersion)
    ? liveParseExpression(source, languageVersion)
    : frozen.expression(source, languageVersion);
}
