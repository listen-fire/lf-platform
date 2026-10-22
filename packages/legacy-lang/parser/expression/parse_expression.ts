// The expression grammar's entry point for the platform: movement-lang's,
// routed to the parser that reads its version (../rust_parser.ts).

import type { LanguageVersion } from 'movement-lang/language_version';
import type { MExpr } from 'movement-lang/parser/expression/tree';
import { rustParseExpression } from '../rust_parser';

export { ExpressionSyntaxError } from 'movement-lang/expression/error';

/** Parse one expression slot. Throws `ExpressionSyntaxError`.
 *  `languageVersion`: a text that is part of a program, read under that
 *  program's version; absent, it reads as versions 1 to 4 read it. */
export function parseExpression(source: string, languageVersion?: LanguageVersion): MExpr {
  return rustParseExpression(source, languageVersion);
}
