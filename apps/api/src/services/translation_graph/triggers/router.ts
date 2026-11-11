// Trigger router — the entry point for inbound trigger events. Resolves
// the pipeline_input's attachment mode (direct vs message), loads the
// translation graph, builds the mutation context, and dispatches to the
// engine.
//
// Existing trigger sources (polling workers, webhook handlers, mutation
// hooks) call into this module rather than constructing engine contexts
// themselves. This is the seam between "events arrive" and "engine runs".

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { EvaluationResult } from '../engine/types';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { handleError } from '../../../lib/errors';
import { logger } from 'movement-engine/public/log';
import { resolveAdapter } from '../adapters/resolve';
import { loadTriggerById } from '../storage/tg_table';
import {
  TriggerRunRecorder,
  type TriggerRunTriggerType,
} from '../runs/trigger_run';
import { runModeGate } from './run_mode';
import { consultActorGate } from './actor_gate';
import { pinIsCarried } from '../../access/carried_pin';
import * as loopGuard from '../../loop_guard';
import { isWriteEffect } from 'movement-engine/public/trace';
import { notifyBreach } from '../../loop_guard/notify';
import { resolveThresholds } from '../../loop_guard/thresholds';
import { neverAsAny } from 'movement-engine/public/types';
import { describeDroppedReason, type DroppedReason } from './dropped_reason';
import { isLfEngineTeam } from '../../lf_engine/team_engine';
import {
  runMovementFiring,
  doorRefusal, shippedMovementForTrigger,
} from '../movement/execute';

// ── Trigger-id dispatch (R, 2026-05-28) ───────────────────────────────────
//
// Inbound resolvers find a `automations.trigger` row and dispatch via this
// entry point. A movement-derived trigger fires through the movement engine;
// legacy (non-movement) triggers are dropped — the TG execution engine has
// been retired (plans/2026-06-14-kill-tg).

export interface TriggerIdDispatchInput {
  /** The pre-resolved trigger id (caller already looked this up). */
  triggerId: string;
  /** The inbound event to dispatch. */
  event: TriggerEvent;
  /** Team scope (matches the trigger's team_id). */
  teamId: TeamId;
  /** Optional override for the trigger_type recorded on tg_run rows. */
  recordingTriggerType?: TriggerRunTriggerType;
  /** Dry-run mode — captures writes instead of committing. */
  dryRun?: boolean;
  /**
   * Adopt an EXISTING `trigger_run` id for a movement firing rather than
   * minting a fresh one inside the recorder. A queued run (a `fire_event`
   * row, inbound/fire_event.ts) is inserted waiting under its listen's
   * receipt; the worker that drains its row dispatches here, and the firing's
   * recorder upserts THAT row to its terminal status. Absent ⇒ the firing
   * mints its own id.
   */
  existingRunId?: TriggerRunId;
  /** Where the delivery that started the run was kept in the arrival log:
   *  the run reads its trigger's waits from there. */
  triggerMark?: number;
}

export interface TriggerIdDispatchResult {
  /** TG entries that ran. One element per non-placeholder binding. */
  evaluations: Array<{ triggerEntryId: string; result: EvaluationResult }>;
  /**
   * Movement firings this dispatch executed (movement-derived triggers
   * run through the movement engine, not the TG evaluations above).
   * Surfaced so direct injectors — Run-now's manual-channel injection —
   * can report what the firing did without a second source of truth.
   */
  movementFirings?: Array<{
    movementName: string;
    /** Writes the firing applied (program-order count). */
    writes: number;
    /** The firing rehearsed (run_mode dry_run or an explicit dry run). */
    dryRun: boolean;
  }>;
  /** Why the dispatch produced no evaluations, when applicable. */
  droppedReason?: DroppedReason;
  /**
   * Per-binding orchestration-walk failures. A bound, authored automation
   * that THREW (e.g. a missing target credential) lands here rather than
   * silently producing zero evaluations — so callers can tell "errored"
   * apart from "nothing to do" and surface the real reason.
   */
  errors?: Array<{ triggerEntryId: string; message: string }>;
}

