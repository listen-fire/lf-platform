// Minimal five-field cron expressions — shared between the movement
// checker (movement-lang validates a cron listener's `schedule` config at
// check time) and the movement scheduler (apps/api computes when a cron
// listener is due). One implementation so the two can never disagree
// about what a valid schedule is.
//
// Supported grammar (standard cron, deliberately small):
//   minute hour day-of-month month day-of-week
// with `*`, single values, ranges `a-b`, steps `*/n` / `a-b/n`, and
// comma lists. Month and day-of-week accept the usual three-letter names
// (jan-dec, sun-sat); day-of-week 7 is folded to 0 (Sunday). No seconds
// field, no `L`/`W`/`#` extensions.
//
// Times are interpreted in UTC by default. A schedule MAY carry an optional
// IANA timezone (e.g. `Europe/London`), in which case its fields are matched
// against LOCAL wall-clock time in that zone — `"0 9 * * 1"` fires 09:00
// local every Monday regardless of DST (08:00Z in BST summer, 09:00Z in GMT
// winter). The conversion uses `Intl.DateTimeFormat` (ICU tz data), so
// This module stays dependency-free and the checker + scheduler share one
// implementation. DST edge behaviour (both documented + tested):
//   - spring-forward — a wall-clock time that never happens (e.g. 01:30 on the
//     UK March transition) is SKIPPED: no instant produces it, so it never
//     fires that day.
//   - fall-back — a wall-clock time that happens twice fires ONCE, on the
//     first (pre-transition) occurrence; the folded repeat is deduped.
// The scheduler remains instant/UTC-based end to end — minute-stepping walks
// real UTC instants; only the field comparison is tz-aware.

import { localFields, offsetMs } from '../timezone';

interface CronFieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const FIELD_SPECS: CronFieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day of week', min: 0, max: 7, names: DOW_NAMES },
];

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** `*` in the day-of-month / day-of-week position — standard cron ORs
   *  the two day fields only when BOTH are restricted. */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
  /** Optional IANA timezone the fields are matched against as local
   *  wall-clock time. Absent ⇒ UTC (the historical behaviour). */
  timezone?: string;
}

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

function parseValue(token: string, spec: CronFieldSpec): number {
  const named = spec.names?.[token.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) {
    throw new CronParseError(
      `'${token}' is not a valid ${spec.name} value (expected a number${spec.names ? ' or a name' : ''})`,
    );
  }
  const value = Number(token);
  if (value < spec.min || value > spec.max) {
    throw new CronParseError(
      `${spec.name} value ${value} is out of range (${spec.min}-${spec.max})`,
    );
  }
  return value;
}

function parseField(field: string, spec: CronFieldSpec): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;
  for (const part of field.split(',')) {
    if (part.length === 0) {
      throw new CronParseError(`empty entry in the ${spec.name} field`);
    }
    const [rangeText, stepText, ...extra] = part.split('/');
    if (extra.length > 0) {
      throw new CronParseError(`'${part}' has more than one '/' in the ${spec.name} field`);
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        throw new CronParseError(`'/${stepText}' is not a valid step in the ${spec.name} field`);
      }
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (rangeText === '*') {
      lo = spec.min;
      hi = spec.max;
      if (stepText === undefined && field === '*') any = true;
    } else if (rangeText.includes('-')) {
      const [a, b, ...rest] = rangeText.split('-');
      if (rest.length > 0 || a === '' || b === undefined || b === '') {
        throw new CronParseError(`'${rangeText}' is not a valid range in the ${spec.name} field`);
      }
      lo = parseValue(a, spec);
      hi = parseValue(b, spec);
      if (lo > hi) {
        throw new CronParseError(
          `range ${lo}-${hi} runs backwards in the ${spec.name} field`,
        );
      }
    } else {
      lo = parseValue(rangeText, spec);
      hi = lo;
      if (stepText !== undefined) hi = spec.max; // `5/15` = every 15 from 5 (vixie extension)
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, any };
}

/** Whether an IANA timezone id is recognised by the runtime's tz database.
 *  `Intl.DateTimeFormat` throws `RangeError` on an unknown zone — the
 *  standard, dependency-free validity probe. */
