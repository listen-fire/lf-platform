// "Run now" for an automation a carried version runs (its pin's version
// provides `run` but not `listen`, so it has no provisioned listen to judge a
// press). The press is queued as one `run_carried` row naming the movement,
// the movement its manual listen fires (read by the version's own parser),
// and the press as the version's own manual event; whichever worker drains
// next starts the run under that id, through the platform's ordinary firing
// (the run recorder, the lease, the cancel gate, the write ledger), on the
// version's own engine and modules. The caller follows it by its id, as for
// any Run now.
//
// The run is recorded under the movement's own id as its trigger: there is no
// trigger row for a listen this platform does not fire. The runs list reads
// that id with the movement's listens.

import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';
import { triggerEventSchema } from 'engine-contracts';
import { logger } from 'movement-engine/public/log';

import type { RunningLane, ManualInvocation } from '@listen-fire/language-versions';
import type { LanguageVersion } from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { WorkHandler } from '../../work/kinds';

import { getAutomationsQb } from '../../../lib/kysely';
import { enqueueWork } from '../../work/store';
import { notifyWork, registerWorkHandler } from '../../work/drain';
import { isLfEngineTeam } from '../../lf_engine/team_engine';
import { mapRecordingTriggerType } from '../triggers/router';
import { describeDroppedReason } from '../triggers/dropped_reason';
import { runMovementFiring, shippedMovementForTrigger } from './execute';

/** The work kind a carried version's Run now is queued under. */
export const CARRIED_RUN_WORK_KIND = 'run_carried';

/** What a carried Run now's run is recorded as having fired through. */
export const CARRIED_RUN_NOW_NAME = 'Run now';

const carriedRunRowSchema = z.object({
  teamId: z.string().uuid(),
  movementId: z.string().uuid(),
  movementName: z.string(),
  /** The press, as the version's own manual event (JSON). */
  event: z.record(z.string(), z.unknown()),
  runId: z.string().uuid(),
});

type CarriedRunRow = z.infer<typeof carriedRunRowSchema>;

export type CarriedRunNowAnswer =
  | { ok: true; runId: string; status: 'running'; movementName: string }
  | { ok: false; errors: string[] };

/** A run id that is a function of the request: a retry carrying the same id
 *  is the same run. */
function requestRunId(input: { teamId: string; movementId: string; requestId: string }): string {
  const hex = createHash('sha256').update(JSON.stringify([input.teamId, `run-now:${input.movementId}`, input.requestId])).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Queue a Run now of `movementId`, pinned to `pin`, on its carried version's
 * run host. The shipped text is the gate: it must parse under its own version
 * and listen to the manual unit.
 */
export async function queueCarriedRunNow(input: {
  lane: RunningLane;
  teamId: string;
  movementId: string;
  name: string;
  pin: LanguageVersion;
  invocation: ManualInvocation;
  requestId?: string;
}): Promise<CarriedRunNowAnswer> {
  const shipped = await shippedMovementForTrigger({ teamId: input.teamId as TeamId, movementId: input.movementId });
  if (shipped.kind !== 'shipped') {
    return { ok: false, errors: [`'${input.name}' has never been saved clean, so there is nothing to run: save it, then run it`] };
  }
  const { version } = shipped.movement;
  const [movementName] = input.lane.manualListens({ source: version.source, pin: version.languageVersion });
  if (movementName === undefined) {
    return {
      ok: false,
      errors: [
        `'${input.name}' has no manual listen under language ${version.languageVersion}: listen to the manual unit and save first (\`listen to manual fire <movement>\`)`,
      ],
    };
  }
  const runId = input.requestId !== undefined ? requestRunId({ teamId: input.teamId, movementId: input.movementId, requestId: input.requestId }) : randomUUID();
  const row: CarriedRunRow = {
    teamId: input.teamId,
    movementId: input.movementId,
    movementName,
    event: input.lane.manualInvocationEvent({
      key: input.movementId,
      invocation: input.invocation,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    }),
    runId,
  };
  await enqueueWork({ kind: CARRIED_RUN_WORK_KIND, key: `${CARRIED_RUN_WORK_KIND}:${runId}`, teamId: input.teamId, payload: row });
  notifyWork();
  return { ok: true, runId, status: 'running', movementName };
}

async function runRowExists(runId: string): Promise<boolean> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId as TriggerRunId)
    .select('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** A queued run that never starts is written `failed`, naming why, so whoever
 *  follows it by its id learns the reason. */
async function failUnstarted(row: CarriedRunRow, reason: string): Promise<void> {
  logger.warn(`[RunCarried] ${reason}`, { runId: row.runId, movementId: row.movementId });
  await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    .values({
      id: row.runId as TriggerRunId,
      team_id: row.teamId as TeamId,
      trigger_id: row.movementId,
      trigger_type: 'webhook',
      status: 'failed',
      failed_at: new Date(),
      failure_reason: reason,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

async function runCarriedRow(payload: unknown): Promise<void> {
  const row = carriedRunRowSchema.parse(payload);
  // A row taken again after its run started was started then: its segment,
  // or the orphan sweep, settles it.
  if (await runRowExists(row.runId)) return;
  const teamId = row.teamId as TeamId;
  // An lf-engined team's runs are lf's, as at every door.
  if (await isLfEngineTeam(teamId)) return failUnstarted(row, describeDroppedReason('engine_lf'));
  const shipped = await shippedMovementForTrigger({ teamId, movementId: row.movementId });
  if (shipped.kind !== 'shipped') return failUnstarted(row, `movement ${row.movementId} has no shipped version to run`);
  const event = triggerEventSchema.parse(row.event);
  await runMovementFiring({
    teamId,
    triggerId: row.movementId,
    triggerName: CARRIED_RUN_NOW_NAME,
    firedMovementName: row.movementName,
    movement: shipped.movement,
    event,
    recordingTriggerType: mapRecordingTriggerType(event.triggerType),
    existingRunId: row.runId as TriggerRunId,
  });
}

export const carriedRunHandler: WorkHandler = { run: runCarriedRow, recover: runCarriedRow };

export function registerCarriedRunWork(): void {
  registerWorkHandler(CARRIED_RUN_WORK_KIND, carriedRunHandler);
}
