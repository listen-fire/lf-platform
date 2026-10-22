// The statement layer's entry points for the platform: movement-lang's,
// with each parse routed to the parser that reads its version
// (./rust_parser.ts). Everything else is movement-lang's own.

import { CURRENT_LANGUAGE_VERSION, type LanguageVersion } from '../language_version';
import type { ExprSlot, Program, RValue } from 'movement-lang/parser/ast';
import { readNestedCall, refusedAsError, type ParseOptions } from 'movement-lang/parser/parse';
import { rustParseNestedCall, rustParseProgram } from './rust_parser';

export * from 'movement-lang/parser/parse';

export function parseProgram(source: string, options?: ParseOptions): Program {
  const languageVersion = options?.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  return refusedAsError(rustParseProgram(source, languageVersion));
}

/** movement-lang's `parseNestedCall`, read by the parser for its version. */
export function parseNestedCall(
  slot: ExprSlot,
  at: { start: number; end: number },
  languageVersion: LanguageVersion,
): RValue {
  return readNestedCall(slot, { at, languageVersion, parse: () => rustParseNestedCall(slot, at, languageVersion) });
}
