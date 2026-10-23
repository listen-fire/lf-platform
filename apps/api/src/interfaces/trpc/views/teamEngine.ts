// The team's engine on its settings page: which engine runs the team's
// automations, and the switch between the platform and a cloud lf. Any member
// may read it; switching takes write access on the team, the same role that
// manages the team's members. Automations owns the setting, so this reads the
// access level off the principal rather than core's membership table (D2).

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { currentPrincipal } from 'principal';

import { readTeamEngine, TEAM_ENGINES } from '../../../services/lf_engine/team_engine';
import { switchTeamEngine } from '../../../services/lf_engine/switch';
import { trpc } from '../trpc';
import { userProcedure as sharedUserProcedure } from '../procedures';

const teamEngineRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    get: userProcedure.query(async () => {
      const setting = await readTeamEngine(currentPrincipal().teamId);
      return {
        engine: setting.engine,
        changedAt: setting.changedAt?.toISOString() ?? null,
        changedBy: setting.changedBy,
      };
    }),

    set: userProcedure.input(z.object({ engine: z.enum(TEAM_ENGINES) })).mutation(async ({ input }) => {
      const principal = currentPrincipal();
      if (principal.access !== 'write') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: "Only members with write access can switch the team's engine.",
        });
      }
      return switchTeamEngine(principal.teamId, { engine: input.engine, changedBy: principal.userId ?? null });
    }),
  });
};

export { teamEngineRouter };
