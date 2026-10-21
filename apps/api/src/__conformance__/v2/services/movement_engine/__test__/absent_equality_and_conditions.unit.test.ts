// Equality and conditions over a value that may be absent, at run time.
//
// The checker accepts `x == "a"`, `x != "a"`, `if x`, `NOT x`, `x AND y`
// where `x` may be absent (TypeScript's reading of `undefined`): absent is
// equal only to absent, and reads as false in a condition. This pins the
// runtime half so the two cannot drift. Absent arrives as `undefined` (a key
// the record lacks) or `null` (an explicit empty) — both are exercised, since
// the author cannot tell them apart. (Two reads of DIFFERENT absent spellings
// still compare strictly — `shared_filter`'s "undefined is NOT null there".)

import { Environment, evalMovementExpr } from '../expression';
import { parseMovementCondition, parseMovementExpression } from 'movement-lang';
import { evaluatePredicate } from 'movement-lang/expression/filter';

async function evaluate(raw: string, bindings: Record<string, unknown>): Promise<unknown> {
  const env = new Environment();
  for (const [name, value] of Object.entries(bindings)) env.declare(name, { kind: 'value', value });
  return (await evalMovementExpr(parseMovementExpression(raw), { env })).value;
}

const ABSENT: ReadonlyArray<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
];

describe.each(ABSENT)('an absent value (%s) in the engine', (_label, absent) => {
  const cases: ReadonlyArray<[string, Record<string, unknown>, boolean]> = [
    ['x == "a"', { x: absent }, false],
    ['"a" == x', { x: absent }, false],
    ['x != "a"', { x: absent }, true],
    ['x == null', { x: absent }, true],
    ['x != null', { x: absent }, false],
    ['x == y', { x: absent, y: absent }, true],
    ['x != y', { x: absent, y: absent }, false],
    ['x == y', { x: absent, y: false }, false],
    ['NOT x', { x: absent }, true],
    ['x AND true', { x: absent }, false],
    ['true AND x', { x: absent }, false],
    ['x OR true', { x: absent }, true],
    ['x OR false', { x: absent }, false],
  ];

  it.each(cases)('%s → %s', async (raw, bindings, expected) => {
    await expect(evaluate(raw, bindings)).resolves.toBe(expected);
  });

  it('a statement `if absent` is not taken', async () => {
    // The run reads a statement condition as `Boolean(value)` of its
    // expression (`evaluateParsedCondition`); this is that expression.
    const condition = parseMovementCondition('x');
    if (condition.kind !== 'expr') throw new Error(`expected an expression condition, got ${condition.kind}`);
    const env = new Environment();
    env.declare('x', { kind: 'value', value: absent });
    expect(Boolean((await evalMovementExpr(condition.expr, { env })).value)).toBe(false);
  });

  it('IF absent THEN … ELSE … END takes the ELSE', async () => {
    await expect(evaluate('IF x THEN "then" ELSE "else" END', { x: absent })).resolves.toBe('else');
  });
});

describe('a present value is unchanged', () => {
  it('== and != stay strict', async () => {
    await expect(evaluate('x == "a"', { x: 'a' })).resolves.toBe(true);
    await expect(evaluate('x != "a"', { x: 'a' })).resolves.toBe(false);
    await expect(evaluate('x == 0', { x: '0' })).resolves.toBe(false);
  });

  it('false is present, and not equal to absent', async () => {
    await expect(evaluate('x == y', { x: false, y: null })).resolves.toBe(false);
    await expect(evaluate('x == null', { x: false })).resolves.toBe(false);
  });
});

describe.each(ABSENT)('an absent field in an in-app WHERE (%s)', (_label, absent) => {
  const scope = { read: (name: string) => (name === 'Stage' ? absent : undefined) };
  const cases: ReadonlyArray<[string, boolean]> = [
    ['Stage == "Seed"', false],
    ['Stage != "Seed"', true],
    ['Stage == null', true],
    ['NOT Stage', true],
    ['Stage AND true', false],
    ['Stage OR true', true],
  ];

  it.each(cases)('%s → %s', (raw, expected) => {
    expect(evaluatePredicate(parseMovementExpression(raw), scope)).toBe(expected);
  });
});
