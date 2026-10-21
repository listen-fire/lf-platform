// Wall-clock time in a zone, and its inverse.
//
// The inverse is the interesting half: every (date, time, zone) triple has to
// name exactly one instant, including the two the clock itself refuses to name
// — the hour that never happens on a spring-forward day, and the hour that
// happens twice on a fall-back day. Southern-hemisphere zones (whose
// transitions run the other way round the year) and zones half a world from
// UTC (where the wall reading and the instant are fourteen hours apart) are
// covered because both have broken naive implementations of this before.

import {
  instantAtZonedWallTime,
  localFields,
  readWallClockTime,
  wallClockTimeError,
  zonedDateString,
} from '../index';

function at(date: string, time: string, timezone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const wall = readWallClockTime(time);
  if (wall === null) throw new Error(`bad time ${time}`);
  return instantAtZonedWallTime({
    year,
    month,
    day,
    hour: wall.hour,
    minute: wall.minute,
    timezone,
  }).toISOString();
}

describe('zonedDateString — the day it is there', () => {
  it('23:30 UTC is already tomorrow in Berlin', () => {
    const instant = new Date('2026-03-11T23:30:00.000Z');
    expect(zonedDateString(instant, 'Europe/Berlin')).toBe('2026-03-12');
    expect(zonedDateString(instant, 'UTC')).toBe('2026-03-11');
    expect(zonedDateString(instant, 'America/Los_Angeles')).toBe('2026-03-11');
    expect(zonedDateString(instant, 'Australia/Sydney')).toBe('2026-03-12');
  });

  it('00:30 in Berlin is still yesterday in UTC — the midnight edge', () => {
    // 23:30Z on the 11th reads as 00:30 on the 12th in Berlin.
    const instant = new Date('2026-03-11T23:30:00.000Z');
    expect(localFields(instant.getTime(), 'Europe/Berlin').hour).toBe(0);
    expect(zonedDateString(instant, 'Europe/Berlin')).toBe('2026-03-12');
  });
});

describe('instantAtZonedWallTime — an ordinary wall time', () => {
  it('summer and winter in Berlin, and UTC', () => {
    expect(at('2026-06-15', '07:00', 'Europe/Berlin')).toBe('2026-06-15T05:00:00.000Z');
    expect(at('2026-01-15', '07:00', 'Europe/Berlin')).toBe('2026-01-15T06:00:00.000Z');
    expect(at('2026-06-15', '07:00', 'UTC')).toBe('2026-06-15T07:00:00.000Z');
  });

  it('a zone half a world away', () => {
    expect(at('2026-06-15', '07:00', 'Australia/Sydney')).toBe('2026-06-14T21:00:00.000Z');
    expect(at('2026-12-15', '07:00', 'Australia/Sydney')).toBe('2026-12-14T20:00:00.000Z');
  });

  it('round-trips: the instant reads back as the wall time asked for', () => {
    for (const zone of ['Europe/Berlin', 'Australia/Sydney', 'America/New_York', 'UTC']) {
      const instant = new Date(at('2026-06-15', '13:45', zone));
      const f = localFields(instant.getTime(), zone);
      expect([f.year, f.month, f.day, f.hour, f.minute]).toEqual([2026, 6, 15, 13, 45]);
    }
  });
});

describe('instantAtZonedWallTime — a wall time that never happens', () => {
  it('Berlin springs forward 02:00 → 03:00 on 2026-03-29', () => {
    expect(at('2026-03-29', '02:30', 'Europe/Berlin')).toBe('2026-03-29T01:00:00.000Z');
    expect(at('2026-03-29', '01:59', 'Europe/Berlin')).toBe('2026-03-29T00:59:00.000Z');
    expect(at('2026-03-29', '03:00', 'Europe/Berlin')).toBe('2026-03-29T01:00:00.000Z');
  });

  it('Sydney springs forward 02:00 → 03:00 on 2026-10-04', () => {
    expect(at('2026-10-04', '02:30', 'Australia/Sydney')).toBe('2026-10-03T16:00:00.000Z');
  });

  it('the skipped time lands where the clock resumed, never before it', () => {
    const gap = new Date(at('2026-03-29', '02:30', 'Europe/Berlin'));
    const f = localFields(gap.getTime(), 'Europe/Berlin');
    expect([f.hour, f.minute]).toEqual([3, 0]);
  });
});

describe('instantAtZonedWallTime — a wall time that happens twice', () => {
  it('Berlin falls back 03:00 → 02:00 on 2026-10-25: the earlier offset wins', () => {
    expect(at('2026-10-25', '02:30', 'Europe/Berlin')).toBe('2026-10-25T00:30:00.000Z');
    // Both instants really do read 02:30 there; the earlier is +02:00.
    expect(localFields(Date.parse('2026-10-25T00:30:00.000Z'), 'Europe/Berlin').hour).toBe(2);
    expect(localFields(Date.parse('2026-10-25T01:30:00.000Z'), 'Europe/Berlin').hour).toBe(2);
  });

  it('Sydney falls back 03:00 → 02:00 on 2026-04-05', () => {
    expect(at('2026-04-05', '02:30', 'Australia/Sydney')).toBe('2026-04-04T15:30:00.000Z');
  });
});

describe('windows anchor each end on its own', () => {
  const window = (day: string, previous: string) =>
    (Date.parse(at(day, '07:00', 'Europe/Berlin'))
      - Date.parse(at(previous, '07:00', 'Europe/Berlin')))
    / 3_600_000;

  it('a yesterday-07:00 → today-07:00 window is 23h, 24h or 25h by itself', () => {
    expect(window('2026-03-29', '2026-03-28')).toBe(23);
    expect(window('2026-10-25', '2026-10-24')).toBe(25);
    expect(window('2026-06-15', '2026-06-14')).toBe(24);
  });
});

describe('wall-clock time literals', () => {
  it('reads 24-hour HH:mm and nothing else', () => {
    expect(readWallClockTime('07:00')).toEqual({ hour: 7, minute: 0 });
    expect(readWallClockTime('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(readWallClockTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(readWallClockTime(' 18:30 ')).toEqual({ hour: 18, minute: 30 });
    for (const bad of ['7:00', '7am', '24:00', '23:60', '07:00:00', '0700', '']) {
      expect(readWallClockTime(bad)).toBeNull();
      expect(wallClockTimeError(bad)).toContain('24-hour HH:mm');
    }
  });

  it('a good time has no error', () => {
    expect(wallClockTimeError('07:00')).toBeNull();
  });
});
