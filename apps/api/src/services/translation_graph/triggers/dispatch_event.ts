// A `dispatch_event` row: one event a carried version judged (or that a 0.12.13
// door queued, before its service was replaced), run from its stored receipt.
// Production's tail at 0.12.13, without the replay and harness surfaces this
// release has no caller for. The event stays in its own version's shape, and
// only that version reads it.
//
// The gates, in production's order: the engine switch, the source's own token,
// the run mode, the loop guard, echo suppression, the ownership gate. Then the
// firing, on the version's own engine.

import { z } from 'zod';

import type { WorkContext, WorkHandler } from '../../work/kinds';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerEventId } from '../../../generated/kysely/automations/TriggerEvent';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { DroppedReason } from './dropped_reason';

import { logger } from 'movement-engine/public/log';
import { neverAsAny } from 'movement-engine/public/types';
import { isWriteEffect } from 'movement-engine/public/trace';
import { versionOf, type CarriedEvent, type ListeningLane, type ModulePlatform } from '@listen-fire/language-versions';

import { handleError } from '../../../lib/errors';
import { getAutomationsQb } from '../../../lib/kysely';
import { teamIdSchema } from '../../../lib/team_id';
import { registerWorkHandler, WorkDeferred } from '../../work/drain';
import { enqueueWork } from '../../work/store';
import { isLfEngineTeam } from '../../lf_engine/team_engine';
import * as loopGuard from '../../loop_guard';
import { ORPHAN_AFTER } from '../../movement_engine/run_lease';
import { settleUnresumableRun } from '../../interaction/run_failure';
import { actorCandidateSchema } from '../adapters/acting_user/actor';
import { resolveActingUser } from '../adapters/acting_user/resolve';
import { modulePlatform } from '../movement/carried_run';
import { recordMovementFailureIssue } from '../movement/issues';
import { doorRefusal, runMovementFiring, shippedMovementForTrigger, type ShippedMovement } from '../movement/execute';
import { claimQueuedRun, requeueRun, runningSegment } from '../runs/trigger_run';
import { loadTriggerById } from '../storage/tg_table';
import { describeDroppedReason } from './dropped_reason';
import { markTriggerEventDispatched, markTriggerEventFailed, markTriggerEventSuppressed } from './event_store';
import { applyLoopGuard, mapRecordingTriggerType } from './router';
import { runModeGate, type TriggerRunMode } from './run_mode';

/** One trigger's durable receipt for one event, as a production row holds it. */
const capturedSchema = z.object({
  triggerId: z.string(),
  teamId: teamIdSchema,
  triggerEvent: z.record(z.string(), z.unknown()),
  storedEventId: z.uuid().optional(),
  duplicate: z.boolean().optional(),
  runId: z.uuid().optional(),
  dryRun: z.boolean().optional(),
});
export type CapturedTriggerEvent = z.infer<typeof capturedSchema>;

export function dispatchWorkKey(storedEventId: string): string {
  return `dispatch_event:${storedEventId}`;
}

function queuedRunWorkKey(runId: string): string {
  return `dispatch_event:run:${runId}`;
}

/** The lane that reads a row's event: the version of its automation's pin. */
async function listeningLaneOf(movement: ShippedMovement): Promise<ListeningLane | undefined> {
  const pin = movement.version.languageVersion;
  const version = versionOf(pin);
  return version?.listenRows?.();
}

