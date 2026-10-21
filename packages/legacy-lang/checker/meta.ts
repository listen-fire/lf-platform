// The ambient meta-fields — the values a movement reads with an `@` prefix in
// any expression (`@current_date`, `@actor_email`, …). They resolve per run in
// the engine (apps/api `resolveMovementMetaKey`); the language layer needs the
// canonical KEY SET in two places — the checker (to flag an unknown `@key`
// before it silently resolves to null) and the editor (to offer them as
// completions / hover). This module is the single source of truth for that set:
// the checker, the completion service, and the engine all read it, so the three
// can never drift.
//
// Each entry carries the bare key (no `@`) and its plain-language `doc`, which
// doubles as the completion detail and hover text.

import type { FieldType } from './catalog';

export interface MovementMetaField {
  /** The bare key, no `@` sigil — e.g. `current_date`. */
  key: string;
  /** The value type the key resolves to — lets the comparison type-check
   *  treat `@current_date` as a date, `@user_email` as text, and so on. */
  type: FieldType;
  /** Plain-language description; the `@`-prefixed key leads it. */
  doc: string;
}

export const MOVEMENT_META_FIELDS: readonly MovementMetaField[] = [
  {
    key: 'current_date',
    type: 'date',
    doc: '@current_date — the date (YYYY-MM-DD) when this movement runs',
  },
  {
    key: 'current_timestamp',
    type: 'datetime',
    doc: '@current_timestamp — the full date and time when this movement runs',
  },
  {
    key: 'user_email',
    type: 'text',
    doc: '@user_email — email of the team member responsible for this run (resolved through forwarders to the real person)',
  },
  {
    key: 'user_name',
    type: 'text',
    doc: '@user_name — name of the team member responsible for this run',
  },
  {
    key: 'user_id',
    type: 'text',
    doc: '@user_id — id of the team member responsible for this run',
  },
  {
    key: 'actor_email',
    type: 'text',
    doc: '@actor_email — email of whoever actually triggered the event (the raw sender / From; may differ from @user_email when forwarded)',
  },
  {
    key: 'actor_name',
    type: 'text',
    doc: '@actor_name — name of whoever actually triggered the event (the raw originator)',
  },
  {
    key: 'actor_id',
    type: 'text',
    doc: '@actor_id — id of whoever actually triggered the event (the raw originator)',
  },
];

/** The value type of a canonical meta key (bare, no `@`), or undefined for an
 *  unknown key — the comparison type-check reads this for `@`-prefixed leaves. */
export function movementMetaKeyType(key: string): FieldType | undefined {
  return MOVEMENT_META_FIELDS.find(f => f.key === key)?.type;
}

/** The canonical bare meta keys (no `@`), in declaration order. */
export const MOVEMENT_META_KEYS: readonly string[] = MOVEMENT_META_FIELDS.map(f => f.key);

const META_KEY_SET = new Set(MOVEMENT_META_KEYS);

/** Whether `key` (bare, no `@`) is one of the canonical meta fields. */
export function isMovementMetaKey(key: string): boolean {
  return META_KEY_SET.has(key);
}

/**
 * The meta keys that read the WALL CLOCK — the language's only access to "now",
 * and so the whole of the effect row's `now`. The rest of the meta set names
 * the run's people, which is run context rather than a clock read.
 */
const CLOCK_META_KEYS: ReadonlySet<string> = new Set(['current_date', 'current_timestamp']);

/** Whether reading `key` (bare, no `@`) reads the clock. */
export function isClockMetaKey(key: string): boolean {
  return CLOCK_META_KEYS.has(key);
}

/**
 * The canonical key closest to `key` by simple edit distance, when one is
 * "close enough" to suggest (within a third of the longer string's length, or a
 * shared prefix). Returns the bare key (no `@`), or undefined when nothing is a
 * plausible correction.
 */
export function closestMovementMetaKey(key: string): string | undefined {
  return closestByEditDistance(key, MOVEMENT_META_KEYS);
}

/** ` — did you mean 'x'?` when a close candidate exists, else nothing. The one
 *  shape every closed-vocabulary diagnostic appends. */
export function didYouMean(value: string, candidates: readonly string[]): string {
  const closest = closestByEditDistance(value, candidates);
  return closest !== undefined ? ` — did you mean '${closest}'?` : '';
}

/**
 * The candidate in `candidates` closest to `value` by edit distance, when one
 * is "close enough" to suggest — within a third of the longer string's length
 * (floored, min 2), or in a clear prefix/substring relationship (so
 * `current_user_email` → `user_email` and `Snozed` → `Snoozed` both qualify).
 * Returns the candidate verbatim, or undefined when nothing is a plausible
 * correction. The single did-you-mean engine the meta-key and enum-literal
 * suggestions share.
 */
export function closestByEditDistance(
  value: string,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(value, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (best === undefined) return undefined;
  const threshold = Math.max(2, Math.floor(Math.max(value.length, best.length) / 3));
  if (bestDistance <= threshold) return best;
  // A clear prefix/substring relationship is a plausible correction even when
  // raw edit distance exceeds the threshold.
  if (value.includes(best) || best.includes(value)) return best;
  return undefined;
}

/** Levenshtein distance between two strings. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = new Array<number>(cols);
  const curr = new Array<number>(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i < rows; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < cols; j++) prev[j] = curr[j];
  }
  return prev[cols - 1];
}
