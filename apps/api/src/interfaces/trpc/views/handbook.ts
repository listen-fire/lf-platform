import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { getLibraryShelf } from '../../../lib/knowledge/library';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { decidesEach, type Decision } from '../../access_route';

/**
 * Serves the Library shelf — one handbook per system capability.
 *
 * Available books read the SAME registries the corresponding agents
 * consult (e.g. the movement book is the `movement_handbook` registry
 * behind the authoring agent's reference tool) — one source of truth,
 * two consumers (users and agents). The chapter bodies are
 * consumer-neutral; the only per-consumer difference is the affordance
 * layer (the agent gets a tool, the user gets this page).
 */
const handbookRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    getShelf: userProcedure.query(async () => {
      return { books: getLibraryShelf() };
    }),
  });
};

const EXEMPTION: Decision = { exempt: 'the handbook, no automation' };

decidesEach('handbook', {
  getShelf: EXEMPTION,
});

export { handbookRouter };
