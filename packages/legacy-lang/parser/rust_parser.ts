// Which parser reads a text: a legacy id ('1'..'4'), and version 0 (the
// expression surface a probe's text is read in, as versions 1 to 4 read it),
// is read by the parser frozen at the last commit that read versions 1 to 5
// (wasm/frozen_parser.ts), handed the integer it expects; every other pin is
// the language release's, read by its own wasm under its rule. The two answer
// in the same shapes, wrapped by the same code (movement-lang's `parserOver`),
// so a caller cannot tell which read it.

import { LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang/language_version';
import type { ExprSlot, Program, RValue } from 'movement-lang/parser/ast';
import type { MExpr } from 'movement-lang/parser/expression/tree';
import {
  parserOver,
  rustParseExpression as liveParseExpression,
  rustParseNestedCall as liveParseNestedCall,
  rustParseProgram as liveParseProgram,
  type RustParser,
  type StatementParse,
} from 'movement-lang/parser/rust_parser';
import { callFrozenParser } from '../wasm/frozen_parser';
import { legacyVersionNumber } from '../version_conditionals';

export type { StatementParse, StatementRefusal } from 'movement-lang/parser/rust_parser';

// The frozen artifact takes its version as the last argument of every call.
// Called through, not captured, so a test's spy on the loader sees each call.
const frozenByVersion = new Map<number, RustParser>();
function frozen(version: number): RustParser {
  let parser = frozenByVersion.get(version);
  if (parser === undefined) {
    parser = parserOver((fn, input, extra) => callFrozenParser(fn, input, [...extra, version]));
    frozenByVersion.set(version, parser);
  }
  return parser;
}

/** The integer the frozen parser reads `languageVersion` under; none when the
 *  language release's own parser reads it. Every integer but this copy's 5
 *  (the installed language) is the frozen parser's, which answers for one it
 *  never knew as it always did. */
function frozenVersion(languageVersion: LanguageVersion | number): number | undefined {
  const pin = String(languageVersion);
  return /^\d+$/.test(pin) && pin !== '5' ? legacyVersionNumber(pin) : undefined;
}

/** Whether the language release's own parser reads `languageVersion`. */
export function readByLanguage(languageVersion: LanguageVersion): boolean {
  return frozenVersion(languageVersion) === undefined;
}

/** The pin the language release's parser is asked under: this copy's integer
 *  5 is the installed language. */
function livePin(languageVersion: LanguageVersion | number): LanguageVersion {
  return String(languageVersion) === '5' ? LANGUAGE_VERSION : String(languageVersion);
}

export function rustParseProgram(source: string, languageVersion: LanguageVersion): StatementParse<Program> {
  const version = frozenVersion(languageVersion);
  return version === undefined
    ? liveParseProgram(source, livePin(languageVersion))
    : frozen(version).program(source);
}

export function rustParseNestedCall(
  slot: ExprSlot,
  at: { start: number; end: number },
  languageVersion: LanguageVersion,
): StatementParse<RValue> {
  const version = frozenVersion(languageVersion);
  return version === undefined
    ? liveParseNestedCall(slot, at, livePin(languageVersion))
    : frozen(version).nestedCall(slot, at);
}

/** Throws `ExpressionSyntaxError`. A text that is not a program's slot reads
 *  as versions 1 to 4 read it (version 0), so a probe's text never takes the
 *  installed language's meaning — unless the caller reads it as a part of a
 *  program, under that program's `languageVersion`. */
export function rustParseExpression(source: string, languageVersion: LanguageVersion = '0'): MExpr {
  const version = frozenVersion(languageVersion);
  return version === undefined
    ? liveParseExpression(source, livePin(languageVersion))
    : frozen(version).expression(source);
}
