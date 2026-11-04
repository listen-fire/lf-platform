// A listen stops running what reaches it in two ways: the loop breaker pauses
// it (`LISTEN_LOOP`, kept on the listen's state, counting the arrivals it
// holds), and the loop guard's rate and budget floor pauses its trigger row.
// Either way a person sees it on the listen, and resumes it; a resume clears
// both, since whoever resumes means the listen to run again.
//
// The held arrivals do not run on a resume: their deliveries are kept, and a
// replay puts one through again.

import { z } from 'zod';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';

import { getAutomationsQb } from '../../lib/kysely';
import { logger } from 'movement-engine/public/log';
import { clearGuardPaused } from '../loop_guard';
import { setPaused, states } from '../lf_store/listens';

/** Why a listen runs nothing until a person resumes it. */
export interface ListenPause {
  /** Said by whichever paused it (the loop breaker's `LISTEN_LOOP` line, or
   *  the loop guard's reason). */
  reason: string;
  /** The arrivals it held while paused (the loop breaker counts them; the
   *  loop guard keeps their runs, failed, instead). */
  held: number;
}

const pipelineOf = z.object({ listen: z.object({ pipeline: z.string() }) });

export function pipelineOfConfig(config: unknown): string | null {
  const parsed = pipelineOf.safeParse(config);
  return parsed.success ? parsed.data.listen.pipeline : null;
}

/** Why the loop breaker paused each of `configs`' listens, by pipeline. */
export async function loopBreakerPauses(input: { teamId: TeamId; configs: readonly unknown[] }): Promise<Map<string, string>> {
  const pipelines = input.configs.map(pipelineOfConfig).filter((pipeline): pipeline is string => pipeline !== null);
  if (pipelines.length === 0) return new Map();
  const found = await states({ tenant: input.teamId }, { pipelines });
  return new Map(
    pipelines.flatMap((pipeline) => {
      const paused = found[pipeline]?.paused;
      return paused === undefined || paused === null ? [] : [[pipeline, paused] as const];
    }),
  );
}

/** Pause the listen `config` is, as the loop breaker would have. */
export async function pauseListenConfig(input: { teamId: TeamId; config: unknown; reason: string }): Promise<void> {
  const pipeline = pipelineOfConfig(input.config);
  if (pipeline !== null) await setPaused({ tenant: input.teamId }, { pipeline, paused: input.reason });
}

/** The team's paused listens among `triggerIds`, by trigger id. */
export async function listenPauses(input: { teamId: TeamId; triggerIds: readonly string[] }): Promise<Map<string, ListenPause>> {
  const pauses = new Map<string, ListenPause>();
  if (input.triggerIds.length === 0) return pauses;
  const rows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', input.teamId)
    .where('id', 'in', input.triggerIds as TriggerId[])
    .select(['id', 'config', 'guard_paused_at', 'guard_paused_reason'])
    .execute();
  const pipelines = rows.map((row) => pipelineOfConfig(row.config)).filter((p): p is string => p !== null);
  const listenStates = pipelines.length > 0 ? await states({ tenant: input.teamId }, { pipelines }) : {};
  for (const row of rows) {
    const pipeline = pipelineOfConfig(row.config);
    const state = pipeline !== null ? listenStates[pipeline] : undefined;
    if (state !== undefined && state.paused !== null) {
      pauses.set(row.id, { reason: state.paused, held: state.held });
    } else if (row.guard_paused_at !== null) {
      pauses.set(row.id, { reason: row.guard_paused_reason ?? 'the loop guard paused it', held: 0 });
    }
  }
  return pauses;
}

/**
 * Resume the team's listen the trigger row is: its loop-breaker pause and its
 * count of held arrivals cleared, and its loop-guard pause cleared with the
 * guard's windows. `null`: the team has no such listen. `held`: how many
 * arrivals the loop breaker held.
 */
export async function resumeListen(input: { teamId: TeamId; triggerId: TriggerId; resumedBy: string }): Promise<{ resumed: boolean; held: number } | null> {
  const row = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('id', '=', input.triggerId)
    .where('team_id', '=', input.teamId)
    .select(['config'])
    .executeTakeFirst();
  if (row === undefined) return null;
  const guard = await clearGuardPaused({ triggerId: input.triggerId, teamId: input.teamId, resumedBy: input.resumedBy });
  const pipeline = pipelineOfConfig(row.config);
  if (pipeline === null) return { resumed: guard.resumed, held: 0 };
  const scope = { tenant: input.teamId };
  const state = (await states(scope, { pipelines: [pipeline] }))[pipeline];
  if (state === undefined || state.paused === null) return { resumed: guard.resumed, held: 0 };
  await setPaused(scope, { pipeline, paused: null });
  logger.info(`[ListenPause] ${pipeline} resumed (it held ${state.held} arrivals)`, {
    triggerId: input.triggerId,
    resumedBy: input.resumedBy,
  });
  return { resumed: true, held: state.held };
}
