// With a Redis hostname configured the cache is Redis, as before: values go through the pooled
// client with a millisecond expiry, and Postgres is never touched.

const store = new Map<string, Buffer>();
const set = jest.fn(async (key: string, value: Buffer) => {
  store.set(key, value);
  return 'OK';
});
const client = {
  getBuffer: jest.fn(async (key: string) => store.get(key) ?? null),
  set,
  del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
};
const pool = { acquire: jest.fn(async () => client), release: jest.fn(async () => {}) };

jest.mock('../../../redisPool', () => ({
  redisConfigured: () => true,
  getRedisPool: () => pool,
}));
jest.mock('../../../lib/kysely', () => ({
  globalQb: new Proxy(
    {},
    {
      get: () => {
        throw new Error('Postgres must not be used');
      },
    },
  ),
}));

import { ttlCache } from '..';

describe('ttlCache on Redis', () => {
  it('sets with a millisecond expiry and reads back', async () => {
    await ttlCache.set('k', Buffer.from('v'), 1234);
    expect(set).toHaveBeenCalledWith('k', Buffer.from('v'), 'PX', 1234);
    expect((await ttlCache.get('k'))?.toString()).toBe('v');
  });

  it('take returns the value once', async () => {
    await ttlCache.set('once', Buffer.from('v'), 1000);
    expect((await ttlCache.take('once'))?.toString()).toBe('v');
    expect(await ttlCache.take('once')).toBeNull();
  });

  it('delete removes the key and releases the client', async () => {
    await ttlCache.set('gone', Buffer.from('v'), 1000);
    await ttlCache.delete('gone');
    expect(await ttlCache.get('gone')).toBeNull();
    expect(pool.release).toHaveBeenCalled();
  });
});
