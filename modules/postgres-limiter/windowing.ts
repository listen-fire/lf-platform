// The limiter's decision, apart from the database that holds its state: given
// the buckets' stored counts and the instant, is a call granted, and if not,
// when to ask again. The same token bucket as the in-process built-in
// (MemoryLimiter), so the two limiters mean one thing by `calls`/`perMs`.

import type { LimitRequest } from 'movement-engine/public/limiter';

/** How soon a call refused for concurrency asks again if nothing frees a
 *  place sooner (a release carries no wake-up across hosts). */
export const CONCURRENCY_RECHECK_MS = 1_000;

/** A bucket as stored: tokens as of `filledAt` (epoch ms). */
export interface BucketState {
  tokens: number;
  filledAt: number;
}

/** The permits live in a bucket: how many, and when the first lapses. */
export interface HeldState {
  count: number;
  soonestLapse: number;
}

export type Decision =
  | { granted: false; retryAt: number }
  | {
      granted: true;
      /** The buckets to store back, with the call counted. */
      buckets: Map<string, BucketState>;
      /** The buckets the permit holds a place in. */
      holds: string[];
    };

/** What a new bucket holds: a rate limit's bucket starts full. */
export function freshTokens(limit: { calls?: number }): number {
  return limit.calls ?? 0;
}

export function decide(input: { request: LimitRequest; buckets: ReadonlyMap<string, BucketState>; held: ReadonlyMap<string, HeldState>; now: number }): Decision {
  const { request, now } = input;
  const current = new Map<string, BucketState>();
  let retryAt: number | undefined;
  const later = (at: number) => (retryAt = retryAt === undefined ? at : Math.max(retryAt, at));

  for (const limit of request.limits) {
    const stored = input.buckets.get(limit.key) ?? { tokens: freshTokens(limit), filledAt: now };
    if (limit.calls !== undefined && limit.perMs !== undefined) {
      const rate = limit.calls / limit.perMs;
      const tokens = Math.min(limit.calls, stored.tokens + Math.max(0, now - stored.filledAt) * rate);
      current.set(limit.key, { tokens, filledAt: now });
      // A call costing more than the whole window waits for a full one.
      const cost = Math.min(request.cost, limit.calls);
      if (tokens < cost) later(now + Math.ceil((cost - tokens) / rate));
    } else if (!current.has(limit.key)) {
      current.set(limit.key, { ...stored });
    }
    const held = input.held.get(limit.key);
    if (limit.concurrent !== undefined && held !== undefined && held.count >= limit.concurrent) {
      later(Math.min(held.soonestLapse, now + CONCURRENCY_RECHECK_MS));
    }
  }
  if (retryAt !== undefined) return { granted: false, retryAt };

  const holds: string[] = [];
  for (const limit of request.limits) {
    const bucket = current.get(limit.key);
    if (bucket === undefined) continue;
    if (limit.calls !== undefined) bucket.tokens -= Math.min(request.cost, limit.calls);
    if (limit.concurrent !== undefined) holds.push(limit.key);
  }
  return { granted: true, buckets: current, holds };
}
