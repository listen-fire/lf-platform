// The hosted product's step for the run-host core's drains: one engine segment
// of a parked run (a leaf resumed, or a race settled with its winners), run
// against the run's PINNED version (P11) and recorded on its trigger_run. The
// drains themselves (which leaves, in what order, what a failure tears down)
// are the core's (run_host/drain.ts).

import { logger } from 'movement-engine/public/log';
import { z } from 'zod';
import { triggerEventSchema, type TriggerEvent } from 'movement-engine/public/inbound';
import { neverAsAny } from 'movement-engine/public/types';

import { resumingOf, type CarriedEvent, type CarriedStep, type ResumingLane } from '@listen-fire/language-versions';
import { isLegacyLanguageVersion } from 'legacy-lang';
import { drainDueTimers, drainRun, type HeldRunLease } from 'movement-engine/public/run-host';

import type { ParkReason } from 'engine-contracts';
import type { LanguageVersion } from 'movement-lang';
import type { StepLeaf, StepOutcome } from 'movement-engine/public/run-host';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { TriggerRunTriggerType } from '../translation_graph/runs/trigger_run';

import { getAutomationsQb } from '../../lib/kysely';
import { CARRIED_RUN_NOW_NAME, carriedRunTriggerId } from '../translation_graph/movement/carried_names';
import { resumeMovementFiring, type MovementFiringOutcome } from '../translation_graph/movement/execute';
import { loadPinnedVersion } from '../translation_graph/movement/version_store';
import { loadTriggerById } from '../translation_graph/storage/tg_table';
import { carriedRunHost } from './carried_host';
import { hostedRunHost } from './run_host';

/** Everything a segment needs to re-enter a run: its pinned source (the
 *  stored addresses name THAT AST), its trigger, its inbound event. */
export interface RunContext {
  teamId: TeamId;
  triggerId: string;
  triggerName: string;
  firedMovementName: string | null;
  movementId: string;
  movementVersionId: string;
  pinnedSource: string;
  pinnedLanguageVersion: LanguageVersion;
  /** The event as this release records it on the run. */
  event: TriggerEvent;
  triggerType: TriggerRunTriggerType;
  /** The version whose own rules and engine step the run, and the event in that
   *  version's shape; absent when this release's engines do. */
  carried?: { lane: ResumingLane; event: CarriedEvent };
}

/** The pin's carried lane, when its version resumes on its own engine. A legacy
 *  id resumes on the legacy packages. */
