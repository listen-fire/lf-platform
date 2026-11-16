// The library half of an in-memory `StatementStore` for tests that have no
// libraries: nothing exports, nothing is named, and a standing is kept in memory.

import type { DirectNames, RecordedStanding, Target } from '../statement';

const standings = new Map<string, RecordedStanding>();

const noLibraries = {
  librariesOf: async (): Promise<string[]> => [],
  exportsSomething: async (): Promise<boolean> => false,
  namedBy: async (): Promise<DirectNames> => ({ connections: [], libraries: [], unresolvedConnections: [] }),
  nameOf: async (target: Target): Promise<string> => target.id,
  standingsOf: async (ids: readonly string[]) => new Map(ids.flatMap((id) => (standings.has(id) ? [[id, standings.get(id)!] as const] : []))),
  setStanding: async (target: Target, options: RecordedStanding): Promise<void> => {
    standings.set(target.id, { lostConnectionId: options.lostConnectionId, unresolvedName: options.unresolvedName });
  },
};

export { noLibraries };
