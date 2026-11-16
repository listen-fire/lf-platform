// The one access check made when a run starts: every library the run's
// imports reach must still stand. A library keeps its power only while each
// connection name it makes directly resolves to a connection, and one of its
// writers holds use on it (like a definer function, which fails when its owner
// loses the right). The answer is kept
// per library and recomputed when a list or a membership changes
// (`recomputeLibraryStanding`); a run already going keeps its connections, so
// only a run's start asks.

import { recomputeLibraryStanding } from '../../access/decide';
import { StatementStore } from '../../access/statement';
import { assembleMovementFileSources } from './files';
import { getMovementRowByName } from './store';

/**
 * Why the run may not start, naming the library and the connection it lost;
 * undefined when every library its imports reach stands. A library whose
 * standing has never been worked out is worked out here.
 */
export async function libraryRefusal(input: { teamId: string; source: string }): Promise<string | undefined> {
  const { teamId } = input;
  const idByName = new Map<string, string>();
  await assembleMovementFileSources({
    rootSource: input.source,
    load: async (path) => {
      const row = await getMovementRowByName({ teamId, name: path });
      if (row === null) return null;
      idByName.set(path, row.id);
      return row.source;
    },
  });
  if (idByName.size === 0) return undefined;
  const ids = [...idByName.values()];
  let standing = await StatementStore.standingsOf(ids);
  // A library never worked out, or recorded as lost, is worked out again: a
  // member joining the team can restore a standing without any list changing.
  const unsettled = ids.filter((id) => {
    const recorded = standing.get(id);
    return recorded === undefined || recorded.lostConnectionId !== null || recorded.unresolvedName !== null;
  });
  if (unsettled.length > 0) {
    await recomputeLibraryStanding(teamId, unsettled);
    standing = await StatementStore.standingsOf(ids);
  }
  for (const [name, id] of idByName) {
    const recorded = standing.get(id);
    if (recorded === undefined) continue;
    if (recorded.unresolvedName !== null) {
      return `The library "${name}" no longer stands: it names the connection "${recorded.unresolvedName}", which does not exist. A run that imports it is not started. Someone who may change "${name}" needs to name a connection that exists, or the connection needs to be created.`;
    }
    if (recorded.lostConnectionId === null) continue;
    const connection = await StatementStore.nameOf({ thing: 'connection', id: recorded.lostConnectionId });
    return `The library "${name}" no longer stands: none of the people who may change it may use the connection "${connection}" it names. A run that imports it is not started. Someone who may change "${name}" needs use on "${connection}".`;
  }
  return undefined;
}
