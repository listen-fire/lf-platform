// The team levels in order: each holds everything the one below it does.

import { isAccess, meets, narrower } from '../principal';

describe('a team level', () => {
  it('meets every level at or below it, and none above', () => {
    expect(meets('admin', 'write')).toBe(true);
    expect(meets('admin', 'read')).toBe(true);
    expect(meets('write', 'write')).toBe(true);
    expect(meets('write', 'admin')).toBe(false);
    expect(meets('read', 'write')).toBe(false);
    expect(meets('read', 'read')).toBe(true);
  });

  it('narrows to the lesser of two', () => {
    expect(narrower('admin', 'write')).toBe('write');
    expect(narrower('write', 'admin')).toBe('write');
    expect(narrower('admin', 'admin')).toBe('admin');
    expect(narrower('read', 'admin')).toBe('read');
  });

  it('is one of read, write and admin', () => {
    expect(['read', 'write', 'admin', 'owner', undefined].map(isAccess)).toEqual([true, true, true, false, false]);
  });
});
