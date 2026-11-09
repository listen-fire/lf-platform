/**
 * tRPC surface for the control tower (async user interaction chunk 7b, 3b/§5.6).
 * The operator surface that answers "what's waiting on a human, and what can I do
 * about it":
 *
 *   - listParkedRuns / listOpenAsks — pure reads over `trigger_run` +
 *     `interaction_request` (never the heavy `parked_run.state` blob).
 *   - answerAskOnBehalf / redeliverAsk / abortRun — operator actions, each
 *     delegating to the existing engine primitive (recordAnswer /
 *     redeliverAskDelivery / failRunAndCancelRequests). The operator is an authed
 *     user, so no token is involved.
 *
 * Everything is team-scoped via `userProcedure` + the service-layer ownership
 * checks (a cross-team id reads as not-found).
 *
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { AskId } from '../../../generated/kysely/asks/Ask';

import { currentContext } from '../../../services/context';
import { UserService } from '../../../services/user';
import { trpc } from '../trpc';
import {
  listParkedRuns,
  listTeamRuns,
  type ParkedRunSummary,
  type TeamRunSummary,
} from '../../../services/interaction/observability';
import { abortRun, resumeRun, runNotFound } from '../../../services/interaction/operator';
import { RunBusy } from '../../../services/movement_engine/run_lease';
import {
  listAskRecordsForTeam,
  answerAskRecordForTeam,
  questionNotFound,
  type AskRecordSummary,
} from '../../../services/interaction/ask_records';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { decidesEach, readableOwned, unseen, type Decision } from '../../access_route';
import { cannotChange } from '../access';
import { Whose } from '../../../services/access/whose';

/** The runs whose automation the caller may read. */
async function readableRuns<T extends { runId: string }>(runs: T[], teamId: string): Promise<T[]> {
  const owners = await Whose.automationsOfRuns({ runIds: runs.map((r) => r.runId), teamIds: [teamId] });
  return readableOwned(runs, { owners, keyOf: (r) => r.runId, teamIds: [teamId] });
}

/** Refuse an operator action on a run the caller may not change, as for a run that is not there. */
async function assertChangesRun(runId: string, teamId: string): Promise<void> {
  const owner = await Whose.automationOfRun({ runId, teamIds: [teamId] });
  if (owner === undefined || (await cannotChange(owner.automationId))) throw runNotFound(runId);
}

const controlTowerRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /** Every parked run for the team — what's waiting, on what automation, since
     *  when, and how many asks it's still waiting on. */
    listParkedRuns: userProcedure.query(async (): Promise<ParkedRunSummary[]> => {
      const ctx = currentContext();
      return readableRuns(await listParkedRuns(ctx.user.teamId as TeamId), ctx.user.teamId);
    }),

    /** The team's questions on the ask store — open ones (answerable in place)
     *  and recently settled ones. */
    listAskRecords: userProcedure.query(async (): Promise<AskRecordSummary[]> => {
      const ctx = currentContext();
      const asks = await listAskRecordsForTeam(ctx.user.teamId as TeamId);
      const owners = await Whose.automationsOfAsks({ askIds: asks.map((a) => a.askId), teamIds: [ctx.user.teamId] });
      return readableOwned(asks, { owners, keyOf: (a) => a.askId, teamIds: [ctx.user.teamId] });
    }),

    /** Answer a new-store question in place — the same lattice transition every
     *  door drives (link page, Slack buttons, MCP). The answer is validated
     *  against the question's answer type, then any run waiting on it resumes. */
    answerAskRecord: userProcedure
      .input(z.object({ askId: z.string().min(1), answer: z.unknown().optional() }))
      .mutation(async ({ input }): Promise<{ askId: string; state: string }> => {
        const ctx = currentContext();
        const owner = await Whose.automationOfAsk({ askId: input.askId, teamIds: [ctx.user.teamId] });
        if (owner === undefined || (await unseen(owner.automationId))) throw questionNotFound();
        return answerAskRecordForTeam({
          askId: input.askId as unknown as AskId,
          answer: input.answer,
          teamId: ctx.user.teamId as TeamId,
        });
      }),

    /** Cancel a parked/running run and all its open asks (§5.7 manual abort). */
    abortRun: userProcedure
      .input(z.object({ runId: z.string().min(1) }))
      .mutation(async ({ input }): Promise<{ runId: string }> => {
        const ctx = currentContext();
        await assertChangesRun(input.runId, ctx.user.teamId);
        const user = await UserService.getById(ctx.user.id);
        return abortRun({
          runId: input.runId,
          teamId: ctx.user.teamId as TeamId,
          abortedBy: user.username ?? user.email ?? undefined,
        });
      }),

    /** Resume a run paused at its cost limit: every branch it suspended carries
     *  on, with the run's usage reset. */
    resumeRun: userProcedure
      .input(z.object({ runId: z.string().min(1) }))
      .mutation(async ({ input }): Promise<{ runId: string; resumed: number }> => {
        const ctx = currentContext();
        await assertChangesRun(input.runId, ctx.user.teamId);
        try {
          return await resumeRun({ runId: input.runId, teamId: ctx.user.teamId as TeamId });
        } catch (err) {
          if (err instanceof RunBusy) throw new TRPCError({ code: 'CONFLICT', message: err.message });
          throw err;
        }
      }),

    /** Every running/parked run for the team, newest first — the runs view
     *  (runs-cancel task 6). */
    listRuns: userProcedure.query(async (): Promise<TeamRunSummary[]> => {
      const ctx = currentContext();
      return readableRuns(await listTeamRuns(ctx.user.teamId as TeamId), ctx.user.teamId);
    }),
  });
};

const READS: Decision = { thing: 'automation', verb: 'read' };
const WRITES: Decision = { thing: 'automation', verb: 'write' };

// Answering a review needs read; stopping or resuming a run needs write.
decidesEach('controlTower', {
  listParkedRuns: READS,
  listAskRecords: READS,
  answerAskRecord: READS,
  abortRun: WRITES,
  resumeRun: WRITES,
  listRuns: READS,
});

export { controlTowerRouter };
