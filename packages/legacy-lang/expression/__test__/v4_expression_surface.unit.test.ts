// The expression surface of versions 1 to 4 (version 0: a probe's text, read
// as those versions read it), which the language release no longer serves:
// the platform reads it with the frozen parser. These cases left the language
// package's own bridge and grammar tests when its default became version 5.
import { BridgeError, parseMovementCondition, parseMovementExpression } from '../bridge';
import { parseExpression } from '../../parser/expression/parse_expression';

/** The tree without offsets, for comparing shapes. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== 'at')
        .map(([k, v]) => [k, shape(v)]),
    );
  }
  return value;
}

const parse = (text: string) => shape(parseExpression(text));
const name = (text: string, quoted = false) => ({ kind: 'name', name: { text, quoted } });
const nameOnly = (text: string, quoted = false) => ({ text, quoted });

function refusal(raw: string): BridgeError {
  try {
    parseMovementExpression(raw);
  } catch (e) {
    if (e instanceof BridgeError) return e;
    throw e;
  }
  throw new Error(`expected '${raw}' to be refused`);
}

describe('the version 1 to 4 expression surface', () => {
  it('! sits at NOT precedence: !a = b is NOT (a = b), and a AND !b negates only b', () => {
    expect(parseMovementExpression('!a = b')).toEqual(parseMovementExpression('NOT a = b'));
    expect(parseMovementExpression('a AND !b')).toEqual(parseMovementExpression('a AND NOT b'));
  });

  it.each([
    ['a && b', '&', 2, 'AND'],
    ['a || b', '|', 2, 'OR'],
    ['a ? b : c', '?', 2, 'IF'],
  ])('%s → refuses %s at %d', (raw, ch, pos, hint) => {
    const e = refusal(raw);
    expect(e.message).toContain(`Unrecognised character '${ch}'`);
    expect(e.pos).toBe(pos);
    expect(e.message).toContain(hint);
  });

  it('an unrecognised character inside a hop WHERE is refused as well', () => {
    expect(refusal('EXISTS(x-[n:e WHERE `a` && `b`]->)').message).toContain("Unrecognised character '&'");
  });

  it('rejects IS under ! the same way — ! is NOT', () => {
    expect(() => parseMovementCondition('!rec IS <crm-[:company]->>')).toThrow(/not yet supported/);
  });

  it('reads every clause a hop can carry', () => {
    expect(parse('x-[r:Funding Round WHERE r.a == 1 ORDER BY r.b DESC LIMIT 3]->.c')).toEqual({
      kind: 'member',
      object: {
        kind: 'path',
        root: name('x'),
        hops: [
          {
            direction: 'out',
            arrow: '->',
            alias: nameOnly('r'),
            label: nameOnly('Funding Round'),
            where: {
              kind: 'binary',
              op: '==',
              left: { kind: 'member', object: name('r'), property: nameOnly('a') },
              right: { kind: 'literal', value: 1 },
            },
            orderBy: { key: { kind: 'member', object: name('r'), property: nameOnly('b') }, direction: 'desc' },
            limit: 3,
          },
        ],
      },
      property: nameOnly('c'),
    });
  });
});
