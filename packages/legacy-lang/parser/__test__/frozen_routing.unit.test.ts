// Which artifact reads a text: the language release's own parser for the
// release's pins, the frozen one for the legacy ids ('1'..'4') and for the
// version-0 expression surface.
import * as loader from 'movement-lang/wasm/loader';
import { LANGUAGE_VERSION } from 'movement-lang/language_version';
import { PLATFORM_SUPPORTED_LANGUAGE_VERSIONS } from '../../language_version';
import { readByLanguage } from '../rust_parser';
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
    frozenExtras: () => old.mock.calls.map(([, , extra]) => extra),
    restore: () => {
      live.mockRestore();
      old.mockRestore();
    },
  };
}

describe('the platform routes each parse by its version', () => {
  it('the platform reads the legacy ids 1 to 4, and the language release the rest', () => {
    expect([...PLATFORM_SUPPORTED_LANGUAGE_VERSIONS]).toEqual(['1', '2', '3', '4']);
  });

  it('a version 4 program is read by the frozen parser', () => {
    const spy = spies();
    parseProgram(SOURCE, { languageVersion: '4' });
    expect(spy.calls()).toEqual({ live: [], frozen: ['parse_program_eager'] });
    expect(spy.frozenExtras()).toEqual([[4]]);
    spy.restore();
  });

  it('a version 5 program is read by the live parser', () => {
    const spy = spies();
    parseProgram(SOURCE, { languageVersion: LANGUAGE_VERSION });
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
    parseExpression('a && !b', LANGUAGE_VERSION);
    expect(spy.calls()).toEqual({ live: ['parse_expression'], frozen: [] });
    spy.restore();
  });

  it('a slot without its tree is read under its program\'s version', () => {
    const span = { start: { line: 1, col: 1 }, end: { line: 1, col: 2 } };
    const spy = spies();
    treeOfSlot({ raw: 'b', span }, '4');
    treeOfSlot({ raw: 'b', span }, LANGUAGE_VERSION);
    expect(spy.calls()).toEqual({ live: ['parse_expression'], frozen: ['parse_expression'] });
    spy.restore();
  });

  it('a nested call is read by the parser for its version', () => {
    const slot: ExprSlot = { raw: '1 + f(x)', span: { start: { line: 4, col: 9 }, end: { line: 4, col: 17 } } };
    const spy = spies();
    const old = parseNestedCall(slot, { start: 4, end: 8 }, '3');
    const current = parseNestedCall({ ...slot }, { start: 4, end: 8 }, LANGUAGE_VERSION);
    expect(spy.calls()).toEqual({ live: ['parse_nested_call'], frozen: ['parse_nested_call'] });
    expect(old).toMatchObject({ kind: 'call', call: { callee: 'f' } });
    expect(current).toMatchObject({ kind: 'call', call: { callee: 'f' } });
    spy.restore();
  });
});

describe('readByLanguage', () => {
  it('a legacy id is read by the frozen parser, handed its integer', () => {
    const spy = spies();
    expect(readByLanguage('4')).toBe(false);
    parseProgram(SOURCE, { languageVersion: '4' });
    expect(spy.frozenExtras()).toEqual([[4]]);
    spy.restore();
  });

  it('version 0, the expression surface of a probe, is read by the frozen parser with 0', () => {
    const spy = spies();
    expect(readByLanguage('0')).toBe(false);
    parseExpression('a AND NOT b', '0');
    expect(spy.calls()).toEqual({ live: [], frozen: ['parse_expression'] });
    expect(spy.frozenExtras()).toEqual([[0]]);
    spy.restore();
  });

  it("a release's semver is read by the live parser, with no pin handed on", () => {
    const spy = spies();
    expect(readByLanguage('0.12.0')).toBe(true);
    expect(readByLanguage(LANGUAGE_VERSION)).toBe(true);
    parseProgram(SOURCE, { languageVersion: '0.12.0' });
    expect(spy.calls()).toEqual({ live: ['parse_program_eager'], frozen: [] });
    expect(spy.frozenExtras()).toEqual([]);
    spy.restore();
  });
});
