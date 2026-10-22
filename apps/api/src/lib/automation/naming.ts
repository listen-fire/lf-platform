/**
 * User-facing name for an automation trigger.
 *
 * A movement-derived trigger's `trigger.name` is compiled at provisioning
 * time as `movement/<file>/<fired-movement>` (`movement/store.ts`) — an
 * internal dispatch key, never meant for display. Every surface that shows
 * an automation's name must resolve the REAL movement instead of leaking
 * that string; `resolveAutomationName` does the one-hop join callers should
 * prefer (`trigger.movement_id` → `movement.name`), matching how
 * `views.movement.list` already treats `listener.movementName` as
 * authoritative over the raw name.
 *
 * `parseTriggerName` is the fallback for surfaces with no movement row to
 * join against (e.g. the movement's own row was deleted, or a legacy
 * trigger predates `movement_id`) — a magic string, parsed rather than
 * compared, so it stays a last resort rather than the primary path.
 *
 * Lives beside `status.ts` / `describe.ts`: pure, no DB reach-in, callers
 * hand in what they already fetched.
 */

export interface TriggerNameInput {
  /** `trigger.name` — the raw, possibly auto-generated form. */
  name: string;
  /** `trigger.movement_id`, or `null` for a trigger with no owning movement. */
  movementId: string | null;
}

/**
 * Split `movement/<file>/<fired-movement>` into the file's name and the
 * lane fired within it. `lane` is `null` when it equals the file name (a
 * single-movement file — nothing to differentiate) or when `name` doesn't
 * match the convention at all, in which case `automation` is just `name`.
 */
export function parseTriggerName(name: string): { automation: string; lane: string | null } {
  const parts = name.split('/');
  if (parts.length === 3 && parts[0] === 'movement') {
    const [, automation, lane] = parts;
    return { automation, lane: lane === automation ? null : lane };
  }
  return { automation: name, lane: null };
}

/**
 * The name to show for a trigger: the real movement it belongs to
 * (`movementNameById`, a batch-fetched join over `trigger.movement_id`)
 * when one is on hand, else the parsed fallback. Never returns the raw
 * `movement/<file>/<lane>` string.
 */
export function resolveAutomationName(
  trigger: TriggerNameInput,
  movementNameById: ReadonlyMap<string, string>,
): string {
  if (trigger.movementId !== null) {
    const movementName = movementNameById.get(trigger.movementId);
    if (movementName) return movementName;
  }
  return parseTriggerName(trigger.name).automation;
}

/** The movement an lf run's trigger id names. lf has no trigger rows: it
 *  writes `listen:<file>:<movement>` as the trigger id of a run it starts, and
 *  a lookup of that id among the trigger rows (uuid ids) would fail the query. */
export function lfListenMovement(triggerId: string): string | null {
  return /^listen:.+:([^:]+)$/.exec(triggerId)?.[1] ?? null;
}
