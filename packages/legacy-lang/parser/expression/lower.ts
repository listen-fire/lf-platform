// movement-lang's lowering, with the two entry points that parse a text
// routed to the parser that reads its version (./parse_expression.ts).

import type { Expression } from 'movement-lang/expression/types';
import { lowerCondition, lowerExpression, type MovementCondition } from 'movement-lang/parser/expression/lower';
import { parseExpression } from './parse_expression';

export * from 'movement-lang/parser/expression/lower';

export function lowerMovementExpression(raw: string, languageVersion?: number): Expression {
  return lowerExpression(parseExpression(raw, languageVersion), raw);
}

export function lowerMovementCondition(raw: string, languageVersion?: number): MovementCondition {
  return lowerCondition(parseExpression(raw, languageVersion), raw);
}
