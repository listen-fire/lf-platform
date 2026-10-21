import { parseMaxCallDepth } from '../call_depth';

describe('MOVEMENT_MAX_CALL_DEPTH', () => {
  it('refuses a value that is not a positive whole number', () => {
    expect(parseMaxCallDepth(undefined)).toBe(32);
    expect(parseMaxCallDepth('64')).toBe(64);
    for (const bad of ['0', '-3', '2.5', 'deep']) {
      expect(() => parseMaxCallDepth(bad)).toThrow(/MOVEMENT_MAX_CALL_DEPTH=".*" is not a positive whole number/);
    }
  });
});
