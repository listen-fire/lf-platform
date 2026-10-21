// Timezone (IANA) support for cron schedules, with the hard DST cases.
//
// Semantics are WALL-CLOCK: `"0 9 * * *"` with `Europe/London` fires 09:00
// LOCAL every day — 08:00Z in summer (BST, UTC+1), 09:00Z in winter (GMT,
// UTC+0). Unset timezone means UTC (the historical behaviour, unchanged).
//
// UK DST 2026 (the transitions these tests pin):
//   spring forward — Sun 29 Mar 2026: 01:00 GMT → 02:00 BST (01:00–01:59 local
//                    never happens)
//   fall back      — Sun 25 Oct 2026: 02:00 BST → 01:00 GMT (01:00–01:59 local
//                    happens twice)

import {
  CronParseError,
  cronTimezoneError,
  nextCronOccurrence,
  parseCron,
} from '../index';

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

describe('unset timezone == UTC (non-breaking)', () => {
  test('a 09:00 schedule fires at 09:00Z year-round with no timezone', () => {
    const s = parseCron('0 9 * * *');
    expect(s.timezone).toBeUndefined();
    // Winter and summer alike — no tz means no DST, pure UTC.
    expect(iso(nextCronOccurrence(s, new Date('2026-01-05T00:00:00Z')))).toBe(
      '2026-01-05T09:00:00.000Z',
    );
    expect(iso(nextCronOccurrence(s, new Date('2026-07-06T00:00:00Z')))).toBe(
      '2026-07-06T09:00:00.000Z',
    );
  });
});

describe('Europe/London wall-clock matching across BST↔GMT', () => {
  const london = () => parseCron('0 9 * * *', { timezone: 'Europe/London' });

  test('winter (GMT, UTC+0): 09:00 local == 09:00Z', () => {
    expect(iso(nextCronOccurrence(london(), new Date('2026-01-05T00:00:00Z')))).toBe(
      '2026-01-05T09:00:00.000Z',
    );
  });

  test('summer (BST, UTC+1): 09:00 local == 08:00Z', () => {
    expect(iso(nextCronOccurrence(london(), new Date('2026-07-06T00:00:00Z')))).toBe(
      '2026-07-06T08:00:00.000Z',
    );
  });

  test('the day OF the spring transition still fires 09:00 local (BST) == 08:00Z', () => {
    // 09:00 on 29 Mar is after the 01:00→02:00 jump, so it is BST.
    expect(iso(nextCronOccurrence(london(), new Date('2026-03-29T00:00:00Z')))).toBe(
      '2026-03-29T08:00:00.000Z',
    );
  });

  test('the day OF the fall transition still fires 09:00 local (GMT) == 09:00Z', () => {
    // 09:00 on 25 Oct is after the 02:00→01:00 fall-back, so it is GMT.
    expect(iso(nextCronOccurrence(london(), new Date('2026-10-25T00:00:00Z')))).toBe(
      '2026-10-25T09:00:00.000Z',
    );
  });

  test('day-of-week is evaluated in local time', () => {
    // 0 9 * * 1 == 09:00 local every Monday. 6 Jul 2026 is a Monday.
    const mondays = parseCron('0 9 * * 1', { timezone: 'Europe/London' });
    expect(iso(nextCronOccurrence(mondays, new Date('2026-07-05T12:00:00Z')))).toBe(
      '2026-07-06T08:00:00.000Z',
    );
  });
});

describe('spring-forward: a wall-clock time that does not exist is SKIPPED', () => {
  test('01:30 local on the transition day never fires; next is the following day', () => {
    // 30 1 * * * == 01:30 local. On 29 Mar 2026 local jumps 00:59→02:00, so
    // 01:30 has no instant that day. The defined behaviour is SKIP: the next
    // occurrence is 01:30 the NEXT day (BST, 00:30Z on 30 Mar).
    const s = parseCron('30 1 * * *', { timezone: 'Europe/London' });
    expect(iso(nextCronOccurrence(s, new Date('2026-03-29T00:00:00Z')))).toBe(
      '2026-03-30T00:30:00.000Z',
    );
  });
});

describe('fall-back: a wall-clock time that occurs twice fires ONCE', () => {
  test('nextCronOccurrence skips the second (folded) 01:30', () => {
    // 30 1 * * * == 01:30 local. On 25 Oct 2026, 01:30 happens twice:
    //   first  01:30 BST == 00:30Z
    //   second 01:30 GMT == 01:30Z
    // After the first has passed, the next occurrence must be the NEXT day's
    // 01:30 (GMT, 01:30Z on 26 Oct), NOT the same-day 01:30Z fold.
    const s = parseCron('30 1 * * *', { timezone: 'Europe/London' });
    expect(iso(nextCronOccurrence(s, new Date('2026-10-25T00:30:00Z')))).toBe(
      '2026-10-26T01:30:00.000Z',
    );
  });

  test('the first (BST) occurrence still fires', () => {
    const s = parseCron('30 1 * * *', { timezone: 'Europe/London' });
    expect(iso(nextCronOccurrence(s, new Date('2026-10-25T00:00:00Z')))).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  test('simulating the scheduler across the fold fires exactly once', () => {
    // Mirror movement_scheduler/worker.ts: checkpoint advances to `now` after
    // a fire; due = nextCronOccurrence(schedule, checkpoint); fire when due<=now.
    // This proves the cron_last_fired_at instant checkpoint + fold dedup yield
    // a single fire across the repeated hour.
    const s = parseCron('30 1 * * *', { timezone: 'Europe/London' });
    let checkpoint = new Date('2026-10-25T00:00:00Z'); // just before the first 01:30
    const end = new Date('2026-10-25T03:00:00Z').getTime();
    const STEP = 60 * 1000;
    const fires: string[] = [];
    for (let t = checkpoint.getTime(); t <= end; t += STEP) {
      const now = new Date(t);
      const due = nextCronOccurrence(s, checkpoint);
      if (due !== null && due.getTime() <= now.getTime()) {
        fires.push(due.toISOString());
        checkpoint = now;
      }
    }
    expect(fires).toEqual(['2026-10-25T00:30:00.000Z']);
  });
});

describe('a non-UK zone, for generality', () => {
  test('America/New_York winter (EST, UTC-5): 09:00 local == 14:00Z', () => {
    const s = parseCron('0 9 * * *', { timezone: 'America/New_York' });
    expect(iso(nextCronOccurrence(s, new Date('2026-01-05T00:00:00Z')))).toBe(
      '2026-01-05T14:00:00.000Z',
    );
  });
});

describe('timezone validation', () => {
  test('a valid IANA id parses', () => {
    expect(() => parseCron('0 9 * * *', { timezone: 'Europe/London' })).not.toThrow();
    expect(cronTimezoneError('Europe/London')).toBeNull();
    expect(cronTimezoneError('America/New_York')).toBeNull();
    expect(cronTimezoneError('UTC')).toBeNull();
  });

  test('garbage is rejected by parseCron and by the probe', () => {
    expect(() => parseCron('0 9 * * *', { timezone: 'Not/AZone' })).toThrow(CronParseError);
    expect(() => parseCron('0 9 * * *', { timezone: 'Mars/Phobos' })).toThrow(CronParseError);
    expect(cronTimezoneError('Not/AZone')).not.toBeNull();
    expect(cronTimezoneError('')).not.toBeNull();
  });

  test('an empty/undefined timezone means UTC (no error, no tz stored)', () => {
    expect(parseCron('0 9 * * *', {}).timezone).toBeUndefined();
    expect(parseCron('0 9 * * *', { timezone: undefined }).timezone).toBeUndefined();
  });
});
