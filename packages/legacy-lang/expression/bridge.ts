// movement-lang's expression bridge for the platform: each entry point that
// parses or lowers a text does it with the artifact for its version (the
// parser/ entry points beside this package's checker). A slot is parsed into
// the bridge's own slot cache, so it is read from there as a slot the
// program's parse filled is. Everything else is movement-lang's own.

import type { ExprSlot } from 'movement-lang/parser/ast';
import type { MExpr } from 'movement-lang/parser/expression/tree';
import type { Expression } from 'movement-lang/expression/types';
import { treeOfSlot as liveTreeOfSlot, type MovementCondition } from 'movement-lang/expression/bridge';
import { BridgeError } from 'movement-lang/expression/error';
import { slotTrees } from 'movement-lang/expression/slot_trees';
import {
  lowerConditionAt,
  lowerExpressionAt,
  lowerMovementCondition,
  lowerMovementExpression,
} from '../parser/expression/lower';
import { ExpressionSyntaxError, parseExpression } from '../parser/expression/parse_expression';

export * from 'movement-lang/expression/bridge';

export function parseMovementExpression(raw: string, languageVersion?: number): Expression {
  return lowerMovementExpression(raw, languageVersion);
}

export function parseMovementCondition(raw: string, languageVersion?: number): MovementCondition {
  return lowerMovementCondition(raw, languageVersion);
}

/** Reads a slot that arrived without its tree under `languageVersion` (as
 *  movement-lang's bridge does), with the parser for that version. */
function primed(slot: ExprSlot, languageVersion: number | undefined): ExprSlot {
  if (slotTrees.has(slot)) return slot;
  let tree: MExpr | ExpressionSyntaxError;
  try {
    tree = parseExpression(slot.raw, languageVersion);
  } catch (e) {
    if (!(e instanceof ExpressionSyntaxError)) throw e;
    tree = e;
  }
  slotTrees.set(slot, tree);
  return slot;
}

export function treeOfSlot(slot: ExprSlot, languageVersion?: number): MExpr {
  return liveTreeOfSlot(primed(slot, languageVersion), languageVersion);
}

/** The slot as a value expression, lowered by the artifact that reads
 *  `languageVersion` (../parser/expression/lower.ts). */
export function expressionOfSlot(slot: ExprSlot, languageVersion?: number): Expression {
  return lowerExpressionAt(treeOfSlot(slot, languageVersion), slot.raw, languageVersion);
}

/** The slot as an `if` condition, lowered as `expressionOfSlot` is. */
export function conditionOfSlot(slot: ExprSlot, languageVersion?: number): MovementCondition {
  return lowerConditionAt(treeOfSlot(slot, languageVersion), slot.raw, languageVersion);
}

/** movement-lang's `authoredStringText`, its text read as versions 1 to 4
 *  read a probe's. */
export function authoredStringText(raw: string): string {
  let tree: MExpr;
  try {
    tree = parseExpression(raw);
  } catch (e) {
    if (e instanceof BridgeError) return raw;
    throw e;
  }
  if (tree.kind !== 'string' || tree.quote !== '"') return raw;
  if (tree.parts.every(p => typeof p === 'string')) return tree.parts.join('');
  // Interpolating: the source between the quotes, `${…}` and all.
  return raw.slice(tree.at.start + 1, tree.at.end - 1);
}
