// Which artifact reads a text: the language release's own parser for the
// versions it supports, the frozen one for every other pin and for the
// version-0 expression surface.
import * as loader from 'movement-lang/wasm/loader';
import { SUPPORTED_LANGUAGE_VERSIONS } from 'movement-lang/language_version';
import type { ExprSlot } from 'movement-lang/parser/ast';
import * as frozen from '../../wasm/frozen_parser';
import { parseNestedCall, parseProgram } from '../parse';
import { parseExpression } from '../expression/parse_expression';
import { parseMovementExpression, treeOfSlot } from '../../expression/bridge';

const SOURCE = 'movement noop() {\n  x = 1\n}\n';

function spies() {
  const live = jest.spyOn(loader, 'callParser');
  const old = jest.spyOn(frozen, 'callFrozenParser');
  return {
    calls: () => ({
      live: live.mock.calls.map(([fn]) => fn),
      frozen: old.mock.calls.map(([fn]) => fn),
    }),
    restore: () => {
      live.mockRestore();
      old.mockRestore();
    },
  };
}

describe('the platform routes each parse by its version', () => {
  it('the language release serves version 5 only', () => {
    expect([...SUPPORTED_LANGUAGE_VERSIONS]).toEqual([5]);
  });

  it('a version 4 program is read by the frozen parser', () => {
    const spy = spies();
    parseProgram(SOURCE, { languageVersion: 4 });
    expect(spy.calls()).toEqual({ live: [], frozen: ['parse_program_eager'] });
    spy.restore();
  });

  it('a version 5 program is read by the live parser', () => {
    const spy = spies();
    parseProgram(SOURCE, { languageVersion: 5 });
    expect(spy.calls()).toEqual({ live: ['parse_program_eager'], frozen: [] });
    spy.restore();
  });

  it('a version-0 expression (no version given) is read by the frozen parser', () => {
    const spy = spies();
    parseExpression('a AND NOT b');
    parseMovementExpression('a AND NOT b');
    expect(spy.calls()).toEqual({ live: [], frozen: ['parse_expression', 'parse_expression'] });
    spy.restore();
  });

  it('an expression read as part of a version 5 program is read by the live parser', () => {
    const spy = spies();
    parseExpression('a && !b', 5);
    expect(spy.calls()).toEqual({ live: ['parse_expression'], frozen: [] });
    spy.restore();
  });

  it('a slot without its tree is read under its program\'s version', () => {
    const span = { start: { line: 1, col: 1 }, end: { line: 1, col: 2 } };
    const spy = spies();
    treeOfSlot({ raw: 'b', span }, 4);
    treeOfSlot({ raw: 'b', span }, 5);
    expect(spy.calls()).toEqual({ live: ['parse_expression'], frozen: ['parse_expression'] });
    spy.restore();
  });

  it('a nested call is read by the parser for its version', () => {
    const slot: ExprSlot = { raw: '1 + f(x)', span: { start: { line: 4, col: 9 }, end: { line: 4, col: 17 } } };
    const spy = spies();
    const old = parseNestedCall(slot, { start: 4, end: 8 }, 3);
    const current = parseNestedCall({ ...slot }, { start: 4, end: 8 }, 5);
    expect(spy.calls()).toEqual({ live: ['parse_nested_call'], frozen: ['parse_nested_call'] });
    expect(old).toMatchObject({ kind: 'call', call: { callee: 'f' } });
    expect(current).toMatchObject({ kind: 'call', call: { callee: 'f' } });
    spy.restore();
  });
});
