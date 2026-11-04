// How a Run now of a carried version is recorded: it has no trigger row, since
// the platform fires no listen of that version. Its own module so a resume can
// read them without importing what starts a run.

/** What a carried Run now's run is recorded as having fired through. */
export const CARRIED_RUN_NOW_NAME = 'Run now';

/** The trigger id a carried Run now's run is recorded under: the movement's
 *  own id. A runs list reads it beside the movement's listens. */
export function carriedRunTriggerId(movementId: string): string {
  return movementId;
}
