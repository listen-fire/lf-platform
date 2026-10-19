// Expiring key-value store behind the API's caches (favicons, MCP OAuth flow state). Redis when
// MESSAGE_QUEUE_REDIS_HOSTNAME is set, otherwise the automations.cache_entry table, so the API
// needs no Redis to boot or to cache. The backend is picked once, at load.
//
// Errors propagate: each caller decides what a broken cache means for it (a miss, a degraded flow).

import { redisConfigured } from '../../redisPool';
import { postgresTtlCache } from './postgres';
import { redisTtlCache } from './redis';

export interface TtlCache {
  /** The value, or null when absent or expired. */
  get(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer, ttlMs: number): Promise<void>;
  /** Single use: returns the value and removes it, so only one caller can ever receive it. */
  take(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export const ttlCache: TtlCache = redisConfigured() ? redisTtlCache : postgresTtlCache;
