// The access a unit test's stand-in automations and connections have: the
// statements Task 9 writes for everything that exists (read and write for the
// team, fire for anyone, use for the team), under team membership. A unit test
// with no database states them by mocking the decision with these:
//
//   jest.mock('<path>/services/access/decide', () =>
//     jest.requireActual('<path>/test/access_defaults').teamDefaults());
//
// A test about who may see what states its own statements instead.

import type { Principal } from 'principal';

/** Every id there is: what a list reads when the team may read everything in it. */
class EveryId extends Set<string> {
  override has(): boolean {
    return true;
  }
}

function teamDefaults() {
  return {
    ...jest.requireActual('../services/access/decide'),
    // Membership caps a statement: a read member never writes.
    accessTo: async (principal: Principal, asked: { verb: string }) => asked.verb !== 'write' || principal.access === 'write',
    readableIds: async () => new EveryId(),
  };
}

export { teamDefaults };
