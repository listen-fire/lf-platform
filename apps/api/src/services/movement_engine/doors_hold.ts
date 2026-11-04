// What a door's writes know of the team's doors lock it holds on a connection of
// its own (`withDoorsHeld`), and how a door fails when it cannot have or keep it.

import { AsyncLocalStorage } from 'node:async_hooks';

import { WorkDeferred } from '../work/deferred';

/**
 * A door that could not wait any longer or lost its lock, with what it was writing
 * not committed. A door answers the provider an error, and the provider retries; a
 * row of the drain is deferred, which spends no attempt, as this says nothing is
 * wrong with the delivery, so no row gives up on it.
 */
export class DoorsTryAgain extends WorkDeferred {
  constructor(reason: string, options?: { cause: unknown }) {
    super(reason);
    this.name = 'DoorsTryAgain';
    if (options !== undefined) this.cause = options.cause;
  }
}

/** The door a write is made under. `lost`: its lock's connection has gone, and the
 *  lock with it, so an upgrade may already be moving. */
export interface DoorsHold {
  lost: boolean;
}

const doorsHold = new AsyncLocalStorage<DoorsHold>();

export function underDoorsHold<T>(hold: DoorsHold, body: () => Promise<T>): Promise<T> {
  return doorsHold.run(hold, body);
}

/** Before a door's write commits: a door never goes on without its lock. */
export function stillHoldingDoors(): void {
  if (doorsHold.getStore()?.lost) throw new DoorsTryAgain("the connection holding the team's doors was lost during this door");
}
