// Which libraries a connection is shared through: derived from the libraries
// each time it is asked, never stored on the connection. A library's use list
// is what makes it a way to a connection for people who may not use the
// connection themselves (use on a library covers the connections it reaches).
// The names go to anyone who may see the connection, so its holders learn where
// it is shared even through a library they cannot read; never a library's
// source.

import { StatementStore } from './statement';

/** By connection id, the names of the libraries that name it directly. */
async function librariesSharingConnections(teamId: string): Promise<Map<string, string[]>> {
  const through = new Map<string, string[]>();
  for (const id of await StatementStore.librariesOf(teamId)) {
    const library = { thing: 'automation', id } as const;
    const name = await StatementStore.nameOf(library);
    for (const connection of (await StatementStore.namedBy(library)).connections) {
      through.set(connection.id, [...(through.get(connection.id) ?? []), name]);
    }
  }
  return new Map([...through].map(([id, names]) => [id, names.sort()]));
}

export { librariesSharingConnections };
