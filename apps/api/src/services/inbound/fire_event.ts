// A `fire_event` row: one run a kept delivery queued (listen_door.ts). It
// starts the run under its listen's receipt, from the mark before the
// delivery's arrivals, through the platform's ordinary firing (the router's
// gates, the run recorder, the engine host). A listen that changed or went
// since the delivery judged the arrival runs nothing, and the waits the
// delivery opened for a run that never started go with its row. So does a
// listen the loop breaker paused (loop_breaker.ts): the arrival is counted
// as held, and its receipt taken, so a redelivery is not counted twice.

import { arrivalTriggerOf } from 'movement-engine/public/inbound';
import { logger } from 'movement-engine/public/log';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { WorkHandler } from '../work/kinds';

import { registerWorkHandler, WorkDeferred } from '../work/drain';
import {
  dispatchTriggerByIdEvent,
  mapRecordingTriggerType,
  type TriggerIdDispatchResult,
} from '../translation_graph/triggers/router';
import { describeDroppedReason } from '../translation_graph/triggers/dropped_reason';
import { requeueRun } from '../translation_graph/runs/trigger_run';
import { shippedMovementForTrigger } from '../translation_graph/movement/execute';
import { getAutomationsQb } from '../../lib/kysely';
import { dropUnstartedWaits } from '../movement_engine/run_host_waits';
import { storeDb } from '../movement_engine/run_host_queue';
import { claimReceipt, fireKeyOf, fireRowSchema, savedListenOf, takeReceiptUnrun, type FireRow } from './listen_door';
import { chainBefore, loopLine, loopSettings } from './loop_breaker';
import { hold as holdListenArrival, setPaused as setListenPaused, states as listenStates } from '../lf_store/listens';

async function runFireRow(payload: unknown): Promise<void> {
  const fire = fireRowSchema.parse(payload);
  const teamId = fire.teamId as TeamId;
  const runId = fire.runId as TriggerRunId;
  const listen = await savedListenOf(fire.triggerId as TriggerId);
  if (listen === null || listen.pipeline !== fire.pipeline) {
    logger.warn(
      `[FireEvent] the listen that took the arrival ${fire.arrival.identity} on ${fire.arrival.edge} changed before its run started: it runs nothing`,
      { triggerId: fire.triggerId, pipeline: fire.pipeline },
    );
    await dropUnstarted(fire);
    return;
  }
  const now = new Date();
  const named = `${listen.file}:${listen.plan.movement}`;
  const about = `the arrival ${fire.arrival.identity} on ${fire.arrival.edge}`;
  // The loop breaker (loop_breaker.ts): a paused listen holds the arrival; one
  // whose run would be past the loop depth is paused and holds it. A row
  // taken again after its run row was written was judged then.
  const scope = { tenant: teamId };
  const judgedBefore = await runRowExists(runId);
  const paused = judgedBefore ? null : ((await listenStates(scope, { pipelines: [listen.pipeline] }))[listen.pipeline]?.paused ?? null);
  const settings = loopSettings();
  const chain = judgedBefore || paused !== null ? [] : await chainBefore({ teamId, listen, arrival: fire.arrival, now, settings });
  if (paused !== null || chain.length >= settings.depth) {
    if (!(await takeReceiptUnrun(fire))) {
      logger.warn(`[FireEvent] ${named} has taken ${about} before: this delivery runs nothing`);
    } else {
      if (paused === null) {
        const line = loopLine(named, chain);
        await setListenPaused(scope, { pipeline: listen.pipeline, paused: line });
        logger.warn(`[FireEvent] ${line}`, { triggerId: fire.triggerId });
      }
      await holdListenArrival(scope, { pipeline: listen.pipeline });
      logger.warn(`[FireEvent] ${named}: ${about} runs nothing, held: the listen is paused (LISTEN_LOOP)`);
    }
    await dropUnstarted(fire);
    return;
  }
  const event = arrivalTriggerOf({ pipelineInputId: listen.pipeline, adapterType: listen.plan.adapter, arrival: fire.arrival, now });
  const movementRow = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('id', '=', fire.triggerId as TriggerId)
    .select('movement_id')
    .executeTakeFirst();
  const shipped =
    movementRow?.movement_id !== null && movementRow?.movement_id !== undefined
      ? await shippedMovementForTrigger({ teamId, movementId: movementRow.movement_id })
      : { kind: 'missing' as const };
  const claim = await claimReceipt({
    fire,
    run: {
      triggerType: mapRecordingTriggerType(event.triggerType),
      recordId: event.recordId ?? null,
      payload: JSON.parse(JSON.stringify(event)),
      movementVersionId: shipped.kind === 'shipped' ? shipped.movement.version.id : null,
    },
    chain,
  });
  if (claim.kind === 'ran_before') {
    logger.warn(
      `[FireEvent] ${named} has run ${about} before: this delivery runs nothing`,
    );
    await dropUnstarted(fire);
    return;
  }
  if (claim.kind === 'in_hand') return;
  const result = await dispatchTriggerByIdEvent({
    triggerId: fire.triggerId,
    event,
    teamId,
    existingRunId: runId,
    ...(fire.arrivalMark !== undefined ? { triggerMark: fire.arrivalMark } : {}),
  });
  if (result.droppedReason === 'loop_guard_throttled') {
    // Held, not dropped: the run goes back to waiting, and its row retries
    // once the guard's rate window has had time to pass.
    await requeueRun(runId);
    throw new WorkDeferred(`${listen.file}:${listen.plan.movement} is held by the loop guard's rate floor`);
  }
  await settleQueuedRun({ runId, teamId, result });
}

/**
 * A queued run whose dispatch produced no firing (run_mode off, echo
 * suppressed, guard paused, …) would stay `running` forever: the recorder only
 * touches the row on a firing. Settle it `failed`, naming why, so whoever
 * follows the run learns the reason. A firing has already settled the row, so
 * the `running` guard makes this a no-op.
 */
async function settleQueuedRun(input: { runId: TriggerRunId; teamId: TeamId; result: TriggerIdDispatchResult }): Promise<void> {
  const { result } = input;
  // The queued row could not know the listener rehearses (its run mode is read
  // at dispatch), and the firing's settle leaves the flag as it found it.
  if (result.movementFirings?.some((firing) => firing.dryRun) === true) {
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ dry_run: true })
      .where('id', '=', input.runId)
      .execute();
  }
  const reason =
    result.droppedReason !== undefined
      ? describeDroppedReason(result.droppedReason)
      : result.errors !== undefined && result.errors.length > 0
        ? result.errors.map((e) => e.message).join('; ')
        : 'dispatch produced no firing';
  await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({ status: 'failed', failed_at: new Date(), failure_reason: reason })
    .where('id', '=', input.runId)
    .where('team_id', '=', input.teamId)
    .where('status', '=', 'running')
    .execute();
}

async function runRowExists(runId: TriggerRunId): Promise<boolean> {
  const row = await getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', runId).select('id').executeTakeFirst();
  return row !== undefined;
}

/** The waits the delivery opened for this row's run, when the run never
 *  started (its listen changed, or ran the arrival before). */
async function dropUnstarted(fire: FireRow): Promise<void> {
  await dropUnstartedWaits(storeDb(), fireKeyOf(fire.runId));
}

export const fireEventHandler: WorkHandler = { run: runFireRow, recover: runFireRow };

export function registerFireEventWork(): void {
  registerWorkHandler('fire_event', fireEventHandler);
}
