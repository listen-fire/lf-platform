// The shared inbound-dispatch tail. Both the webhook handler
// (`webhook_sync/handler.ts`) and the poll-source worker
// (`poll_source/worker.ts`) produce `DiscriminableEvent`s — one from an
// async `Adapter.preprocessInbound` intercept, the other from a
// `PollSource.getEvents` pull — and from here on the path is identical:
// discriminate the event into a concrete root type, build the `TriggerEvent`,
// store a durable receipt, and dispatch to the movement engine. This module is
// that common tail, so the two front doors stay the only difference between the
// webhook and poll inbound paths.
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { WorkContext, WorkHandler } from '../../work/kinds';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { DiscriminableEvent, EventType } from 'movement-engine/public/adapter';
import type { TriggerType } from 'movement-engine/public/adapter';
import type { TriggerEventId } from '../../../generated/kysely/automations/TriggerEvent';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { SettleReport } from '../../work/harness';

import { getAutomationsQb } from '../../../lib/kysely';
import { logger } from 'movement-engine/public/log';
import { registerWorkHandler } from '../../work/drain';
import { enqueueWork } from '../../work/store';
import { triggerEventSchema, type TriggerEvent } from 'movement-engine/public/inbound';
import { triggerEventOf } from 'movement-engine/public/inbound';
import { notifyWork } from '../../work/drain';
import {
  dispatchTriggerByIdEvent,
  mapRecordingTriggerType,
  type TriggerIdDispatchResult,
} from './router';
import { describeDroppedReason } from './dropped_reason';
import {
  storeTriggerEvent,
  markTriggerEventDispatched,
  markTriggerEventFailed,
  resetTriggerEventToReceived,
} from './event_store';
import { platformTokenRegistry } from '../engine/platform_token_registry_db';
import { loadTriggerById } from '../storage/tg_table';
import { movementForTrigger } from '../movement/execute';
import {
  claimQueuedRun,
  requeueRun,
  runningSegment,
  TriggerRunRecorder,
} from '../runs/trigger_run';
import { ORPHAN_AFTER } from '../../movement_engine/run_lease';
import { neverAsAny } from 'movement-engine/public/types';
import { settleUnresumableRun } from '../../interaction/run_failure';


/** One trigger's durable receipt for one inbound event — the handoff between
 *  the capture half (pre-ack) and the dispatch half (post-ack), carried as the
 *  `dispatch_event` work payload, so it stays plain JSON. */
export interface CapturedTriggerEvent {
  triggerId: TriggerId;
  teamId: TeamId;
  triggerEvent: TriggerEvent;
  /** Absent when the receipt store itself failed — dispatch still runs, just
   *  unreceipted (losing the event entirely would be worse than losing its
   *  audit row). */
  storedEventId?: TriggerEventId;
  /** A redelivery whose receipt already exists — dispatch MUST be skipped. */
  duplicate: boolean;
  /** A run the door already created and handed its caller (`queueRun`): the
   *  firing adopts it, so the id the caller follows is the run that happens. */
  runId?: TriggerRunId;
  /** Rehearse: writes are captured, not committed. */
  dryRun?: boolean;
}

export interface DiscriminableEventInput {
  triggerId: TriggerId;
  movementId: string | null;
  event: DiscriminableEvent;
  /** Resolved adapter slug. */
  adapterType: string;
  triggerType: TriggerType;
  /** The adapter's `listEventTypes()` union, fetched once by the caller. */
  eventTypes: readonly EventType[];
  teamId: TeamId;
  now?: Date;
  /**
   * Re-throw a dispatch failure after recording it, so the test-harness inject
   * response can surface the engine error synchronously. The webhook handler
   * sets this for test-harness teams; the poll worker leaves it false (its
   * per-row try/catch already isolates failures and it has no live caller to
   * surface to).
   */
  surfaceErrors?: boolean;
}

/**
 * Dispatch ONE normalized inbound event to ONE movement-derived trigger.
 *
 * Movement-derived triggers (`movementId` set) are the only inbound execution
 * surface — a trigger with no movement is dropped here. The caller owns
 * fan-out: the webhook handler loops (event × candidate trigger); the poll
 * worker loops (event) over the single polled trigger.
 *
 * Capture-then-dispatch back to back. A front door that acks its sender before
 * running the movement (the webhook_sync door) calls the two halves separately
 * instead — `captureDiscriminableEvent` and `enqueueCapturedEvents` pre-ack, the
 * `dispatch_event` work row running `dispatchCapturedTriggerEvent` after — so the
 * receipt and its row are durable before the 200 and no movement runs inside
 * the request.
 */
