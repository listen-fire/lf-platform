// The library half of an in-memory `StatementStore` for tests that have no
// libraries: nothing exports, nothing is named, and a standing is kept in memory.

import type { DirectNames, Target } from '../statement';

const standings = new Map<string, { lostConnectionId: string | null }>();

const noLibraries = {
  librariesOf: async (): Promise<string[]> => [],
  exportsSomething: async (): Promise<boolean> => false,
  namedBy: async (): Promise<DirectNames> => ({ connections: [], libraries: [] }),
  nameOf: async (target: Target): Promise<string> => target.id,
  standingsOf: async (ids: readonly string[]) => new Map(ids.flatMap((id) => (standings.has(id) ? [[id, standings.get(id)!] as const] : []))),
  setStanding: async (target: Target, options: { lostConnectionId: string | null }): Promise<void> => {
    standings.set(target.id, { lostConnectionId: options.lostConnectionId });
  },
};

export { noLibraries };
