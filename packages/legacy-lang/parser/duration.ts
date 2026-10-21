// Duration literals (3f Primitive 1) — bare unit-suffixed literals (`4h`, `2d`,
// `90m`, `1h30m`), units s/m/h/d/w. The checker validates the grammar; the
// engine (the escalation worker) converts to milliseconds to set deadlines.
// One module so the parse rule and the runtime interpretation never drift.

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** A bare unit-suffixed duration: one or more `<digits><unit>` runs, units
 *  s/m/h/d/w (e.g. `4h`, `2d`, `90m`, `1h30m`). */
export function isValidDuration(raw: string): boolean {
  return /^(\d+[smhdw])+$/.test(raw);
}

/**
 * Convert a validated duration literal to milliseconds. Sums every
 * `<digits><unit>` run (so `1h30m` = 90 minutes). Throws on a malformed literal
 * — callers should `isValidDuration` first (the checker already did at authoring
 * time), but a runtime conversion of stored source guards loudly rather than
 * silently coercing to 0.
 */
export function durationToMs(raw: string): number {
  if (!isValidDuration(raw)) {
    throw new Error(`invalid duration literal '${raw}' — use unit-suffixed literals like 4h, 2d, 90m, 1h30m`);
  }
  let total = 0;
  for (const [, digits, unit] of raw.matchAll(/(\d+)([smhdw])/g)) {
    total += Number(digits) * UNIT_MS[unit];
  }
  return total;
}