async function carriedLaneOf(pin: LanguageVersion): Promise<ResumingLane | undefined> {
  if (isLegacyLanguageVersion(pin)) return undefined;
  const resuming = resumingOf(pin);
  return resuming.kind === 'carried' ? resuming.lane() : undefined;
}

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** What a run fired through: its trigger row, or, for a Run now of a carried
 *  version, its movement (which has no trigger row: its id stands in, and the
 *  movement it fires is read by the version's own parser). */
async function firedThrough(input: {
  triggerId: string;
  movementId: string | null;
  source: string;
  languageVersion: LanguageVersion;
  lane: ResumingLane | undefined;
}): Promise<{ triggerName: string; firedMovementName: string | null; movementId: string } | null> {
  const trigger = await loadTriggerById(input.triggerId);
  if (trigger?.movementId != null) return { triggerName: trigger.name, firedMovementName: trigger.firedMovementName, movementId: trigger.movementId };
  if (input.lane === undefined || input.movementId === null || carriedRunTriggerId(input.movementId) !== input.triggerId) return null;
  const [fired] = input.lane.manualListens({ source: input.source, pin: input.languageVersion });
  return { triggerName: CARRIED_RUN_NOW_NAME, firedMovementName: fired ?? null, movementId: input.movementId };
}

/** Why a run cannot be re-entered, or its context. */
export async function loadRunContext(runId: TriggerRunId): Promise<RunContext | { unresumable: string }> {
  const run = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select(['team_id', 'trigger_id', 'trigger_type', 'trigger_payload', 'movement_version_id'])
    .executeTakeFirst();
  if (!run || !run.trigger_payload) return { unresumable: 'trigger_run missing or has no payload' };
  const pinned = run.movement_version_id ? await loadPinnedVersion(run.movement_version_id) : null;
  if (!run.movement_version_id || !pinned) return { unresumable: 'no pinned movement_version source (P11)' };
  const lane = await carriedLaneOf(pinned.languageVersion);
  const version = await getAutomationsQb(['movement_version'])
    .selectFrom('movement_version')
    .where('id', '=', run.movement_version_id)
    .select('movement_id')
    .executeTakeFirst();
  const through = await firedThrough({
    triggerId: run.trigger_id,
    movementId: version?.movement_id ?? null,
    source: pinned.source,
    languageVersion: pinned.languageVersion,
    lane,
  });
  if (through === null) return { unresumable: 'trigger gone or not movement-derived' };
  const common = {
    // `trigger_run.team_id` is an opaque tenant uuid (D3 dropped the FK, and
    // with it the brand); naming it as core's team id is the boundary conversion.
    teamId: run.team_id as TeamId,
    triggerId: run.trigger_id,
    ...through,
    movementVersionId: run.movement_version_id,
    pinnedSource: pinned.source,
    pinnedLanguageVersion: pinned.languageVersion,
    triggerType: run.trigger_type as TriggerRunTriggerType,
  };
  if (lane === undefined) return { ...common, event: triggerEventSchema.parse(run.trigger_payload) as TriggerEvent };
  // The event is in the shape of the version it fired under, and only that
  // version reads it.
  const event = jsonObjectSchema.parse(run.trigger_payload);
  const read = lane.readEvent(event);
  if (!read.ok) return { unresumable: `the run's event could not be read under language ${pinned.languageVersion}: ${read.reason}` };
  return { ...common, event: read.record, carried: { lane, event } };
}

/** What one segment came to, as the core's drains read it. */
function stepOutcomeOf(outcome: MovementFiringOutcome): StepOutcome {
  if (outcome.leaseLost === true) return { kind: 'leaseLost' };
  if (outcome.result === null) return { kind: 'failed', error: outcome.error ?? 'the segment failed' };
  const { result } = outcome;
  if (result.cancelled === true) return { kind: 'cancelled', ...(outcome.cancelReason !== undefined ? { reason: outcome.cancelReason } : {}) };
  const deferredRaceFrames = result.deferredRaceFrames ?? [];
  if (result.parked === true) return { kind: 'parked', parkedAddress: result.parkedAddress, deferredRaceFrames };
  return { kind: 'completed', deferredRaceFrames };
}

/**
 * The step for one parked run's drain, under the lease `lease`; its context
 * loads once. Null (logged under `log`) when the run cannot be re-entered:
 * its leaves stay as they are.
 */
export async function parkedRunStep(input: { runId: TriggerRunId; lease?: HeldRunLease; log: string }): Promise<StepLeaf | null> {
  const { runId, lease } = input;
  const context = await loadRunContext(runId);
  if ('unresumable' in context) {
    logger.error(`[${input.log}] cannot resume: ${context.unresumable}`, { runId });
    return null;
  }
  return stepFor(context, runId, lease);
}

function stepFor(context: RunContext, runId: TriggerRunId, lease: HeldRunLease | undefined): StepLeaf {
  const firing = firingFields(context, runId, lease);
  return async (request, settle) => {
    const common = { ...firing, state: request.state, settleBranchComplete: async () => ({ runComplete: await settle.runComplete() }) };
    switch (request.kind) {
      case 'leaf':
        return stepOutcomeOf(
          await resumeMovementFiring({
            ...common,
            // A slept timer steps past its sleep; anything else re-enters to
            // re-check live (an await binds its own landing, nothing injected).
            ...(request.reenter ? { reenter: true } : {}),
            resumedLeaf: request.address,
            deferRaceSettlement: request.deferRaceSettlement,
          }),
        );
      case 'race':
        return stepOutcomeOf(await resumeMovementFiring({ ...common, settleRaceFrameAddress: request.frameAddress }));
      default:
        return neverAsAny(request);
    }
  };
}

/** What every segment of one parked run shares. */
function firingFields(context: RunContext, runId: TriggerRunId, lease: HeldRunLease | undefined) {
  return {
    teamId: context.teamId,
    triggerId: context.triggerId,
    triggerName: context.triggerName,
    ...(context.firedMovementName !== null ? { firedMovementName: context.firedMovementName } : {}),
    pinnedSource: context.pinnedSource,
    pinnedLanguageVersion: context.pinnedLanguageVersion,
    movementVersionId: context.movementVersionId,
    runId,
    movementId: context.movementId,
    event: context.event,
    recordingTriggerType: context.triggerType,
    ...(lease !== undefined ? { lease } : {}),
    ...(context.carried !== undefined ? { carried: context.carried } : {}),
  };
}

/** The step of a run a carried version parked: the park state stays that
 *  version's, unread here. */
function carriedStepOf(context: RunContext, runId: TriggerRunId, lease: HeldRunLease | undefined): CarriedStep {
  const firing = firingFields(context, runId, lease);
  return async (request, settle) => {
    const common = { ...firing, carriedState: request.state, settleBranchComplete: async () => ({ runComplete: await settle.runComplete() }) };
    switch (request.kind) {
      case 'leaf':
        return stepOutcomeOf(
          await resumeMovementFiring({
            ...common,
            ...(request.reenter ? { reenter: true } : {}),
            resumedLeaf: request.address,
            deferRaceSettlement: request.deferRaceSettlement,
          }),
        );
      case 'race':
        return stepOutcomeOf(await resumeMovementFiring({ ...common, settleRaceFrameAddress: request.frameAddress }));
      default:
        return neverAsAny(request);
    }
  };
}

/** The step of a run a carried version parked; null (logged under `log`) when it
 *  cannot be re-entered or its version does not step it. */
export async function carriedRunStep(input: { runId: TriggerRunId; lease?: HeldRunLease; log: string }): Promise<CarriedStep | null> {
  const context = await loadRunContext(input.runId);
  if ('unresumable' in context) {
    logger.error(`[${input.log}] cannot resume: ${context.unresumable}`, { runId: input.runId });
    return null;
  }
  if (context.carried === undefined) {
    logger.error(`[${input.log}] cannot resume: a run pinned to ${context.pinnedLanguageVersion} parked on a key no carried version of it steps`, { runId: input.runId });
    return null;
  }
  return carriedStepOf(context, input.runId, input.lease);
}

/** How one parked run's leaves are stepped: by its own version's rules. */
export interface RunDriver {
  drainDueTimers(input: { dueBy: string }): Promise<'done' | 'leaseLost'>;
  drainLeaves(input: { addresses: readonly string[]; reason: ParkReason; until?: () => Promise<boolean> }): Promise<'done' | 'leaseLost'>;
}

/**
 * The driver for one parked run; null (logged under `log`) when it cannot be
 * re-entered, so its leaves stay as they are. `onLeaf` hears each leaf stepped.
 */
export async function parkedRunDriver(input: { runId: TriggerRunId; lease?: HeldRunLease; log: string; onLeaf?: () => void }): Promise<RunDriver | null> {
  const { runId, lease, onLeaf } = input;
  const context = await loadRunContext(runId);
  if ('unresumable' in context) {
    logger.error(`[${input.log}] cannot resume: ${context.unresumable}`, { runId });
    return null;
  }
  const held = lease !== undefined ? { lease } : {};
  if (context.carried !== undefined) {
    const { lane } = context.carried;
    const stepped = carriedStepOf(context, runId, lease);
    const step: CarriedStep = (request, settle) => {
      if (request.kind === 'leaf') onLeaf?.();
      return stepped(request, settle);
    };
    return {
      drainDueTimers: ({ dueBy }) => lane.drainDueTimers(carriedRunHost(), { runId, dueBy, ...held, step }),
      drainLeaves: ({ addresses, reason, until }) => lane.drainLeaves(carriedRunHost(), { runId, addresses, reason, ...held, step, ...(until !== undefined ? { until } : {}) }),
    };
  }
  const stepped = stepFor(context, runId, lease);
  const step: StepLeaf = (request, settle) => {
    if (request.kind === 'leaf') onLeaf?.();
    return stepped(request, settle);
  };
  return {
    drainDueTimers: ({ dueBy }) => drainDueTimers(hostedRunHost(), { runId, teamId: context.teamId, dueBy, ...held, step }),
    drainLeaves: ({ addresses, reason, until }) =>
      drainRun(hostedRunHost(), { runId, teamId: context.teamId, leaves: { addresses, reason }, ...held, step, ...(until !== undefined ? { until } : {}) }),
  };
}
