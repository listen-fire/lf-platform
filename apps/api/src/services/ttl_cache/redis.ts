import type { Redis } from 'ioredis';

import { getRedisPool } from '../../redisPool';
import type { TtlCache } from '.';

async function withClient<T>(fn: (client: Redis) => Promise<T>): Promise<T> {
  const pool = getRedisPool();
  const client = await pool.acquire();
  try {
    return await fn(client);
  } finally {
    pool.release(client).catch(() => {});
  }
}

export const redisTtlCache: TtlCache = {
  get: (key) => withClient((client) => client.getBuffer(key)),

  set: async (key, value, ttlMs) => {
    await withClient((client) => client.set(key, value, 'PX', ttlMs));
  },

  take: (key) =>
    withClient(async (client) => {
      const value = await client.getBuffer(key);
      if (value) await client.del(key);
      return value;
    }),

  delete: async (key) => {
    await withClient((client) => client.del(key));
  },
};
