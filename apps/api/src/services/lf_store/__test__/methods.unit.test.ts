// The manifest lists lf's 65 store methods, in lf's order, each with a handler.

import { LF_STORE_MANIFEST, hasHandler } from '../answer';
import { LF_STORE_METHODS } from '../methods';

describe('the store slot methods', () => {
  it('are the 65 lf lists, store.open first', () => {
    expect(LF_STORE_METHODS).toHaveLength(65);
    expect(new Set(LF_STORE_METHODS).size).toBe(65);
    expect(LF_STORE_METHODS[0]).toBe('store.open');
    expect(LF_STORE_MANIFEST.methods).toEqual([...LF_STORE_METHODS]);
  });

  it('each have a handler', () => {
    expect(LF_STORE_METHODS.filter((method) => !hasHandler(method))).toEqual([]);
    expect(hasHandler('runs.nothing')).toBe(false);
  });
});
