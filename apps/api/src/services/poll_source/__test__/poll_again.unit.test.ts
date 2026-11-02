// Adapter protocol 2.7: a poll's answer may say when the edge is next worth
// polling. The host polls then when that is sooner than the interval, never
// sooner than a second after the poll, and refuses an answer whose
// `pollAgainAt` is not an instant (so its cursor is not kept).
// listen-fire's `next_poll_at` (crates/lf/src/edge_polls.rs) pins the same cases.


import { readPollAnswer } from '../edge_poller';
import { nextPollAt, POLL_AGAIN_FLOOR_MS } from '../worker';

describe('when a key is polled next', () => {
  const polled = new Date(1_000_000);
  const at = (ms: number) => new Date(polled.getTime() + ms).getTime();

  it('is when its module said, within its interval, and never without pause', () => {
    expect(nextPollAt(polled, 60_000).getTime()).toBe(at(60_000));
    expect(nextPollAt(polled, 60_000, new Date(at(15_000))).getTime()).toBe(at(15_000));
    expect(nextPollAt(polled, 60_000, new Date(at(3_600_000))).getTime()).toBe(at(60_000));
    expect(nextPollAt(polled, 60_000, new Date(at(-5_000))).getTime()).toBe(at(POLL_AGAIN_FLOOR_MS));
    expect(nextPollAt(polled, 500, new Date(at(200))).getTime()).toBe(at(500));
  });
});

describe('a poll answer’s pollAgainAt', () => {
  it('is read as an instant', () => {
    expect(readPollAnswer('cron', { arrivals: [], cursor: 'c', pollAgainAt: '2026-10-19T08:30:00.000Z' })).toEqual({
      arrivals: [],
      cursor: 'c',
      pollAgainAt: new Date('2026-10-19T08:30:00.000Z'),
    });
    expect(readPollAnswer('cron', { arrivals: [], cursor: 'c' })).toEqual({ arrivals: [], cursor: 'c' });
  });

  it('refuses the answer, by name, when it is not an instant', () => {
    expect(() => readPollAnswer('acme', { arrivals: [], cursor: 'c', pollAgainAt: 'soon' })).toThrow(
      'acme: a poll answered pollAgainAt "soon": expected an instant (ISO 8601)',
    );
    expect(() => readPollAnswer('acme', { arrivals: [], cursor: 'c', pollAgainAt: 1700000000 })).toThrow(/expected an instant/);
  });
});
