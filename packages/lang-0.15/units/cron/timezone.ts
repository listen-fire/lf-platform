// Wall-clock time in an IANA zone, and its inverse — shared by the cron
// scheduler (does this instant match `0 9 * * 1` in Europe/London?) and the
// movement stdlib (`DATE.TODAY(zone)` / `DATETIME.AT(date, time, zone)`).
// One implementation so a schedule and an expression can never disagree
// about what 07:00 in Berlin means.
//
// `Intl.DateTimeFormat` carries the ICU tz database, so this stays
// dependency-free and DST is the platform's problem rather than ours.
// Formatters are expensive to construct and cheap to reuse, so one is
// memoised per zone.

/** The local wall-clock fields of an instant in some zone. */
export interface LocalFields {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
  dayOfWeek: number; // 0-6, Sunday = 0
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let fmt = FORMATTER_CACHE.get(timezone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTER_CACHE.set(timezone, fmt);
  }
  return fmt;
}

/** The local wall-clock fields of a UTC instant in the given zone. */
export function localFields(instant: number, timezone: string): LocalFields {
  const parts = formatterFor(timezone).formatToParts(new Date(instant));
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  const year = get('year');
  const month = get('month');
  const day = get('day');
  // Day-of-week from the local calendar date (UTC arithmetic on the date-only
  // triple is exact and zone-agnostic).
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour: get('hour'), minute: get('minute'), second: get('second'), dayOfWeek };
}

/** Milliseconds to add to a UTC instant to get local wall-clock (the zone's
 *  UTC offset at that instant). */
export function offsetMs(instant: number, timezone: string): number {
  const f = localFields(instant, timezone);
  return wallAsUTC(f) - instant;
}

/** A wall-clock reading as a UTC epoch — the comparable currency for "is this
 *  the same wall time?". It is NOT an instant; it is the local calendar
 *  reading with the offset stripped off. */
function wallAsUTC(f: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}): number {
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second ?? 0);
}

// ── Zone → calendar date ────────────────────────────────────────────────────

/** The calendar date (`YYYY-MM-DD`) an instant falls on in the given zone.
 *  23:30Z on the 11th is the 12th in Berlin, and this says so. */
export function zonedDateString(instant: Date, timezone: string): string {
  const f = localFields(instant.getTime(), timezone);
  const mm = String(f.month).padStart(2, '0');
  const dd = String(f.day).padStart(2, '0');
  return `${f.year}-${mm}-${dd}`;
}

// ── Wall time → instant (the DST-total inverse) ─────────────────────────────

/** How far either side of a first-guess instant to sample the zone's offset.
 *  A day either side straddles any single transition — and no zone changes
 *  twice in a day — so both the pre- and post-transition offsets are seen even
 *  in a zone half a world from UTC, where the wall reading and the instant are
 *  fourteen hours apart. */
const OFFSET_SAMPLE_MS = [-86_400_000, 0, 86_400_000] as const;

/** How far the gap search brackets the answer. A day either side is past any
 *  transition, so the bracket always straddles the wanted instant. */
const GAP_SEARCH_SPAN_MS = 26 * 3_600_000;

/**
 * The instant at a wall-clock time on a calendar date in a zone. TOTAL — every
 * (date, time, zone) triple names exactly one instant, including the two the
 * clock itself refuses to name:
 *
 *   - AMBIGUOUS (a fall-back: 02:30 happens twice in Berlin on 2026-10-25) —
 *     the EARLIER of the two, i.e. the pre-transition offset.
 *   - NONEXISTENT (a spring-forward gap: 02:30 never happens in Berlin on
 *     2026-03-29) — the first instant whose local reading is at or after the
 *     wanted wall time, which is the transition itself (03:00 local).
 *
 * An unknown zone throws `RangeError` from `Intl` — validate with
 * `cronTimezoneError` first wherever the zone is author-supplied.
 */
export function instantAtZonedWallTime(options: {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  timezone: string;
}): Date {
  const { timezone } = options;
  const wanted = wallAsUTC(options);

  // An offset guess turns a wall reading into a candidate instant; the
  // candidate is real only when it reads back as the wall time we asked for.
  // The seed is the wall reading corrected by the offset at that epoch — close
  // enough that a day either side of it brackets any transition.
  const seed = wanted - offsetMs(wanted, timezone);
  const guesses = OFFSET_SAMPLE_MS.map((d) => wanted - offsetMs(seed + d, timezone));
  const real = guesses.filter((g) => wallAsUTC(localFields(g, timezone)) === wanted);
  if (real.length > 0) return new Date(Math.min(...real));

  // The gap: no instant reads as this wall time. Take the first one that reads
  // as LATER — the clock skipped over the request, so the request lands where
  // the clock resumed.
  let before = Math.min(...guesses) - GAP_SEARCH_SPAN_MS;
  let after = Math.max(...guesses) + GAP_SEARCH_SPAN_MS;
  while (after - before > 1) {
    const mid = before + Math.floor((after - before) / 2);
    if (wallAsUTC(localFields(mid, timezone)) >= wanted) after = mid;
    else before = mid;
  }
  return new Date(after);
}

// ── Wall-clock time literals (`"07:00"`) ────────────────────────────────────

const WALL_CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `"07:00"` → `{ hour: 7, minute: 0 }`, or null when it isn't a 24-hour
 *  `HH:mm` reading. */
export function readWallClockTime(time: string): { hour: number; minute: number } | null {
  const match = WALL_CLOCK_TIME.exec(time.trim());
  if (match === null) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** A human-checkable time-of-day probe: an error message, or null when `time`
 *  is a 24-hour `HH:mm` reading. Shared so author-time and run-time agree on
 *  what a wall time is. */
export function wallClockTimeError(time: string): string | null {
  return readWallClockTime(time) === null
    ? `'${time}' is not a time of day — write it as 24-hour HH:mm (e.g. "07:00", "18:30")`
    : null;
}
