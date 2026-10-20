import type { LimitRequest } from 'movement-engine/public/limiter';
import { decide, type BucketState, type HeldState } from '../windowing';
import { schemaIdentifier } from '../schema';

const NOW = 1_000_000;

function request(limits: LimitRequest['limits'], cost = 1): LimitRequest {
  return { key: 'caller', cost, limits, holdMs: 60_000 };
}

function run(limits: LimitRequest['limits'], options: { buckets?: [string, BucketState][]; held?: [string, HeldState][]; cost?: number; now?: number } = {}) {
  return decide({ request: request(limits, options.cost), buckets: new Map(options.buckets), held: new Map(options.held), now: options.now ?? NOW });
}

describe('rate windows', () => {
  const rate = { key: 'r', calls: 4, perMs: 1_000 };

  test('a new bucket starts full and the call is counted', () => {
    const decision = run([rate]);
    expect(decision).toMatchObject({ granted: true, holds: [] });
    if (decision.granted) expect(decision.buckets.get('r')).toEqual({ tokens: 3, filledAt: NOW });
  });

  test('an empty bucket refuses and says when one call has refilled', () => {
    const decision = run([rate], { buckets: [['r', { tokens: 0, filledAt: NOW }]] });
    expect(decision).toEqual({ granted: false, retryAt: NOW + 250 });
  });

  test('elapsed time refills the bucket, never past full', () => {
    const half = run([rate], { buckets: [['r', { tokens: 0, filledAt: NOW - 500 }]] });
    if (half.granted) expect(half.buckets.get('r')?.tokens).toBeCloseTo(1);
    const long = run([rate], { buckets: [['r', { tokens: 0, filledAt: NOW - 60_000 }]] });
    if (long.granted) expect(long.buckets.get('r')?.tokens).toBe(3);
  });

  test('a cost counts for that many calls, and waits as long as the shortfall', () => {
    const buckets: [string, BucketState][] = [['r', { tokens: 1, filledAt: NOW }]];
    expect(run([rate], { buckets, cost: 3 })).toEqual({ granted: false, retryAt: NOW + 500 });
  });

  test('a cost above the whole window waits for a full bucket, then takes it all', () => {
    expect(run([rate], { cost: 10, buckets: [['r', { tokens: 1, filledAt: NOW }]] })).toEqual({ granted: false, retryAt: NOW + 750 });
    const decision = run([rate], { cost: 10 });
    if (decision.granted) expect(decision.buckets.get('r')?.tokens).toBe(0);
  });

  test('a clock that stands still or steps back refills nothing', () => {
    const decision = run([rate], { buckets: [['r', { tokens: 2, filledAt: NOW + 5_000 }]] });
    if (decision.granted) expect(decision.buckets.get('r')?.tokens).toBe(1);
  });
});

describe('concurrency', () => {
  const one = { key: 'c', concurrent: 2 };

  test('room under the limit grants and holds a place in the bucket', () => {
    expect(run([one], { held: [['c', { count: 1, soonestLapse: NOW + 5 }]] })).toMatchObject({ granted: true, holds: ['c'] });
  });

  test('a full bucket refuses until the first permit lapses', () => {
    expect(run([one], { held: [['c', { count: 2, soonestLapse: NOW + 300 }]] })).toEqual({ granted: false, retryAt: NOW + 300 });
  });

  test('a lapse further off than the recheck interval is not waited for', () => {
    expect(run([one], { held: [['c', { count: 2, soonestLapse: NOW + 60_000 }]] })).toEqual({ granted: false, retryAt: NOW + 1_000 });
  });
});

describe('several limits at once', () => {
  test('a refusal counts the call in none of them', () => {
    const decision = run([{ key: 'r', calls: 5, perMs: 1_000 }, { key: 'c', concurrent: 1 }], { held: [['c', { count: 1, soonestLapse: NOW + 100 }]] });
    expect(decision.granted).toBe(false);
  });

  test('the latest retry among the refusals stands', () => {
    const decision = run([{ key: 'r', calls: 1, perMs: 1_000 }, { key: 'c', concurrent: 1 }], {
      buckets: [['r', { tokens: 0, filledAt: NOW }]],
      held: [['c', { count: 1, soonestLapse: NOW + 100 }]],
    });
    expect(decision).toEqual({ granted: false, retryAt: NOW + 1_000 });
  });

  test('a grant counts in every limit', () => {
    const decision = run([{ key: 'r', calls: 5, perMs: 1_000 }, { key: 'c', concurrent: 1 }]);
    expect(decision).toMatchObject({ granted: true, holds: ['c'] });
    if (decision.granted) expect(decision.buckets.get('r')?.tokens).toBe(4);
  });
});

describe('the schema name', () => {
  test('is quoted, and refuses anything that could be SQL', () => {
    expect(schemaIdentifier('lf_postgres_limiter')).toBe('"lf_postgres_limiter"');
    expect(() => schemaIdentifier('x"; drop table y; --')).toThrow();
    expect(() => schemaIdentifier('1abc')).toThrow();
  });
});