export async function dispatchDiscriminableEvent(
  input: DiscriminableEventInput,
): Promise<void> {
  const captured = await captureDiscriminableEvent(input);
  if (captured === null) return;
  await dispatchCapturedTriggerEvent({
    captured,
    ...(input.surfaceErrors ? { surfaceErrors: true } : {}),
  });
}

/**
 * Capture half: discriminate the event, build the `TriggerEvent`, and store the
 * durable receipt. Everything here is cheap and local — no movement runs — so
 * an acking front door can complete this inside the request cycle.
 *
 * `null` means there is nothing to dispatch (no movement bound to the trigger).
 */
export async function captureDiscriminableEvent(
  input: DiscriminableEventInput,
): Promise<CapturedTriggerEvent | null> {
  const {
    triggerId,
    movementId,
    event,
    adapterType,
    triggerType,
    eventTypes,
    teamId,
  } = input;
  const now = input.now ?? new Date();

  if (movementId === null) return null;

  const { triggerEvent, discriminated } = triggerEventOf({
    pipelineInputId: `trigger:${triggerId}`,
    adapterType,
    triggerType,
    event,
    eventTypes,
    now,
  });
  if (!discriminated && eventTypes.length > 0) {
    logger.info('[InboundDispatch] event matched no declared event type', {
      triggerId,
      adapterType,
    });
  }

  // Durable receipt before dispatch — a crash mid-run loses nothing and any
  // event can be played back. Idempotent on the source's delivery id: a
  // redelivery (Slack retries an event it didn't 200 in time) comes back
  // `duplicate` and the dispatch half skips it — the first delivery already
  // owns the run. A store failure yields no id: the event still dispatches,
  // unreceipted, because losing the run is worse than losing its audit row.
  const stored = await storeTriggerEvent({
    teamId,
    triggerId,
    event: triggerEvent,
  }).catch((err) => {
    logger.error('[InboundDispatch] failed to store trigger event', {
      triggerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  });
  if (stored?.duplicate) {
    logger.info('[InboundDispatch] duplicate delivery ignored', {
      triggerId,
      idempotencyKey: event.idempotencyKey,
    });
  }

  return {
    triggerId,
    teamId,
    triggerEvent,
    ...(stored?.id !== undefined ? { storedEventId: stored.id } : {}),
    duplicate: stored?.duplicate === true,
  };
}

/**
 * Dispatch half: hand a captured receipt to the movement engine and record the
 * outcome on the receipt. This is the expensive part — it runs movements — so
 * the acking front door calls it after its 200.
 *
 * A duplicate capture never dispatches: the first delivery already owns the run.
 */
export async function dispatchCapturedTriggerEvent(input: {
  captured: CapturedTriggerEvent;
  /** See `DiscriminableEventInput.surfaceErrors`. */
  surfaceErrors?: boolean;
}): Promise<void> {
  const { captured } = input;
  const { triggerId, teamId, triggerEvent, storedEventId, runId } = captured;
  if (captured.duplicate) return;

  try {
    const result = await dispatchTriggerByIdEvent({
      triggerId,
      event: triggerEvent,
      teamId,
      platformTokenRegistry,
      storedEventId,
      ...(runId !== undefined ? { existingRunId: runId } : {}),
      ...(captured.dryRun === true ? { dryRun: true } : {}),
    });
    // A dropped event (actor-unregistered ownership gate, opt-in echo
    // suppression, or any other `droppedReason`) means the router already
    // owns the receipt's outcome — it marked it 'suppressed' with a reason
    // where applicable, or otherwise never touched it. Only a dispatch that
    // actually ran gets marked 'dispatched' here; overwriting a drop would
    // clobber the audit trail (status back to 'dispatched', reason nulled)
    // even though nothing ran.
    if (storedEventId !== undefined && result.droppedReason === undefined) {
      await markTriggerEventDispatched(storedEventId);
    }
    if (runId !== undefined) await settleQueuedRunAfterDispatch({ runId, teamId, result, storedEventId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (storedEventId !== undefined) await markTriggerEventFailed(storedEventId, message);
    if (runId !== undefined) await failQueuedRun({ runId, teamId, reason: message });
    logger.error('[InboundDispatch] dispatch failed', { triggerId, error: message });
    if (input.surfaceErrors) throw err;
  }
}

/**
 * A queued run whose dispatch produced no firing (run_mode off, echo
 * suppressed, guard paused, …) would stay `running` forever: the recorder only
 * touches the row on a firing. Settle it `failed`, naming why, so whoever
 * follows the run learns the reason. A guard throttle is the exception: the
 * guard put the receipt back on the queue, so the run waits there again. A
 * firing has already settled the row, so the `running` guard makes this a no-op.
 */
async function settleQueuedRunAfterDispatch(input: {
  runId: TriggerRunId;
  teamId: TeamId;
  result: TriggerIdDispatchResult;
  storedEventId: TriggerEventId | undefined;
}): Promise<void> {
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
  if (result.droppedReason === 'loop_guard_throttled' && input.storedEventId !== undefined) {
    await requeueRun(input.runId);
    return;
  }
  const reason =
    result.droppedReason !== undefined
      ? describeDroppedReason(result.droppedReason)
      : result.errors !== undefined && result.errors.length > 0
        ? result.errors.map((e) => e.message).join('; ')
        : 'dispatch produced no firing';
  await failQueuedRun({ runId: input.runId, teamId: input.teamId, reason });
}

async function failQueuedRun(input: { runId: TriggerRunId; teamId: TeamId; reason: string }): Promise<void> {
  await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({ status: 'failed', failed_at: new Date(), failure_reason: input.reason })
    .where('id', '=', input.runId)
    .where('team_id', '=', input.teamId)
    .where('status', '=', 'running')
    .execute();
}

const capturedTriggerEventSchema = z.object({
  triggerId: z.custom<TriggerId>((value) => typeof value === 'string'),
  teamId: z.custom<TeamId>((value) => typeof value === 'string'),
  // A source's own timestamp may carry an offset; the receipt is replayed as
  // received, so the row must accept whatever capture accepted.
  triggerEvent: triggerEventSchema.extend({
    occurredAt: z.string().datetime({ offset: true }).optional(),
  }),
  storedEventId: z
    .custom<TriggerEventId>((value) => z.uuid().safeParse(value).success)
    .optional(),
  duplicate: z.boolean(),
  runId: z.custom<TriggerRunId>((value) => z.uuid().safeParse(value).success).optional(),
  dryRun: z.boolean().optional(),
});

function parseCapturedTriggerEvent(payload: unknown): CapturedTriggerEvent {
  const parsed = capturedTriggerEventSchema.parse(payload);
  return {
    triggerId: parsed.triggerId,
    teamId: parsed.teamId,
    // The schema's `recordId` is a plain string; every reader of a stored
    // TriggerEvent names it as the branded node id the same way.
    triggerEvent: parsed.triggerEvent as TriggerEvent,
    ...(parsed.storedEventId !== undefined ? { storedEventId: parsed.storedEventId } : {}),
    duplicate: parsed.duplicate,
    ...(parsed.runId !== undefined ? { runId: parsed.runId } : {}),
    ...(parsed.dryRun !== undefined ? { dryRun: parsed.dryRun } : {}),
  };
}

async function receiptStatus(storedEventId: TriggerEventId): Promise<string | undefined> {
  const row = await getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('id', '=', storedEventId)
    .select('status')
    .executeTakeFirst();
  return row?.status;
}

function dispatchWorkKey(storedEventId: string): string {
  return `dispatch_event:${storedEventId}`;
}

/** A queued run's row is keyed on the run: a receipt may be run more than once
 *  (a replay), and each run is its own row. */
function queuedRunWorkKey(runId: string): string {
  return `dispatch_event:run:${runId}`;
}

function workKeyOf(receipt: CapturedTriggerEvent): string {
  if (receipt.runId !== undefined) return queuedRunWorkKey(receipt.runId);
  return dispatchWorkKey(receipt.storedEventId ?? randomUUID());
}

/** One work row per receipt that still needs a run. Keyed on the receipt, so a
 *  re-enqueue of the same receipt collapses onto the row already waiting. A
 *  redelivery of a receipt that never ran (still `received`) queues it again:
 *  its row may have been lost after the receipt landed. */
export async function enqueueCapturedEvents(captured: CapturedTriggerEvent[]): Promise<void> {
  for (const receipt of captured) {
    if (receipt.duplicate) {
      if (receipt.storedEventId === undefined) continue;
      if ((await receiptStatus(receipt.storedEventId)) !== 'received') continue;
    }
    await enqueueWork({
      kind: 'dispatch_event',
      key: workKeyOf(receipt),
      teamId: receipt.teamId,
      // The row runs the stored receipt, which is not itself a redelivery.
      payload: { ...receipt, duplicate: false },
    });
  }
}

/**
 * The receive door for one already-routed event (inbound email, WhatsApp):
 * store the receipt, queue its row, and return — the movement runs on whichever
 * worker drains next, never inside the request. Idempotent on the event's
 * delivery id: a redelivery is `duplicate` and queues nothing new, unless its
 * receipt never ran (its row may have been lost after the receipt landed).
 */
export async function receiveTriggerEvent(input: {
  teamId: TeamId;
  triggerId: string;
  event: TriggerEvent;
}): Promise<{ eventId: string; duplicate: boolean }> {
  const stored = await storeTriggerEvent(input);
  await enqueueCapturedEvents([
    {
      triggerId: input.triggerId as TriggerId,
      teamId: input.teamId,
      triggerEvent: input.event,
      storedEventId: stored.id,
      duplicate: stored.duplicate,
    },
  ]);
  notifyWork();
  return { eventId: stored.id, duplicate: stored.duplicate };
}

export interface QueuedRun {
  runId: TriggerRunId;
  /** The event's delivery id was already received: this is the run the first
   *  delivery queued, and nothing new was queued. */
  duplicate: boolean;
}

/**
 * Queue one run of a trigger and hand back its id before it starts — the
 * on-demand doors (Run now, replay) return this id so the caller can follow
 * the run. Stores the receipt, then queues a run of it. Idempotent on the
 * event's delivery id: a retried request gets the first request's run back.
 */
export async function queueRun(input: {
  triggerId: TriggerId;
  teamId: TeamId;
  event: TriggerEvent;
  /** The movement version the run pins (the trigger's movement's current). */
  movementVersionId: string | null;
  dryRun?: boolean;
}): Promise<QueuedRun> {
  const stored = await storeTriggerEvent({
    teamId: input.teamId,
    triggerId: input.triggerId,
    event: input.event,
  });
  if (stored.duplicate) {
    const first = await runForReceipt(stored.id);
    if (first !== undefined) return { runId: first.id, duplicate: true };
  }
  const runId = await queueRunOfReceipt({ ...input, storedEventId: stored.id });
  return { runId, duplicate: stored.duplicate };
}

/**
 * Insert the run as `running` with no heartbeat (waiting in the queue) and
 * queue the row that starts it. The run row, its receipt and its work row are
 * all durable before the caller gets the id.
 */
async function queueRunOfReceipt(input: {
  triggerId: TriggerId;
  teamId: TeamId;
  event: TriggerEvent;
  storedEventId: TriggerEventId;
  movementVersionId: string | null;
  dryRun?: boolean;
}): Promise<TriggerRunId> {
  const dryRun = input.dryRun === true ? { dryRun: true } : {};
  const recorder = new TriggerRunRecorder({
    teamId: input.teamId,
    triggerId: input.triggerId,
    triggerType: mapRecordingTriggerType(input.event.triggerType),
    triggerEvent: input.event,
    movementVersionId: input.movementVersionId,
    triggerEventId: input.storedEventId,
    queued: true,
    ...dryRun,
  });
  await recorder.ensureStarted();
  const runId = recorder.triggerRunId;
  // The recorder logs rather than throws a failed insert; a run id handed out
  // for a row that does not exist would never be followed to an outcome.
  const recorded = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select('id')
    .executeTakeFirst();
  if (recorded === undefined) throw new Error(`run ${runId} could not be recorded`);
  try {
    await enqueueCapturedEvents([
      {
        triggerId: input.triggerId,
        teamId: input.teamId,
        triggerEvent: input.event,
        storedEventId: input.storedEventId,
        duplicate: false,
        runId,
        ...dryRun,
      },
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failQueuedRun({ runId, teamId: input.teamId, reason: `could not be queued: ${message}` });
    throw err;
  }
  notifyWork();
  return runId;
}

/** Put a stored receipt back on the queue, due at `dueAt` (the loop guard's
 *  held release). A queued run it carried stays its run. */
export async function requeueReceipt(input: {
  storedEventId: TriggerEventId;
  dueAt: Date;
  runId?: TriggerRunId;
}): Promise<void> {
  const row = await getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('id', '=', input.storedEventId)
    .select(['team_id', 'trigger_id', 'payload'])
    .executeTakeFirst();
  if (row === undefined) throw new Error(`trigger event ${input.storedEventId} not found`);
  await resetTriggerEventToReceived(input.storedEventId);
  const receipt = parseCapturedTriggerEvent({
    triggerId: row.trigger_id,
    teamId: row.team_id,
    triggerEvent: row.payload,
    storedEventId: input.storedEventId,
    duplicate: false,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
  });
  await enqueueWork({
    kind: 'dispatch_event',
    key: workKeyOf(receipt),
    teamId: receipt.teamId,
    payload: receipt,
    dueAt: input.dueAt,
  });
}

/** Re-run one of the team's stored events (playback) as a new queued run. */
export async function replayTriggerEvent(input: {
  eventId: string;
  teamId: TeamId;
}): Promise<{ replayed: false } | { replayed: true; runId: TriggerRunId }> {
  const row = await getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('id', '=', input.eventId as TriggerEventId)
    .where('team_id', '=', input.teamId)
    .select(['id', 'team_id', 'trigger_id', 'payload'])
    .executeTakeFirst();
  if (!row) return { replayed: false };
  const receipt = parseCapturedTriggerEvent({
    triggerId: row.trigger_id,
    teamId: row.team_id,
    triggerEvent: row.payload,
    storedEventId: row.id,
    duplicate: false,
  });
  const runId = await queueRunOfReceipt({
    triggerId: receipt.triggerId,
    teamId: receipt.teamId,
    event: receipt.triggerEvent,
    storedEventId: row.id,
    movementVersionId: await currentMovementVersionId(receipt),
  });
  return { replayed: true, runId };
}

/** The version a run of this trigger pins now; null when its movement is not
 *  versioned or is gone (the dispatch then drops it with the reason). */
async function currentMovementVersionId(receipt: CapturedTriggerEvent): Promise<string | null> {
  const trigger = await loadTriggerById(receipt.triggerId);
  if (!trigger || trigger.movementId === null) return null;
  const movement = await movementForTrigger({ teamId: receipt.teamId, movementId: trigger.movementId });
  return movement?.currentVersionId ?? null;
}

const UNFINISHED_SEGMENT = 'segment did not complete: lease lapsed or the previous attempt failed';

/** The latest run started from this receipt (a replay starts another). */
async function runForReceipt(
  storedEventId: TriggerEventId,
): Promise<{ id: TriggerRunId; status: string } | undefined> {
  return getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('trigger_event_id', '=', storedEventId)
    .orderBy('started_at', 'desc')
    .select(['id', 'status'])
    .executeTakeFirst();
}

/**
 * Runs one captured receipt, first or re-claimed alike: a claim may find a run
 * this receipt already started (a lapsed lease, a throw, or a row re-armed
 * while the run went on), and must not start a second. A dispatch failure is
 * recorded on the receipt, not thrown, so the row completes rather than
 * re-running a failed movement.
 */
async function runReceipt(payload: unknown, ctx: WorkContext): Promise<void> {
  const captured = parseCapturedTriggerEvent(payload);
  if (captured.runId !== undefined) {
    await runQueuedRun({ captured, runId: captured.runId, payload, ctx });
    return;
  }
  const { storedEventId } = captured;
  if (storedEventId === undefined) {
    await dispatchCapturedTriggerEvent({ captured });
    return;
  }
  // A settled receipt (dispatched, failed, suppressed) keeps its outcome.
  if ((await receiptStatus(storedEventId)) !== 'received') return;
  const run = await runForReceipt(storedEventId);
  if (run === undefined) {
    await dispatchCapturedTriggerEvent({ captured });
    return;
  }
  if (run.status !== 'running') {
    // Parked or settled: the dispatch happened and only the receipt's mark was lost.
    await markTriggerEventDispatched(storedEventId);
    return;
  }
  const segment = await runningSegment(run.id, { now: ctx.now, staleAfterMs: ORPHAN_AFTER });
  switch (segment) {
    case 'orphaned':
      await settleUnresumableRun({ runId: run.id, reason: UNFINISHED_SEGMENT });
      await markTriggerEventFailed(storedEventId, UNFINISHED_SEGMENT);
      return;
    case 'live':
      // The lease lapses before the heartbeat goes stale, so a live beat may be
      // a dead process's last; look again once it would be stale. The orphan
      // sweep is the primary net.
      await enqueueWork({
        kind: 'dispatch_event',
        key: dispatchWorkKey(storedEventId),
        teamId: captured.teamId,
        payload,
        dueAt: new Date(ctx.now.getTime() + ORPHAN_AFTER),
      });
      return;
    case 'not_running':
      // Settled between the two reads.
      await markTriggerEventDispatched(storedEventId);
      return;
    default:
      neverAsAny(segment);
  }
}

/**
 * A row carrying a queued run: the run, not the receipt, says whether it still
 * has to happen — a replay re-runs a receipt that already settled. The first
 * claim of the waiting run starts it; any other claim finds it started and
 * treats it as `runReceipt` treats a run its receipt already started.
 */
async function runQueuedRun(input: {
  captured: CapturedTriggerEvent;
  runId: TriggerRunId;
  payload: unknown;
  ctx: WorkContext;
}): Promise<void> {
  const { captured, runId, ctx } = input;
  if (await claimQueuedRun(runId)) {
    await dispatchCapturedTriggerEvent({ captured });
    return;
  }
  const segment = await runningSegment(runId, { now: ctx.now, staleAfterMs: ORPHAN_AFTER });
  switch (segment) {
    case 'orphaned':
      await settleUnresumableRun({ runId, reason: UNFINISHED_SEGMENT });
      if (captured.storedEventId !== undefined) {
        await markTriggerEventFailed(captured.storedEventId, UNFINISHED_SEGMENT);
      }
      return;
    case 'live':
      await enqueueWork({
        kind: 'dispatch_event',
        key: queuedRunWorkKey(runId),
        teamId: captured.teamId,
        payload: input.payload,
        dueAt: new Date(ctx.now.getTime() + ORPHAN_AFTER),
      });
      return;
    case 'not_running':
      return;
    default:
      neverAsAny(segment);
  }
}

export const dispatchEventHandler: WorkHandler = { run: runReceipt, recover: runReceipt };

export function registerDispatchWork(): void {
  registerWorkHandler('dispatch_event', dispatchEventHandler);
}

async function loadReceiptStates(
  storedEventIds: TriggerEventId[],
): Promise<Map<TriggerEventId, { status: string; failureReason: string | null }>> {
  if (storedEventIds.length === 0) return new Map();
  const rows = await getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('id', 'in', storedEventIds)
    .select(['id', 'status', 'failure_reason'])
    .execute();
  return new Map(
    rows.map((row) => [row.id, { status: row.status, failureReason: row.failure_reason }]),
  );
}

/** The failure reason of each receipt that settled `failed`, by receipt id. */
export async function loadFailedReceipts(
  storedEventIds: TriggerEventId[],
): Promise<Map<TriggerEventId, string>> {
  const states = await loadReceiptStates(storedEventIds);
  const failed = new Map<TriggerEventId, string>();
  for (const [id, state] of states) {
    if (state.status === 'failed') failed.set(id, state.failureReason ?? 'dispatch failed');
  }
  return failed;
}

/** One reported unit of a harness delivery (an event, a team) and its receipts. */
export interface ReceiptGroup<G> {
  group: G;
  receipts: CapturedTriggerEvent[];
}

/**
 * The outcome a test-harness door reports once its rows drained: a group
 * cleared unless one of its receipts settled `failed`, or is still `received`
 * for a team whose rows did not settle in time.
 */
export async function readReceiptGroupOutcomes<G>(input: {
  groups: ReceiptGroup<G>[];
  settle: SettleReport;
}): Promise<{ cleared: G[]; failed: { group: G; error: string }[] }> {
  const ids = input.groups.flatMap(({ receipts }) =>
    receipts.flatMap((r) => (r.storedEventId !== undefined ? [r.storedEventId] : [])),
  );
  const states = await loadReceiptStates(ids);
  const errorOf = (receipt: CapturedTriggerEvent): string | undefined => {
    if (receipt.storedEventId === undefined) return undefined;
    const state = states.get(receipt.storedEventId);
    if (state?.status === 'failed') return state.failureReason ?? 'dispatch failed';
    if (state?.status === 'received' && input.settle.unsettledTeamIds.has(receipt.teamId)) {
      return input.settle.unsettledError;
    }
    return undefined;
  };
  const cleared: G[] = [];
  const failed: { group: G; error: string }[] = [];
  for (const { group, receipts } of input.groups) {
    const error = receipts.map(errorOf).find((e) => e !== undefined);
    if (error === undefined) cleared.push(group);
    else failed.push({ group, error });
  }
  return { cleared, failed };
}
