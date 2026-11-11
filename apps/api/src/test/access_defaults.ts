// The access a unit test's stand-in automations and connections have: the
// statements Task 9 writes for everything that exists (read and write for the
// team, fire for anyone, use for the team), under team membership. A unit test
// with no database states them by mocking the decision with these:
//
//   jest.mock('<path>/services/access/decide', () =>
//     jest.requireActual('<path>/test/access_defaults').teamDefaults());
//
// A test about who may see what states its own statements instead.

import { meets, type Principal } from 'principal';

/** Every id there is: what a list reads when the team may read everything in it. */
class EveryId extends Set<string> {
  override has(): boolean {
    return true;
  }
}

function teamDefaults() {
  const actual = jest.requireActual('../services/access/decide');
  return {
    ...actual,
    // Membership caps a statement: a read member never writes.
    accessTo: async (principal: Principal, asked: { verb: string }) => asked.verb !== 'write' || meets(principal.access, 'write'),
    readableIds: async () => new EveryId(),
    // The team may see everything, so an admin's power to see what they may not read never comes into it.
    maySeeStatement: async () => true,
    administered: async () => new Set<string>(),
    adminOf: async () => false,
    // A team grant is never the caller alone.
    seenOnlyBy: async () => new Set<string>(),
    // Creating is a write on the team, whatever list the creator states.
    checkConnectionCreation: async (principal: Principal) => {
      if (!meets(principal.access, 'write')) throw new actual.StatementRefusedError('not_allowed', 'Only someone with write access on the team can create a connection.');
    },
    stateAtCreation: async () => undefined,
  };
}

export { teamDefaults };