/**
 * Dispatch an inbound event for a given trigger. Movement-derived triggers
 * fire through `runMovementFiring`; legacy (non-movement) triggers are
 * dropped — the TG execution engine has been retired
 * (plans/2026-06-14-kill-tg).
 */
export async function dispatchTriggerByIdEvent(
  input: TriggerIdDispatchInput,
): Promise<TriggerIdDispatchResult> {
  // The engine switch, before anything else (read through the process's copy
  // of the lf-engined teams, so no query per firing): an lf-engined team's
  // listeners are lf's to run, so a live firing here is dropped (its
  // delivery stays kept, and replayable). Every door passes here (inbound, poll, cron,
  // Run-now); an explicit dry run is the editor's test run, which runs nothing
  // for real, so it still dispatches.
  if (!input.dryRun && (await isLfEngineTeam(input.teamId))) {
    logger.info('[TGRouter] dropped: the team\'s engine is lf', { triggerId: input.triggerId });
    return { evaluations: [], droppedReason: 'engine_lf' };
  }

  const triggerRow = await loadTriggerById(input.triggerId);
  if (!triggerRow) {
    logger.warn('[TGRouter] dispatchTriggerByIdEvent: trigger not found', {
      triggerId: input.triggerId,
    });
    return { evaluations: [], droppedReason: 'trigger_not_found' };
  }

  // run_mode gate (sits on top of `onlyAuthored`): `off` drops the event,
  // `dry_run` runs the orchestration but captures writes instead of
  // committing, `live` dispatches normally. An explicit `input.dryRun`
  // (e.g. a test-run) still forces dry-run regardless of the stored mode.
  const gate = runModeGate(triggerRow.runMode);
  if (!gate.dispatch) {
    logger.info('[TGRouter] dispatchTriggerByIdEvent dropped: run_mode off', {
      triggerId: input.triggerId,
    });
    return { evaluations: [], droppedReason: gate.droppedReason };
  }
  const dryRun = input.dryRun || gate.dryRun;

  // A trigger row is a listen: the pin's version is asked to fire its listens
  // before the guard counts the arrival, a source adapter is built for it or
  // its sender is judged. A version that does not gets none of that, and the
  // firing below records the refusal.
  // What fires is the shipped version, never the row's live text: an edit
  // whose save stopped at `needsConfirmation` changes nothing that runs.
  // This holds under dry run too (a `dry_run` listener rehearses what would
  // fire); the editor's test run, which tries the draft, does not come
  // through here.
  const fired =
    triggerRow.movementId === null
      ? undefined
      : await shippedMovementForTrigger({ teamId: input.teamId, movementId: triggerRow.movementId });
  const refused = fired?.kind === 'shipped' && doorRefusal(fired.movement.version.languageVersion, { kind: 'listen' }) !== undefined;

  // ── LOOP GUARD (Phase 1, the safety floor) ───────────────────────────────
  // The cause-agnostic backstop, consulted ONCE per run, composed with the
  // run_mode gate above (the established "don't run this" precedent). It does
  // two things, in order:
  //   (a) honour an EXISTING guard-pause — a prior team-budget breach already
  //       parked this automation; skip the run (its delivery is replayable).
  //   (b) EVALUATE this run against the floor — a team-budget breach pauses;
  //       a per-trigger rate breach throttles (queue-don't-drop).
  // Both are skipped under dry-run (a rehearsal can't loop in production) and
  // both FAIL OPEN — the evaluate() call and the paused-state read are
  // wrapped so any guard error allows the run.
  if (!dryRun && !refused) {
    const guardDisposition = await applyLoopGuard({
      triggerId: input.triggerId,
      teamId: input.teamId,
      triggerName: triggerRow.name,
      movementId: triggerRow.movementId,
    });
    if (guardDisposition) return { evaluations: [], droppedReason: guardDisposition };
  }

  // A run's own echo is the loop breaker's (inbound/loop_breaker.ts): it
  // caps every chain of writes and arrivals as a queued run starts.
  //
  // Who may start an automation on the current pin is its fire list's, judged
  // at the door; Slack's own setting drops the app's messages. A carried pin's
  // receipts never say who acted, so no fire list can judge them (its list is
  // forced to anyone): the ownership gate stays the stranger check there.
  if (!dryRun && !refused && fired?.kind === 'shipped' && pinIsCarried(fired.movement.row.languageVersion)) {
    const sourceAdapter = await resolveAdapter({
      adapterType: input.event.adapterType,
      teamId: input.teamId,
      credentialsId: triggerRow.credentialsId ?? undefined,
    });

    // ── OWNERSHIP GATE (§6.4b — registered actors only, where declared) ────
    // It asks the source adapter "is the sender one of ours". Fail closed; the
    // delivery stays replayable.
    const actorGate = await consultActorGate({
      teamId: input.teamId,
      sourceAdapter,
      event: input.event,
    });
    if (actorGate.kind === 'drop') {
      logger.info('[TGRouter] dispatch dropped — inbound actor is not a registered user (ownership gate)', {
        triggerId: input.triggerId,
        adapterType: input.event.adapterType,
        reason: actorGate.reason,
      });
      return { evaluations: [], droppedReason: 'actor_unregistered' };
    }
  }

  const recordingTriggerType: TriggerRunTriggerType =
    input.recordingTriggerType ?? mapRecordingTriggerType(input.event.triggerType);

  // A movement-derived trigger (6_engine.md) fires through `runMovement`
  // on the canonical text — the movement engine is the only executor;
  // the trigger row is purely the dispatch index and carries no
  // orchestration. Hand-authored triggers fall through to the run_tg
  // path below, untouched. Failure containment lives inside
  // `runMovementFiring`: a thrown engine error records a FAILED
  // trigger_run and comes back as a value — dispatch never crashes.
  if (fired !== undefined) {
    if (fired.kind === 'not_shipped') {
      logger.info('[TGRouter] dropped: the movement has never shipped', {
        triggerId: input.triggerId,
        movementId: triggerRow.movementId,
      });
      return { evaluations: [], droppedReason: 'not_shipped' };
    }
    if (fired.kind === 'missing') {
      logger.warn('[TGRouter] dispatchTriggerByIdEvent: movement row not found', {
        triggerId: input.triggerId,
        movementId: triggerRow.movementId,
      });
      return {
        evaluations: [],
        errors: [
          {
            triggerEntryId: input.triggerId,
            message: `movement ${triggerRow.movementId} not found for trigger ${input.triggerId}`,
          },
        ],
      };
    }
    const firing = await runMovementFiring({
      teamId: input.teamId,
      // A trigger row is a listen: its firing asks the pin's version to fire
      // its listens before anything else.
      door: { kind: 'listen' },
      triggerId: input.triggerId,
      triggerName: triggerRow.name,
      ...(triggerRow.firedMovementName !== null
        ? { firedMovementName: triggerRow.firedMovementName }
        : {}),
      movement: fired.movement,
      event: input.event,
      recordingTriggerType,
      dryRun,
      ...(input.existingRunId !== undefined ? { existingRunId: input.existingRunId } : {}),
      ...(input.triggerMark !== undefined ? { triggerMark: input.triggerMark } : {}),
    });
    if (firing.result) {
      // Feed the writes this firing applied into the team's external-write
      // budget (multi-dimensional floor). Fire-and-forget + fail-open — never
      // block dispatch on guard accounting. Skipped under dry-run (no writes
      // actually landed).
      // A record a `match` found is on the run log but wrote nothing.
      const written = firing.result.writes.filter(isWriteEffect).length;
      if (!dryRun && written > 0) {
        loopGuard
          .recordExternalWrites({
            teamId: input.teamId,
            count: written,
          })
          .catch(handleError);
      }
      return {
        evaluations: [],
        movementFirings: [
          {
            movementName: firing.result.movementName,
            writes: written,
            dryRun,
          },
        ],
      };
    }
    return {
      evaluations: [],
      errors: [
        { triggerEntryId: input.triggerId, message: firing.error ?? 'movement firing failed' },
      ],
    };
  }

  // A trigger with no movementId is a legacy TG-orchestration binding. The TG
  // execution engine has been retired (plans/2026-06-14-kill-tg) — only
  // movement-derived triggers execute. Nothing to dispatch.
  logger.warn('[TGRouter] dispatchTriggerByIdEvent: trigger has no movement; TG dispatch retired', {
    triggerId: input.triggerId,
  });
  return { evaluations: [], droppedReason: 'no_movement' };
}

