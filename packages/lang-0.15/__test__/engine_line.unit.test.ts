// 0.15's line answers in 0.15's own terms and hands back plain data only: a
// text the current release refuses (it pins 0.15) parses and checks here, and
// a failure is its name and message, never one of 0.15's classes.

import { ENGINE_LINE, LANGUAGE_VERSION } from '..';

const SOURCE = 'movement go() {\n  x = @user_email\n}\n';

describe("0.15's engine line", () => {
  it('is release 0.15.3, on host families version 2', () => {
    expect(LANGUAGE_VERSION).toBe('0.15.3');
    expect(ENGINE_LINE.hostFamiliesVersion).toBe(2);
  });

  it('parses a text pinned to 0.15 that reads @user_email', () => {
    const parsed = ENGINE_LINE.parse(SOURCE, { languageVersion: '0.15.3' });
    expect(parsed.ok).toBe(true);
  });

  it('answers a text it cannot parse as plain data', () => {
    const parsed = ENGINE_LINE.parse('movement go( {', { languageVersion: '0.15.3' });
    expect(parsed).toEqual({ ok: false, message: expect.any(String), loc: { line: expect.any(Number), col: expect.any(Number) } });
    if (!parsed.ok) expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it('refuses a 0.16 pin by name, as 0.15 refuses a newer release', () => {
    const parsed = ENGINE_LINE.parse(SOURCE, { languageVersion: '0.16.0' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/0\.16\.0/);
  });
});
