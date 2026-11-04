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
import { compatibilityKey } from 'movement-lang';
import { logger } from 'movement-engine/public/log';

import { runRefusal, type RunningLane, type ManualInvocation } from '@listen-fire/language-versions';
import type { LanguageVersion } from 'movement-lang';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { WorkHandler } from '../../work/kinds';

import { getAutomationsQb } from '../../../lib/kysely';
import { teamIdSchema } from '../../../lib/team_id';
import { enqueueWork } from '../../work/store';
import { notifyWork, registerWorkHandler } from '../../work/drain';
import { isLfEngineTeam } from '../../lf_engine/team_engine';
import { mapRecordingTriggerType } from '../triggers/router';
import { describeDroppedReason } from '../triggers/dropped_reason';
import { runMovementFiring, shippedMovementForTrigger } from './execute';
import { CARRIED_RUN_NOW_NAME, carriedRunTriggerId } from './carried_names';
import { carriedRunLaneOf } from './carried_run';

/** The work kind a carried version's Run now is queued under. */
export const CARRIED_RUN_WORK_KIND = 'run_carried';

export { CARRIED_RUN_NOW_NAME, carriedRunTriggerId } from './carried_names';

const carriedRunRowSchema = z.object({
  teamId: teamIdSchema,
  movementId: z.string().min(1),
  movementName: z.string(),
  /** The pin the press was queued under: the version whose shape `event` is
   *  in, and the only one that reads it. */
  pin: z.string().min(1),
  /** The press, as the version's own manual event (JSON). */
  event: z.record(z.string(), z.unknown()),
  runId: z.string().min(1),
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
  const teamId = teamIdSchema.parse(input.teamId);
  const shipped = await shippedMovementForTrigger({ teamId, movementId: input.movementId });
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
    teamId,
    movementId: input.movementId,
    movementName,
    pin: version.languageVersion,
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
      team_id: row.teamId,
      trigger_id: carriedRunTriggerId(row.movementId),
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
  const { teamId } = row;
  // An lf-engined team's runs are lf's, as at every door.
  if (await isLfEngineTeam(teamId)) return failUnstarted(row, describeDroppedReason('engine_lf'));
  const shipped = await shippedMovementForTrigger({ teamId, movementId: row.movementId });
  if (shipped.kind !== 'shipped') return failUnstarted(row, `movement ${row.movementId} has no shipped version to run`);
  // The press is in the shape of the version it was queued under, and only
  // that version reads it: an automation upgraded since is not handed it.
  const shippedPin = shipped.movement.version.languageVersion;
  if (compatibilityKey(shippedPin) !== compatibilityKey(row.pin)) {
    return failUnstarted(row, `this run was queued under language ${row.pin}, and the automation has moved to ${shippedPin} since: run it again`);
  }
  const lane = await carriedRunLaneOf(row.pin);
  if (lane === undefined) return failUnstarted(row, runRefusal(row.pin) ?? `language ${row.pin} is not run by a carried version on this platform`);
  const read = lane.readEvent(row.event);
  if (!read.ok) return failUnstarted(row, `the queued press could not be read under language ${row.pin}: ${read.reason}`);
  await runMovementFiring({
    teamId,
    door: { kind: 'manual', event: row.event },
    triggerId: carriedRunTriggerId(row.movementId),
    triggerName: CARRIED_RUN_NOW_NAME,
    firedMovementName: row.movementName,
    movement: shipped.movement,
    event: read.record,
    recordingTriggerType: mapRecordingTriggerType(read.record.triggerType),
    existingRunId: row.runId as TriggerRunId,
  });
}

export const carriedRunHandler: WorkHandler = { run: runCarriedRow, recover: runCarriedRow };

export function registerCarriedRunWork(): void {
  registerWorkHandler(CARRIED_RUN_WORK_KIND, carriedRunHandler);
}
