// With no Redis configured, the caches and the loop guard's counters run on the cache_entry table
// (real DB): values expire, single-use reads are single-use, counters add and age out, and the
// Redis pool is never asked for.

const getRedisPool = jest.fn(() => {
  throw new Error('Redis must not be used');
});

jest.mock('../../../redisPool', () => ({ redisConfigured: () => false, getRedisPool }));

import { sql } from 'kysely';

import { postgresBucketBackend } from '../../loop_guard/counters/postgres';
import { describeCounterContract } from '../../loop_guard/__test__/counter_contract';
import { incrementAndSum, resetWindow } from '../../loop_guard/store';
import { globalQb } from '../../../lib/kysely';
import { ttlCache } from '..';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterAll(async () => {
  await sql`DELETE FROM automations.cache_entry WHERE key LIKE 'ttltest:%' OR key LIKE 'loopguard:test:%'`.execute(
    globalQb,
  );
  expect(getRedisPool).not.toHaveBeenCalled();
});

describe('ttlCache on Postgres', () => {
  it('stores and returns bytes exactly', async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0]);
    await ttlCache.set('ttltest:bytes', bytes, 60_000);
    expect((await ttlCache.get('ttltest:bytes'))?.equals(bytes)).toBe(true);
  });

  it('reads a miss as null', async () => {
    expect(await ttlCache.get('ttltest:absent')).toBeNull();
  });

  it('honours expiry', async () => {
    await ttlCache.set('ttltest:short', Buffer.from('x'), 300);
    expect(await ttlCache.get('ttltest:short')).not.toBeNull();
    await sleep(450);
    expect(await ttlCache.get('ttltest:short')).toBeNull();
  });

  it('overwrites and renews a key', async () => {
    await ttlCache.set('ttltest:renew', Buffer.from('a'), 300);
    await ttlCache.set('ttltest:renew', Buffer.from('b'), 60_000);
    await sleep(450);
    expect((await ttlCache.get('ttltest:renew'))?.toString()).toBe('b');
  });

  it('take returns the value once', async () => {
    await ttlCache.set('ttltest:once', Buffer.from('v'), 60_000);
    expect((await ttlCache.take('ttltest:once'))?.toString()).toBe('v');
    expect(await ttlCache.take('ttltest:once')).toBeNull();
  });

  it('take does not return an expired value', async () => {
    await ttlCache.set('ttltest:stale', Buffer.from('v'), 200);
    await sleep(350);
    expect(await ttlCache.take('ttltest:stale')).toBeNull();
  });

  it('delete removes a key', async () => {
    await ttlCache.set('ttltest:del', Buffer.from('v'), 60_000);
    await ttlCache.delete('ttltest:del');
    expect(await ttlCache.get('ttltest:del')).toBeNull();
  });
});

describe('loop guard counters on Postgres', () => {
  describeCounterContract();

  it('expires a bucket after its time to live', async () => {
    await postgresBucketBackend.addAndRead({
      bucketKey: 'loopguard:test:ttl',
      amount: 5,
      ttlSeconds: 1,
      readKeys: ['loopguard:test:ttl'],
      nowMs: Date.now(),
    });
    await sleep(1200);
    const [value] = await postgresBucketBackend.addAndRead({
      bucketKey: 'loopguard:test:ttl',
      amount: 1,
      ttlSeconds: 60,
      readKeys: ['loopguard:test:ttl'],
      nowMs: Date.now(),
    });
    expect(value).toBe(1);
  });

  it('counts across the store with real time and resets a window', async () => {
    const key = 'loopguard:test:real';
    await incrementAndSum({ key, windowSeconds: 30, amount: 2 });
    const r = await incrementAndSum({ key, windowSeconds: 30, amount: 3 });
    expect(r).toEqual({ total: 5, failOpen: false });
    await resetWindow({ key, windowSeconds: 30 });
    expect((await incrementAndSum({ key, windowSeconds: 30, amount: 1 })).total).toBe(1);
  });
});
