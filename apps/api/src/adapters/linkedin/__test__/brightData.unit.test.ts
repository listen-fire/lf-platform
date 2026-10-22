// How long the profile service is allowed to keep the caller waiting.
//
// The service collects a profile asynchronously and is polled every five
// seconds, so waiting IS the cost: a lookup of one named person can afford
// minutes, while a fetch of whatever link each record happens to carry, run
// once per record across a fan-out, cannot. The wait is therefore the
// caller's to name, and the caller that names nothing gets the patience the
// adapter has always had.

// Sleeping is what the poll loop does, and the loop measures itself against
// the wall clock — so the sleep moves the clock instead of the test.
jest.mock('node:timers/promises', () => ({
  setTimeout: async (ms: number) => {
    jest.setSystemTime(Date.now() + ms);
  },
}));

import { installLimiter, MemoryLimiter } from 'movement-engine/public/limiter';

import { BrightDataAdapter } from '../brightData';

const PROFILE_URL = 'https://www.linkedin.com/in/ada-lovelace';

/** Answers as the dataset API does, with collection that never finishes
 *  unless `readyAfterPolls` says it does. Returns the poll counter. */
function serveProfileService({ readyAfterPolls }: { readyAfterPolls?: number } = {}) {
  const polls = { count: 0 };

  jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = String(input);

    if (url.includes('/datasets/v3/trigger')) {
      return new Response(JSON.stringify({ snapshot_id: 'snap-1' }), { status: 200 });
    }

    if (url.includes('/datasets/v3/progress/')) {
      polls.count += 1;
      const ready = readyAfterPolls != null && polls.count >= readyAfterPolls;
      return new Response(
        JSON.stringify({
          status: ready ? 'ready' : 'running',
          snapshot_id: 'snap-1',
          dataset_id: 'ds-1',
        }),
        { status: 200 },
      );
    }

    return new Response(JSON.stringify([{ id: 'p-1', name: 'Ada Lovelace' }]), { status: 200 });
  });

  return polls;
}

describe('the profile service’s wait', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    // The slot's in-process limiter, fresh for each test so no count carries over.
    installLimiter(new MemoryLimiter());
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('stops polling once the caller’s budget is spent, and returns nothing', async () => {
    const polls = serveProfileService();

    const result = await new BrightDataAdapter({ accessToken: 'k' }).getProfileTextByUrl(
      PROFILE_URL,
      { maxWaitMs: 15_000 },
    );

    // Three polls at five seconds apart, and then the caller has its answer:
    // nothing, fifteen seconds in, rather than nothing five minutes in.
    expect(polls.count).toBe(3);
    expect(result).toBeNull();
  });

  it('waits out the service’s own patience when the caller names no budget', async () => {
    const polls = serveProfileService();

    const result = await new BrightDataAdapter({ accessToken: 'k' }).getProfileTextByUrl(
      PROFILE_URL,
    );

    // Five minutes of five-second polls — the deliberate lookup's wait, left
    // exactly as it was.
    expect(polls.count).toBe(60);
    expect(result).toBeNull();
  });

  it('takes a profile that arrives inside the budget', async () => {
    const polls = serveProfileService({ readyAfterPolls: 2 });

    const result = await new BrightDataAdapter({ accessToken: 'k' }).getProfileTextByUrl(
      PROFILE_URL,
      { maxWaitMs: 15_000 },
    );

    expect(polls.count).toBe(2);
    expect(result?.text).toContain('Ada Lovelace');
  });

  it('honours a budget longer than the adapter’s own patience', async () => {
    const polls = serveProfileService();

    await new BrightDataAdapter({ accessToken: 'k', monitorTimeoutMs: 10_000 }).getProfileTextByUrl(
      PROFILE_URL,
      { maxWaitMs: 30_000 },
    );

    expect(polls.count).toBe(6);
  });
});

describe('the dataset API’s limits', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    installLimiter(new MemoryLimiter());
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('holds four profile fetches at once, and starts the fifth when one is done', async () => {
    const triggers: Array<() => void> = [];
    jest.spyOn(global, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/datasets/v3/trigger')) {
        return new Promise<Response>((resolve) => {
          triggers.push(() => resolve(new Response(JSON.stringify({ error: 'declined' }), { status: 200 })));
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const adapter = new BrightDataAdapter({ accessToken: 'k' });

    const fetches = Array.from({ length: 5 }, () => adapter.getProfileTextByUrl(PROFILE_URL));
    await jest.advanceTimersByTimeAsync(0);
    expect(triggers).toHaveLength(4);

    triggers[0]();
    await jest.advanceTimersByTimeAsync(0);
    expect(triggers).toHaveLength(5);

    for (const answer of triggers) answer();
    await Promise.all(fetches);
  });

  it('after a 429 holds the next fetch until the wait Bright Data named has passed', async () => {
    const sentAt: number[] = [];
    const start = Date.now();
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      sentAt.push(Date.now() - start);
      return sentAt.length === 1
        ? new Response('slow down', { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '7' } })
        : new Response(JSON.stringify({ error: 'declined' }), { status: 200 });
    });
    const adapter = new BrightDataAdapter({ accessToken: 'k' });

    await expect(adapter.getProfileTextByUrl(PROFILE_URL)).rejects.toThrow(/BrightData Error: 429/);
    const next = adapter.getProfileTextByUrl(PROFILE_URL);

    await jest.advanceTimersByTimeAsync(6_999);
    expect(sentAt).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    await next;
    expect(sentAt).toEqual([0, 7_000]);
  });
});
