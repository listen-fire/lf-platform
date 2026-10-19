// Answer typing (the module's answer semantics). The family
// IS the answer's type declaration — `coerceAnswer` is where "the surface
// control and the stored answer can never disagree" is enforced until the
// checker parameterizes `Provide<T>` (a later chunk). Pure (no DB).

import { coerceAnswer } from '../answers';
import type { AskAnswerType, AskFamily, AskRowSpec, StoredAsk } from '../types';

function ask(family: AskFamily, extra: Partial<StoredAsk> = {}): StoredAsk {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    family,
    answerType: null,
    prompt: 'Q?',
    detail: null,
    options: null,
    rows: null,
    state: 'open',
    answer: null,
    token: 'ask_tok',
    tokenExpiresAt: new Date(Date.now() + 1000).toISOString(),
    provenance: {},
    createdAt: new Date().toISOString(),
    answeredAt: null,
    expiredAt: null,
    ...extra,
  };
}

describe('coerceAnswer — Check (boolean)', () => {
  it.each([
    ['true', true],
    ['false', false],
    [true, true],
    [false, false],
  ])('accepts %p → %p', (raw, expected) => {
    expect(coerceAnswer(ask('Check'), raw)).toEqual({ ok: true, value: expected });
  });

  it('rejects a non-boolean', () => {
    expect(coerceAnswer(ask('Check'), 'maybe')).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('coerceAnswer — Review (acknowledgement)', () => {
  it('any submission is an ack', () => {
    expect(coerceAnswer(ask('Review'), 'anything')).toEqual({ ok: true, value: 'ack' });
    expect(coerceAnswer(ask('Review'), undefined)).toEqual({ ok: true, value: 'ack' });
  });
});

describe('coerceAnswer — Choose (exactly one of the options)', () => {
  const withOptions = ask('Choose', { options: ['red', 'green', 'blue'] });

  it('accepts a listed option', () => {
    expect(coerceAnswer(withOptions, 'green')).toEqual({ ok: true, value: 'green' });
  });

  it('takes the first element of an array submission', () => {
    expect(coerceAnswer(withOptions, ['blue'])).toEqual({ ok: true, value: 'blue' });
  });

  it('rejects an unlisted option', () => {
    expect(coerceAnswer(withOptions, 'purple')).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('coerceAnswer — Provide (typed by answerType)', () => {
  function provide(answerType: AskAnswerType): StoredAsk {
    return ask('Provide', { answerType });
  }

  it('text: keeps the string, rejects empty', () => {
    expect(coerceAnswer(provide('text'), 'hi')).toEqual({ ok: true, value: 'hi' });
    expect(coerceAnswer(provide('text'), '   ')).toEqual({ ok: false, error: expect.any(String) });
  });

  it('number: coerces + rejects non-numbers', () => {
    expect(coerceAnswer(provide('number'), '42')).toEqual({ ok: true, value: 42 });
    expect(coerceAnswer(provide('number'), 7)).toEqual({ ok: true, value: 7 });
    expect(coerceAnswer(provide('number'), 'lots')).toEqual({ ok: false, error: expect.any(String) });
  });

  it('date: accepts a parseable date, rejects gibberish', () => {
    expect(coerceAnswer(provide('date'), '2026-07-29')).toEqual({ ok: true, value: '2026-07-29' });
    expect(coerceAnswer(provide('date'), 'someday')).toEqual({ ok: false, error: expect.any(String) });
  });

  it('boolean: same yes/no decode as Check', () => {
    expect(coerceAnswer(provide('boolean'), 'true')).toEqual({ ok: true, value: true });
    expect(coerceAnswer(provide('boolean'), 'false')).toEqual({ ok: true, value: false });
  });
});

describe('coerceAnswer — Select (a subset of the options, possibly empty)', () => {
  const withOptions = ask('Select', { options: ['red', 'green', 'blue'] });

  it('accepts a subset of listed options, deduped', () => {
    expect(coerceAnswer(withOptions, ['green', 'blue', 'green'])).toEqual({
      ok: true,
      value: ['green', 'blue'],
    });
  });

  it('accepts a single string as a one-element selection', () => {
    expect(coerceAnswer(withOptions, 'red')).toEqual({ ok: true, value: ['red'] });
  });

  it('accepts an empty selection — "none of these" is valid (mirrors the link page checklist)', () => {
    expect(coerceAnswer(withOptions, [])).toEqual({ ok: true, value: [] });
    expect(coerceAnswer(withOptions, undefined)).toEqual({ ok: true, value: [] });
  });

  it('drops the hidden empty-string entry the checklist form always submits', () => {
    expect(coerceAnswer(withOptions, ['', 'green'])).toEqual({ ok: true, value: ['green'] });
  });

  it('rejects an unlisted option anywhere in the selection', () => {
    expect(coerceAnswer(withOptions, ['green', 'purple'])).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('coerceAnswer — Correct ({ rows, dropped } against the offered rows)', () => {
  const offered: AskRowSpec[] = [
    { ephemeralId: 'row-0', fields: { name: 'Acme' } },
    { ephemeralId: 'row-1', fields: { name: 'Beta' } },
  ];
  const withRows = ask('Correct', { rows: offered });

  it('accepts edits to known rows and a known drop', () => {
    expect(
      coerceAnswer(withRows, { rows: [{ ephemeralId: 'row-0', fields: { name: 'Acme Inc' } }], dropped: ['row-1'] }),
    ).toEqual({ ok: true, value: { rows: [{ ephemeralId: 'row-0', fields: { name: 'Acme Inc' } }], dropped: ['row-1'] } });
  });

  it('accepts a no-op submission (no edits, nothing dropped)', () => {
    expect(coerceAnswer(withRows, { rows: [], dropped: [] })).toEqual({ ok: true, value: { rows: [], dropped: [] } });
  });

  it('rejects an edit to an unknown row', () => {
    expect(coerceAnswer(withRows, { rows: [{ ephemeralId: 'row-9', fields: {} }], dropped: [] })).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });

  it('rejects a drop of an unknown row', () => {
    expect(coerceAnswer(withRows, { rows: [], dropped: ['row-9'] })).toEqual({ ok: false, error: expect.any(String) });
  });

  it('rejects a non-object answer', () => {
    expect(coerceAnswer(withRows, 'nope')).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('coerceAnswer — Draft (a structured artifact)', () => {
  it('accepts a plain object', () => {
    expect(coerceAnswer(ask('Draft'), { memo: 'Ship it', summary: 'Looks good' })).toEqual({
      ok: true,
      value: { memo: 'Ship it', summary: 'Looks good' },
    });
  });

  it('rejects a scalar or array', () => {
    expect(coerceAnswer(ask('Draft'), 'just text')).toEqual({ ok: false, error: expect.any(String) });
    expect(coerceAnswer(ask('Draft'), ['a', 'b'])).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('coerceAnswer — Form (a value for every declared field)', () => {
  const withFields = ask('Form', { options: ['call', 'cap'] });

  it('accepts an object with exactly the declared fields', () => {
    expect(coerceAnswer(withFields, { call: 'Pursue', cap: '250000' })).toEqual({
      ok: true,
      value: { call: 'Pursue', cap: '250000' },
    });
  });

  it('rejects a missing field', () => {
    expect(coerceAnswer(withFields, { call: 'Pursue' })).toEqual({ ok: false, error: expect.any(String) });
  });

  it('rejects an unexpected extra field', () => {
    expect(coerceAnswer(withFields, { call: 'Pursue', cap: '1', extra: 'nope' })).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });

  it('rejects a non-object answer', () => {
    expect(coerceAnswer(withFields, 'nope')).toEqual({ ok: false, error: expect.any(String) });
  });
});