function isValidTimeZone(timezone: string): boolean {
  if (timezone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** A human-checkable timezone probe: an error message, or null when `timezone`
 *  is a valid IANA id. Shared with the movement checker so author-time and
 *  fire-time agree on what a valid zone is. */
export function cronTimezoneError(timezone: string): string | null {
  return isValidTimeZone(timezone)
    ? null
    : `'${timezone}' is not a recognised IANA time zone (e.g. "Europe/London", "America/New_York", "UTC")`;
}

/** Parse a five-field cron expression. Throws {@link CronParseError} with
 *  a precise message on any invalid field. An optional `timezone` (IANA id)
 *  makes the schedule match local wall-clock time in that zone; absent ⇒ UTC. */
export function parseCron(
  expression: string,
  options: { timezone?: string } = {},
): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      `a schedule has five fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const [minute, hour, dom, month, dow] = fields.map((field, i) =>
    parseField(field, FIELD_SPECS[i]),
  );
  // Day-of-week 7 is Sunday too.
  if (dow.values.has(7)) {
    dow.values.delete(7);
    dow.values.add(0);
  }
  const { timezone } = options;
  if (timezone !== undefined && !isValidTimeZone(timezone)) {
    throw new CronParseError(cronTimezoneError(timezone) as string);
  }
  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    anyDayOfMonth: dom.any,
    anyDayOfWeek: dow.any,
    ...(timezone !== undefined ? { timezone } : {}),
  };
}

/** A human-checkable validity probe: the parse error message, or null
 *  when the expression is a valid schedule. */
export function cronScheduleError(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (e) {
    if (e instanceof CronParseError) return e.message;
    throw e;
  }
}

// ── Timezone conversion ───────────────────────────────────────────────────
//
// The clock-conversion point — given a real UTC instant, what is the local
// wall-clock in the configured zone? — lives in `movement-lang/timezone`, which
// the movement stdlib's `DATE.TODAY` / `DATETIME.AT` read too, so a schedule
// and an expression can never disagree about what 09:00 in a zone means.

/**
 * The earliest UTC instant (minute-resolution) whose local wall-clock equals
 * the given local minute. For an ordinary minute this is the one instant that
 * produces it; during a fall-back the same wall-clock minute is produced by
 * two instants (pre- and post-transition) and this returns the EARLIER one —
 * the basis for firing a folded time exactly once. During a spring-forward gap
 * no instant produces the minute; the returned value then maps to a different
 * wall-clock and simply never matches.
 */
function firstInstantForLocalMinute(wallAsUTC: number, timezone: string): number {
  // Sample the zone's offset on both sides of the wall time so both the pre-
  // and post-transition offsets are considered (covers DST shifts up to 2h),
  // then keep the candidate instants that actually produce this wall-clock.
  const valid: number[] = [];
  for (const deltaHours of [-2, -1, 0, 1, 2]) {
    const candidate = wallAsUTC - offsetMs(wallAsUTC + deltaHours * 3_600_000, timezone);
    const f = localFields(candidate, timezone);
    if (
      Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute) === wallAsUTC &&
      !valid.includes(candidate)
    ) {
      valid.push(candidate);
    }
  }
  return valid.length > 0 ? Math.min(...valid) : wallAsUTC - offsetMs(wallAsUTC, timezone);
}

/** Whether the schedule matches the given instant, at minute resolution.
 *  When the schedule carries a timezone the fields are matched against local
 *  wall-clock time in that zone; otherwise against UTC. */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  if (schedule.timezone !== undefined) return cronMatchesZoned(schedule, date, schedule.timezone);
  if (!schedule.minutes.has(date.getUTCMinutes())) return false;
  if (!schedule.hours.has(date.getUTCHours())) return false;
  if (!schedule.months.has(date.getUTCMonth() + 1)) return false;
  const domMatch = schedule.daysOfMonth.has(date.getUTCDate());
  const dowMatch = schedule.daysOfWeek.has(date.getUTCDay());
  // Standard cron: when both day fields are restricted, either matching
  // suffices; otherwise the restricted one (or neither) decides.
  if (!schedule.anyDayOfMonth && !schedule.anyDayOfWeek) return domMatch || dowMatch;
  if (!schedule.anyDayOfMonth) return domMatch;
  if (!schedule.anyDayOfWeek) return dowMatch;
  return true;
}

function cronMatchesZoned(schedule: CronSchedule, date: Date, timezone: string): boolean {
  const f = localFields(date.getTime(), timezone);
  if (!schedule.minutes.has(f.minute)) return false;
  if (!schedule.hours.has(f.hour)) return false;
  if (!schedule.months.has(f.month)) return false;
  const domMatch = schedule.daysOfMonth.has(f.day);
  const dowMatch = schedule.daysOfWeek.has(f.dayOfWeek);
  const dayOk =
    !schedule.anyDayOfMonth && !schedule.anyDayOfWeek
      ? domMatch || dowMatch
      : !schedule.anyDayOfMonth
        ? domMatch
        : !schedule.anyDayOfWeek
          ? dowMatch
          : true;
  if (!dayOk) return false;
  // Fall-back dedup: a folded wall-clock minute is produced by two instants;
  // fire only on the first. `date` is minute-floored to compare against the
  // canonical first instant for this local minute.
  const wallAsUTC = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute);
  const minuteFloored = date.getTime() - (date.getTime() % 60_000);
  return minuteFloored === firstInstantForLocalMinute(wallAsUTC, timezone);
}

const NEXT_OCCURRENCE_CAP_MINUTES = 5 * 366 * 24 * 60; // ~5 years

/**
 * The first scheduled UTC minute strictly after `after`, or null when no
 * occurrence exists within ~5 years (an unsatisfiable schedule, e.g.
 * Feb 30). Minute-stepping — schedules recur densely enough that this
 * terminates fast in practice, and the cap keeps pathological inputs
 * bounded.
 */
export function nextCronOccurrence(schedule: CronSchedule, after: Date): Date | null {
  const cursor = new Date(after.getTime());
  cursor.setUTCSeconds(0, 0);
  for (let i = 0; i < NEXT_OCCURRENCE_CAP_MINUTES; i++) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    if (cronMatches(schedule, cursor)) return new Date(cursor.getTime());
  }
  return null;
}