/**
 * The loop-guard check for one dispatch. Returns a `droppedReason` when the run
 * must be SUPPRESSED (and arranges the queue-don't-drop / pause side effects),
 * or `undefined` to let dispatch proceed.
 *
 * Fail-open is enforced here too: the guard-paused read and `evaluate()` both
 * already swallow their own errors, but this wrapper additionally try/catches so
 * a guard fault can never crash dispatch — it allows the run.
 *
 */
export async function applyLoopGuard(input: {
  triggerId: string;
  teamId: TeamId;
  triggerName: string;
  movementId: string | null;
}): Promise<'loop_guard_paused' | 'loop_guard_throttled' | undefined> {
  try {
    // (a) Already guard-paused? Skip the run. Its delivery is kept, so the
    //     paused automation's backlog is replayable once a human resumes. We honour the pause even in observe
    //     mode — a human (or the guard in a prior enforce window) set it
    //     deliberately, and observe-mode only governs whether the guard sets
    //     NEW pauses, not whether it respects existing ones.
    const paused = await loopGuard.loadGuardPausedState(input.triggerId);
    if (paused.pausedAt !== null) {
      logger.info('[LoopGuard] dispatch skipped — automation guard-paused', {
        triggerId: input.triggerId,
        signal: paused.signal,
        reason: paused.reason,
      });
      return 'loop_guard_paused';
    }

    // (b) Evaluate this run against the floor.
    const decision = await loopGuard.evaluate({
      teamId: input.teamId,
      triggerId: input.triggerId,
      movementId: input.movementId,
      triggerName: input.triggerName,
    });

    if (decision.kind === 'allow') return undefined;

    if (decision.kind === 'pause') {
      // Observe mode: the decision was already logged as "would-pause" by
      // evaluate(); do nothing else and let the run proceed.
      if (!decision.enforced) return undefined;
      const { newlyPaused } = await loopGuard.setGuardPaused({
        triggerId: input.triggerId,
        reason: decision.reason,
        signal: decision.signal,
      });
      if (newlyPaused) {
        const t = resolveThresholds();
        // Fire-and-forget — a notify failure must never break dispatch.
        notifyBreach({
          teamId: input.teamId,
          triggerId: input.triggerId,
          triggerName: input.triggerName,
          signal: decision.signal,
          reason: decision.reason,
          observed: t.teamRunsPerWindow + 1,
          limit: t.teamRunsPerWindow,
          windowSeconds: t.teamWindowSeconds,
        }).catch(handleError);
      }
      return 'loop_guard_paused';
    }

    if (decision.kind === 'throttle') {
      if (!decision.enforced) return undefined;
      // QUEUE-DON'T-DROP: the caller holds the run's row (a `fire_event`
      // row, inbound/fire_event.ts) and releases it to retry later.
      logger.info('[LoopGuard] run held — its row retries after the rate window (queue-don\'t-drop)', {
        triggerId: input.triggerId,
        reason: decision.reason,
      });
      return 'loop_guard_throttled';
    }

    return neverAsAny(decision);
  } catch (err) {
    // FAIL-OPEN — never block a legitimate run on a guard fault.
    logger.warn('[LoopGuard] applyLoopGuard threw — failing open (allowing run)', {
      triggerId: input.triggerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function mapRecordingTriggerType(eventTriggerType: string): TriggerRunTriggerType {
  if (eventTriggerType === 'snapshot') return 'snapshot';
  if (eventTriggerType === 'mutation') return 'mutation';
  return 'webhook';
}