/** Whether the token that made the change is one the platform writes with. */
async function isPlatformToken(input: { teamId: TeamId; adapterType: string; actor: { type: string; id: string | null } | undefined }): Promise<boolean> {
  if (input.actor?.type !== 'api-token' || input.actor.id === null) return false;
  const row = await getAutomationsQb(['platform_owned_token'])
    .selectFrom('platform_owned_token')
    .where('team_id', '=', input.teamId)
    .where('adapter_type', '=', input.adapterType)
    .where('external_token_id', '=', input.actor.id)
    .where('revoked_at', 'is', null)
    .select('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** The answer a queued run's follower reads, when nothing fired. */
async function failQueuedRun(input: { runId: TriggerRunId; teamId: TeamId; reason: string }): Promise<void> {
  await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({ status: 'failed', failed_at: new Date(), failure_reason: input.reason })
    .where('id', '=', input.runId)
    .where('team_id', '=', input.teamId)
    .where('status', '=', 'running')
    .execute();
}

type Outcome = { kind: 'fired'; dryRun: boolean; error?: string } | { kind: 'dropped'; reason: DroppedReason; note?: string } | { kind: 'failed'; message: string };

/** The ownership gate, over the version's own module's candidates. Fail closed:
 *  a sender nobody can name does not fire. */
async function actorPasses(teamId: TeamId, candidates: unknown): Promise<string | null> {
  try {
    const user = await resolveActingUser({ teamId, getCandidates: async () => z.array(actorCandidateSchema).parse(candidates) });
    return user !== null ? null : 'the inbound actor does not resolve to a registered team user: dropped by the ownership gate';
  } catch (err) {
    return `the inbound actor could not be resolved (${err instanceof Error ? err.message : String(err)}): dropped, fail closed`;
  }
}

/** What a carried version's own gate makes of a firing: it proceeds, asking
 *  nothing (a rehearsal is never gated); its sender is a registered team user,
 *  looked up now; or it is dropped, and why. */
export type CarriedGate =
  | { kind: 'proceed' }
  | { kind: 'member' }
  | { kind: 'dropped'; reason: Extract<DroppedReason, 'echo_suppressed' | 'actor_unregistered' | 'run_mode_off'>; note: string };

/** A carried version's own gate on a firing: the row's run mode (paused drops,
 *  a rehearsal proceeds ungated, as does a dry run someone asked for,
 *  `rehearsal`), then what its source module says of the event, then, when the
 *  module asks, whether the sender is a registered team user. The one gate a
 *  receipt's dispatch, and "why didn't this fire?", reach. */
export async function carriedGate(input: {
  teamId: TeamId;
  lane: Pick<ListeningLane, 'gateFiring'>;
  adapterType: string;
  trigger: { credentialsId: string | null; config: unknown; runMode: TriggerRunMode };
  event: CarriedEvent;
  rehearsal?: boolean;
  modules: ModulePlatform;
}): Promise<CarriedGate> {
  const { teamId, trigger, event } = input;
  const mode = runModeGate(trigger.runMode);
  if (!mode.dispatch) return { kind: 'dropped', reason: mode.droppedReason, note: describeDroppedReason(mode.droppedReason) };
  if (mode.dryRun || input.rehearsal === true) return { kind: 'proceed' };
  const answer = await input.lane.gateFiring({ teamId, adapterType: input.adapterType, credentialsId: trigger.credentialsId, config: trigger.config, event }, input.modules);
  switch (answer.kind) {
    case 'suppress':
      return { kind: 'dropped', reason: 'echo_suppressed', note: answer.reason };
    case 'needs-actor': {
      const refused = await actorPasses(teamId, answer.candidates);
      return refused !== null ? { kind: 'dropped', reason: 'actor_unregistered', note: refused } : { kind: 'member' };
    }
    case 'proceed':
      return { kind: 'proceed' };
    default:
      return neverAsAny(answer);
  }
}

/** The kept delivery a receipt was judged from: the delivery its run started from. */
async function deliveryOfReceipt(id: TriggerEventId): Promise<string | null> {
  const row = await getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('id', '=', id).select('delivery_id').executeTakeFirst();
  return row?.delivery_id ?? null;
}

/** One event through the gates and, past them, its firing. */
async function dispatchCaptured(captured: CapturedTriggerEvent, modules: () => ModulePlatform): Promise<Outcome> {
  const { teamId, triggerId } = captured;
  if (captured.dryRun !== true && (await isLfEngineTeam(teamId))) return { kind: 'dropped', reason: 'engine_lf' };
  const trigger = await loadTriggerById(triggerId);
  if (trigger === null || trigger === undefined) return { kind: 'dropped', reason: 'trigger_not_found' };
  if (trigger.movementId === null) return { kind: 'dropped', reason: 'no_movement' };
  const fired = await shippedMovementForTrigger({ teamId, movementId: trigger.movementId });
  if (fired.kind === 'not_shipped') return { kind: 'dropped', reason: 'not_shipped' };
  if (fired.kind === 'missing') return { kind: 'failed', message: `movement ${trigger.movementId} not found for trigger ${triggerId}` };
  const { movement } = fired;
  const pin = movement.version.languageVersion;
  const event: CarriedEvent = captured.triggerEvent;
  const lane = await listeningLaneOf(movement);
  // An upgrade moved it since: the event is in the shape of the version that
  // judged it, and only that version reads it.
  if (lane === undefined) {
    return { kind: 'failed', message: `this event was judged under an earlier language version, and the automation has moved to ${pin} since: it runs nothing` };
  }
  const read = lane.readEvent(event);
  if (!read.ok) return { kind: 'failed', message: `the queued event could not be read: ${read.reason}` };
  const { record } = read;
  const receipt = captured.storedEventId !== undefined ? (captured.storedEventId as TriggerEventId) : undefined;
  const deliveryId = receipt !== undefined ? await deliveryOfReceipt(receipt) : null;
  const firing = (dryRun: boolean) =>
    runMovementFiring({
      teamId,
      door: { kind: 'judged', event },
      triggerId,
      triggerName: trigger.name,
      ...(trigger.firedMovementName !== null ? { firedMovementName: trigger.firedMovementName } : {}),
      movement,
      event: record,
      recordingTriggerType: mapRecordingTriggerType(record.triggerType),
      dryRun,
      ...(captured.runId !== undefined ? { existingRunId: captured.runId as TriggerRunId } : {}),
      ...(receipt !== undefined ? { triggerEventId: receipt } : {}),
      ...(deliveryId !== null ? { deliveryId } : {}),
    });
  // A start the version does not serve is refused before anything else. An
  // operator reads why on the automation's one issue, which counts the refusals:
  // a run row per delivery would only pile up.
  const refusal = doorRefusal(pin, { kind: 'judged', event });
  if (refusal !== undefined) {
    await recordMovementFailureIssue({ teamId, movementId: trigger.movementId, movementName: movement.row.name, triggerName: trigger.name, message: refusal });
    return { kind: 'failed', message: refusal };
  }
  if (await isPlatformToken({ teamId, adapterType: record.adapterType, actor: record.actor })) return { kind: 'dropped', reason: 'native_echo' };
  const gate = runModeGate(trigger.runMode);
  if (!gate.dispatch) return { kind: 'dropped', reason: gate.droppedReason };
  const dryRun = captured.dryRun === true || gate.dryRun;
  if (!dryRun) {
    const guarded = await applyLoopGuard({ triggerId, teamId, triggerName: trigger.name, movementId: trigger.movementId });
    if (guarded === 'loop_guard_throttled') {
      if (captured.runId !== undefined) await requeueRun(captured.runId as TriggerRunId);
      throw new WorkDeferred(`${trigger.name} is held by the loop guard's rate floor`);
    }
    if (guarded !== undefined) return { kind: 'dropped', reason: guarded };
  }
  const gated = await carriedGate({ teamId, lane, adapterType: record.adapterType, trigger, event, rehearsal: captured.dryRun === true, modules: modules() });
  if (gated.kind === 'dropped') return { kind: 'dropped', reason: gated.reason, note: gated.note };
  const outcome = await firing(dryRun);
  if (outcome.result) {
    const written = outcome.result.writes.filter(isWriteEffect).length;
    if (!dryRun && written > 0) loopGuard.recordExternalWrites({ teamId, count: written }).catch(handleError);
    return { kind: 'fired', dryRun };
  }
  return { kind: 'fired', dryRun, error: outcome.error ?? 'movement firing failed' };
}

/** Runs the receipt and keeps its outcome on the receipt and any queued run. */
async function dispatchAndRecord(captured: CapturedTriggerEvent): Promise<void> {
  const receipt = captured.storedEventId;
  const runId = captured.runId as TriggerRunId | undefined;
  const { teamId } = captured;
  try {
    const outcome = await dispatchCaptured(captured, modulePlatform);
    switch (outcome.kind) {
      case 'fired':
        if (receipt !== undefined) await markTriggerEventDispatched(receipt);
        if (runId !== undefined && outcome.dryRun) {
          await getAutomationsQb(['trigger_run']).updateTable('trigger_run').set({ dry_run: true }).where('id', '=', runId).execute();
        }
        return;
      case 'dropped': {
        const reason = outcome.note ?? describeDroppedReason(outcome.reason);
        logger.info('[DispatchEvent] dropped', { triggerId: captured.triggerId, reason });
        if (receipt !== undefined) await markTriggerEventSuppressed(receipt, reason);
        if (runId !== undefined) await failQueuedRun({ runId, teamId, reason });
        return;
      }
      case 'failed':
        logger.warn('[DispatchEvent] failed', { triggerId: captured.triggerId, reason: outcome.message });
        if (receipt !== undefined) await markTriggerEventFailed(receipt, outcome.message);
        if (runId !== undefined) await failQueuedRun({ runId, teamId, reason: outcome.message });
        return;
      default:
        return neverAsAny(outcome);
    }
  } catch (err) {
    if (err instanceof WorkDeferred) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (receipt !== undefined) await markTriggerEventFailed(receipt, message);
    if (runId !== undefined) await failQueuedRun({ runId, teamId, reason: message });
    logger.error('[DispatchEvent] dispatch failed', { triggerId: captured.triggerId, error: message });
  }
}

async function receiptStatus(id: string): Promise<string | undefined> {
  const row = await getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('id', '=', id as TriggerEventId).select('status').executeTakeFirst();
  return row?.status;
}

async function runForReceipt(id: string): Promise<{ id: TriggerRunId; status: string } | undefined> {
  return getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('trigger_event_id', '=', id as TriggerEventId)
    .orderBy('started_at', 'desc')
    .select(['id', 'status'])
    .executeTakeFirst();
}

const UNFINISHED_SEGMENT = 'segment did not complete: lease lapsed or the previous attempt failed';

/** A claim that found the run started: a row taken again, or re-armed while the
 *  run went on, must not start a second. */
async function settleStarted(input: { runId: TriggerRunId; key: string; payload: unknown; captured: CapturedTriggerEvent; ctx: WorkContext }): Promise<void> {
  const { runId, captured, ctx } = input;
  const segment = await runningSegment(runId, { now: ctx.now, staleAfterMs: ORPHAN_AFTER });
  switch (segment) {
    case 'orphaned':
      await settleUnresumableRun({ runId, reason: UNFINISHED_SEGMENT });
      if (captured.storedEventId !== undefined) await markTriggerEventFailed(captured.storedEventId, UNFINISHED_SEGMENT);
      return;
    case 'live':
      // The lease lapses before the heartbeat goes stale, so a live beat may be
      // a dead process's last: look again once it would be stale.
      await enqueueWork({ kind: 'dispatch_event', key: input.key, teamId: captured.teamId, payload: input.payload, dueAt: new Date(ctx.now.getTime() + ORPHAN_AFTER) });
      return;
    case 'not_running':
      if (captured.storedEventId !== undefined) await markTriggerEventDispatched(captured.storedEventId);
      return;
    default:
      neverAsAny(segment);
  }
}

/** One row, first claim or later: a settled receipt keeps its outcome. */
async function runReceipt(payload: unknown, ctx: WorkContext): Promise<void> {
  const captured = capturedSchema.parse(payload);
  if (captured.duplicate === true) return;
  if (captured.runId !== undefined) {
    const runId = captured.runId as TriggerRunId;
    if (await claimQueuedRun(runId)) return dispatchAndRecord(captured);
    return settleStarted({ runId, key: queuedRunWorkKey(runId), payload, captured, ctx });
  }
  const { storedEventId } = captured;
  if (storedEventId === undefined) return dispatchAndRecord(captured);
  if ((await receiptStatus(storedEventId)) !== 'received') return;
  const run = await runForReceipt(storedEventId);
  if (run === undefined) return dispatchAndRecord(captured);
  if (run.status !== 'running') return markTriggerEventDispatched(storedEventId);
  return settleStarted({ runId: run.id, key: dispatchWorkKey(storedEventId), payload, captured, ctx });
}

export const dispatchEventHandler: WorkHandler = { run: runReceipt, recover: runReceipt };

export function registerDispatchWork(): void {
  registerWorkHandler('dispatch_event', dispatchEventHandler);
}

