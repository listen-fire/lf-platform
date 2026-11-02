// The manifest lists lf's store methods but `runs.rerun` (75), in lf's order, each with a handler.

import { LF_STORE_MANIFEST, hasHandler } from '../answer';
import { LF_STORE_METHODS } from '../methods';

describe('the store slot methods', () => {
  it('are the 75 lf lists but runs.rerun, store.open first', () => {
    expect(LF_STORE_METHODS).toHaveLength(75);
    expect(new Set(LF_STORE_METHODS).size).toBe(75);
    expect(LF_STORE_METHODS[0]).toBe('store.open');
    expect(LF_STORE_MANIFEST.methods).toEqual([...LF_STORE_METHODS]);
    expect(LF_STORE_METHODS).not.toContain('runs.rerun');
    for (const retired of ['callbacks.mint', 'correlations.correlate', 'records.closeRun']) expect(LF_STORE_METHODS).not.toContain(retired);
  });

  it('each have a handler', () => {
    expect(LF_STORE_METHODS.filter((method) => !hasHandler(method))).toEqual([]);
    expect(hasHandler('runs.nothing')).toBe(false);
  });
});
