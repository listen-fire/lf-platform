// movement-lang's lowering for the platform, routed as parsing is
// (../rust_parser.ts): a pin the language release reads is lowered by its own
// artifact; every other pin, and a text read with none (version 0), by the
// frozen artifact that parsed it, so an old pin's reading never depends on
// the live lowering.

import type { LanguageVersion } from 'movement-lang/language_version';
import type { Expression } from 'movement-lang/expression/types';
import {
  lowerCondition as liveLowerCondition,
  lowerExpression as liveLowerExpression,
  loweringOver,
  type Lowering,
  type MovementCondition,
} from 'movement-lang/parser/expression/lower';
import type { MExpr } from 'movement-lang/parser/expression/tree';
import { callFrozenLowering } from '../../wasm/frozen_parser';
import { readByLanguage } from '../rust_parser';
import { parseExpression } from './parse_expression';

export * from 'movement-lang/parser/expression/lower';

const live: Lowering = { expression: liveLowerExpression, condition: liveLowerCondition };
// Called through, not captured, so a test's spy on the loader sees each call.
const frozen = loweringOver((fn, treeJson, source) => callFrozenLowering(fn, treeJson, source));

function loweringFor(languageVersion: LanguageVersion | undefined): Lowering {
  return readByLanguage(languageVersion ?? '0') ? live : frozen;
}

/** `lowerExpression` by the artifact that reads `languageVersion`. */
export function lowerExpressionAt(tree: MExpr, source: string, languageVersion?: LanguageVersion): Expression {
  return loweringFor(languageVersion).expression(tree, source);
}

/** `lowerCondition` by the artifact that reads `languageVersion`. */
export function lowerConditionAt(tree: MExpr, source: string, languageVersion?: LanguageVersion): MovementCondition {
  return loweringFor(languageVersion).condition(tree, source);
}

export function lowerMovementExpression(raw: string, languageVersion?: LanguageVersion): Expression {
  return lowerExpressionAt(parseExpression(raw, languageVersion), raw, languageVersion);
}

export function lowerMovementCondition(raw: string, languageVersion?: LanguageVersion): MovementCondition {
  return lowerConditionAt(parseExpression(raw, languageVersion), raw, languageVersion);
}
