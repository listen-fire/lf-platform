// Reachability, for the checker's control-flow narrowing.
//
// One question, asked of a statement list: does control ALWAYS leave it,
// rather than falling through to whatever comes next? That is what makes the
// guard clause work —
//
//   if channel == null { ERROR("channel not found") }
//   if channel == null { return "none" }
//   write channel-[:Messages]-> { … }
//
// — because reaching the write means the `if` was not taken, so the condition's
// NEGATION holds below it (`checkIf` declares that narrowing). TypeScript's own
// analysis, with `ERROR` in the role of `throw`: its type is `never`. `return`
// leaves the body just as surely (an `if` arm is transparent to it), so the
// checker counts it from version 3; before that only `ERROR` did, and a saved
// movement keeps the reading it was written against.
//
// Whether a `return` counts is the CALLER's to say, because "leaves this list"
// and "ends the run" part ways there: a `return` in a race arm's closure hands
// the race its value and the run carries on, where an `ERROR` would not.
//
// Deliberately shallow. Every construct that is not listed falls through, which
// is the safe answer: a missed terminator costs a narrowing the author could
// have had, while a wrong one would hand out a narrowing that isn't true.

import { Statement } from 'movement-lang/parser/ast';
import { type LanguageVersion } from 'movement-lang/language_version';
import { since } from '../version_conditionals';

/**
 * Does every path through `statements` leave before the end of the list?
 *
 * - `ERROR(…)` fails the run (`interpretError` throws), so it terminates.
 * - `return …` leaves the nearest body, when `exits.returns` says it counts.
 * - an `if` terminates only when EVERY arm does AND there is an `else` that
 *   does too — without the else, the no-arm-taken path falls straight through.
 * - anything after a terminator is unreachable, so a terminator ANYWHERE in the
 *   list terminates the list.
 */
export function terminates(statements: Statement[], exits: Exits): boolean {
  return statements.some(statement => terminatesStatement(statement, exits));
}

export interface Exits {
  /** A `return` leaves the list too — not only an `ERROR`. */
  returns: boolean;
}

/** What leaves a body under `languageVersion` — the rule the checker narrows
 *  by, so anything projecting termination for an `if` arm asks this too. */
export function bodyExits(languageVersion: LanguageVersion): Exits {
  return { returns: since(languageVersion, 3) };
}

function terminatesStatement(statement: Statement, exits: Exits): boolean {
  if (statement.kind === 'error') return true;
  if (statement.kind === 'return') return exits.returns;
  if (statement.kind === 'if') {
    return (
      statement.elseArm !== undefined
      && terminates(statement.elseArm.body, exits)
      && statement.arms.every(arm => terminates(arm.body, exits))
    );
  }
  return false;
}
