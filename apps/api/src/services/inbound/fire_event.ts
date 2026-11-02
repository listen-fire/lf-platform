// A `fire_event` row: one run a kept delivery queued (listen_door.ts). It
// starts the run under its listen's receipt, from the mark before the
// delivery's arrivals, through the platform's ordinary firing (the router's
// gates, the run recorder, the engine host). A listen that changed or went
// since the delivery judged the arrival runs nothing, and the waits the
// delivery opened for a run that never started go with its row.

import { arrivalTriggerOf } from 'movement-engine/public/inbound';
import { logger } from 'movement-engine/public/log';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { WorkHandler } from '../work/kinds';

import { registerWorkHandler } from '../work/drain';
import { platformTokenRegistry } from '../translation_graph/engine/platform_token_registry_db';
import { dispatchTriggerByIdEvent, mapRecordingTriggerType } from '../translation_graph/triggers/router';
import { settleQueuedRunAfterDispatch } from '../translation_graph/triggers/dispatch_event';
import { shippedMovementForTrigger } from '../translation_graph/movement/execute';
import { getAutomationsQb } from '../../lib/kysely';
import { dropUnstartedWaits } from '../movement_engine/run_host_waits';
import { storeDb } from '../movement_engine/run_host_queue';
import { claimReceipt, fireKeyOf, fireRowSchema, savedListenOf, type FireRow } from './listen_door';

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
  const event = arrivalTriggerOf({ pipelineInputId: listen.pipeline, adapterType: listen.plan.adapter, arrival: fire.arrival, now: new Date() });
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
  });
  if (claim.kind === 'ran_before') {
    logger.warn(
      `[FireEvent] ${listen.file}:${listen.plan.movement} has run the arrival ${fire.arrival.identity} on ${fire.arrival.edge} before: this delivery runs nothing`,
    );
    await dropUnstarted(fire);
    return;
  }
  if (claim.kind === 'in_hand') return;
  const result = await dispatchTriggerByIdEvent({
    triggerId: fire.triggerId,
    event,
    teamId,
    platformTokenRegistry,
    existingRunId: runId,
    ...(fire.arrivalMark !== undefined ? { triggerMark: fire.arrivalMark } : {}),
  });
  await settleQueuedRunAfterDispatch({ runId, teamId, result, storedEventId: undefined });
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
