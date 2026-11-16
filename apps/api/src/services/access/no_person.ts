// What a thing is created with when no person is in the request: lf creating a
// secret, a remote module's credential minted by a harness, a team arriving
// by migration, a script saving an automation. Nobody chose who may reach it,
// so it keeps the reach a team has always had: the whole team. The backfill of
// what already exists gives the same, from here.

import type { CreationStatements, StatedList } from './decide';
import type { Grantee } from './statement';

const TEAM: readonly Grantee[] = [{ kind: 'team' }];

/** A connection created with no person in the request: the whole team may use it. */
function connectionWithNoPerson(): { use: readonly Grantee[] } {
  return { use: TEAM };
}

/** An automation created with no person in the request: the whole team may read and write it. */
function automationWithNoPerson(): CreationStatements {
  return { write: TEAM, read: TEAM };
}

/** The lists in the order they are stated: write first, so whoever may change it is said before anything else. */
function automationLists(statements: CreationStatements): StatedList<'automation'>[] {
  const lists: StatedList<'automation'>[] = (['write', 'read'] as const).map((verb) => ({ verb, grantees: statements[verb] }));
  return statements.use === undefined ? lists : [...lists, { verb: 'use', grantees: statements.use }];
}

/** The use list of a library created with no person in the request: the whole team may import it. */
function libraryUseWithNoPerson(): readonly Grantee[] {
  return TEAM;
}

export { automationWithNoPerson, connectionWithNoPerson, automationLists, libraryUseWithNoPerson };
