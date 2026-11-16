// Which libraries a connection is shared through: derived from the libraries
// each time it is asked, never stored on the connection. A library's use list
// is what makes it a way to a connection for people who may not use the
// connection themselves (use on a library covers the connections it reaches).

import type { Principal } from 'principal';

import { accessTo } from './decide';
import { StatementStore } from './statement';

/**
 * By connection id, the names of the libraries that name it directly, among
 * the libraries this principal may read or use: a library they can do neither
 * with is not theirs to learn of.
 */
async function librariesSharingConnections(principal: Principal, teamId: string): Promise<Map<string, string[]>> {
  const through = new Map<string, string[]>();
  for (const id of await StatementStore.librariesOf(teamId)) {
    const library = { thing: 'automation', id } as const;
    const mayKnow = (await accessTo(principal, { target: library, verb: 'read' })) || (await accessTo(principal, { target: library, verb: 'use' }));
    if (!mayKnow) continue;
    const name = await StatementStore.nameOf(library);
    for (const connection of (await StatementStore.namedBy(library)).connections) {
      through.set(connection.id, [...(through.get(connection.id) ?? []), name]);
    }
  }
  return new Map([...through].map(([id, names]) => [id, names.sort()]));
}

export { librariesSharingConnections };
