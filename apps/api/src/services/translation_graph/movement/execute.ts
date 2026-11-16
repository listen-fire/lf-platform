// Movement firings on the movement engine.
//
// Movements execute from their SHIPPED TEXT through `runMovement`
// (services/movement_engine/run.ts), against the team catalog: a fresh firing
// runs the movement's current version (`movement_version` at
// `current_version_id`), never the row's live `source`, which may be an edit
// whose save stopped at `needsConfirmation` and never shipped; a resume runs
// the version its run pinned. Imported files resolve to their shipped text
// too. A movement with no current version has never shipped and does not
// fire. The editor's test run (./test_run.ts) is the one runner of the live
// text. The one
// consumer is `dispatchTriggerByIdEvent` (triggers/router.ts): every
// movement-derived trigger (trigger.movement_id set) fires through
// `runMovementFiring` — live events, kg mutations, cron ticks, and
// "Run now"'s manual-channel injections alike (run_now.ts dispatches
// through the router; there is no separate execution entry).
//
// Failure containment: engine errors record a FAILED trigger_run (never
// crash dispatch); a construct outside the engine's slice surfaces as
// MOVENG_UNSUPPORTED naming the construct. The save-time dry
// interpretability check (movement_engine/interpretable.ts) makes that a
// last line of defence, not the discovery mechanism.

import { LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementTraceEntry } from 'movement-engine/public/trace';
import type { AnyParkedScopeState } from 'engine-contracts';
import type { TriggerEventId } from '../../../generated/kysely/automations/TriggerEvent';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { refusalOf, type CarriedEvent, type ResumingLane, type RunningCapability } from '@listen-fire/language-versions';
import { neverAsAny } from 'movement-engine/public/types';
import { isLegacyLanguageVersion } from 'legacy-lang';
import { describeError } from 'movement-engine/public/errors';
import { withoutLibraryLines } from './save_access';
import { logger } from 'movement-engine/public/log';
import { legacyRunRefusal, refuseHeldRun, runMovement, resumeMovement, settleRaceFrame } from '../../movement_engine/dispatch/dispatch';
import { MovementRunFailed, runFailureCause, type CancelGate, type MovementRunResult } from 'movement-engine/public/movement-engine';
import { makeDbCancelGate, type DbCancelGate } from '../../movement_engine/cancel_gate';
import { carriedParksOf, carriedRunLaneOf, resumeCarriedSegment, runCarriedSegment } from './carried_run';
import { failRunAndCancelRequests } from '../../interaction/run_failure';
import { LlmUsageContext } from '../../../lib/llm_usage';
import { runCostCapFromEnv } from 'movement-engine/public/models';
import { noteFirstFiringLeaseLost, TriggerRunRecorder, type TriggerRunTriggerType } from '../runs/trigger_run';
import { runCatalogSnapshotForTeam } from './catalog';
import { getMovementRow, recordValidityOutcome, type MovementRow } from './store';
import { assessMovementValidity, validateMovementForTeam } from './authoring';
import { loadPinnedVersion, movementSourceHash } from './version_store';
import { libraryRefusal } from './library_refusal';
import { recordMovementFailureIssue, resolveMovementIssues } from './issues';
import { clearIntrospectionCache } from './instance_cache';
import { engineEvent, withFiringContext } from './firing_context';
import { productionEngineHost } from './engine_host';
import { tenantOfTeam } from './tenant';
import { RunLeaseLost, takeRunLease, type HeldRunLease } from '../../movement_engine/run_lease';

// ── The shared engine invocation (catalog assembly + runMovement) ───────────

/**
 * Run one movement firing: assemble the team catalog snapshot for exactly the
 * (adapter, credential) pairs the SAVED source constructs, then hand
 * `runMovement` the canonical text and the snapshot (its credential ids go to
 * the host, never the engine). Natural-name → internal-id translation
 * is the adapter layer's job — the engine derives each instance's
 * `AdapterNameResolver` from its own introspection (the default `resolveNames`
 * seam, behind the same cache the catalog's schemas come from); the host
 * holds no naming map.
 */
async function interpretMovementFiring(input: {
  teamId: TeamId;
  version: ShippedVersion;
  door: FiringDoor;
  /** Which movement in the file to run; absent = the file's only one. */
  movementName?: string;
  event: TriggerEvent;
  /** When the run fired — the recorder's `firedAt`, which is the run row's
   *  `started_at`. Every clock read in the run answers from it. */
  firedAt: Date;
  dryRun?: boolean;
  /** The trigger run this firing is — its model calls are billed to it, and
   *  the engine's log lines name it. */
  triggerRunId: TriggerRunId;
  /** The recorder the run's parks persist through — present for
   *  live firings (an `ask` parks into the recorder's run). Absent under dry
   *  runs: a test run never parks and mints nothing durable. */
  parksInto?: TriggerRunRecorder;
  /** The cooperative cancel gate (runs-and-cancel spec §cancel) — stops the run
   *  at the next statement / LLM-call boundary on a user cancel. */
  cancelGate: DbCancelGate;
  /** The array the run appends its decision trace to — supplied so a caller can
   *  publish the trace WHILE the run is going, not only once it settles. */
  trace?: MovementTraceEntry[];
  /** The run lease the firing holds; its parks are fenced by it. */
  lease?: HeldRunLease;
  /** Where the delivery that started the run was kept in the arrival log:
   *  the waits it opened on the trigger read from there. */
  triggerMark?: number;
}): Promise<MovementRunResult> {
  // A person's press of a pin a carried version runs is run by that
  // version's own engine and modules, on the event in its own shape: this
  // release's catalog and parser never read its text.
  if (input.door.kind === 'manual' || input.door.kind === 'judged') {
    const carried = await carriedRunLaneOf(input.version.languageVersion);
    if (carried !== undefined) {
      return runCarriedSegment({
        lane: carried,
        teamId: input.teamId,
        audience: { for: 'run' },
        source: input.version.source,
        pin: input.version.languageVersion,
        ...(input.movementName !== undefined ? { movementName: input.movementName } : {}),
        event: input.door.event,
        firedAt: input.firedAt,
        triggerRunId: input.triggerRunId,
        imports: 'shipped',
        cancel: input.cancelGate,
        ...(input.lease !== undefined ? { lease: input.lease } : {}),
        ...(input.trace !== undefined ? { trace: input.trace } : {}),
        ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        costCapMicrodollars: runCostCapFromEnv(),
        ...(input.parksInto !== undefined ? { park: carriedParksOf(input.parksInto, input.lease !== undefined ? { lease: input.lease } : {}) } : {}),
        ...(input.triggerMark !== undefined ? { triggerMark: input.triggerMark } : {}),
      });
    }
  }
  // Everything else runs on this release's engines, which refuse a pin they
  // do not run themselves before its text reaches this release's catalog.
  refuseHeldRun(input.version.languageVersion);
  const teamCatalog = await runCatalogSnapshotForTeam(input.teamId, {
    source: input.version.source,
    languageVersion: input.version.languageVersion,
    imports: 'shipped',
    audience: { for: 'run' },
  });
  return runMovement({
    source: input.version.source,
    // Compile and run under the shipped version's pin, never the release's.
    languageVersion: input.version.languageVersion,
    ...(input.movementName !== undefined ? { movementName: input.movementName } : {}),
    event: input.event,
    teamId: tenantOfTeam(input.teamId),
    firedAt: input.firedAt.toISOString(),
    // The deployment's cost cap, read once as the run starts.
    costCapMicrodollars: runCostCapFromEnv(),
    catalog: teamCatalog.snapshot,
    credentialIds: teamCatalog.credentialIds,
    runId: input.triggerRunId,
    host: productionEngineHost({
      teamId: input.teamId,
      triggerRunId: input.triggerRunId,
      ...(input.parksInto !== undefined ? { parksInto: input.parksInto } : {}),
      ...(input.lease !== undefined ? { lease: input.lease } : {}),
      cancel: input.cancelGate,
      ...(input.trace !== undefined ? { trace: input.trace } : {}),
    }),
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    ...(input.triggerMark !== undefined ? { triggerMark: input.triggerMark } : {}),
  });
}

/** What a failed run is recorded and reported as: the engine's words, without the lines of a library the check faulted. */
function describeRunFailure(error: unknown): string {
  return withoutLibraryLines(describeError(error));
}

// ── Entry point (a): trigger dispatch ───────────────────────────────────────

/**
 * Split a thrown run error into the ORIGINAL error — what the log and the run's
 * failure reason must say, unchanged — and the partial write ledger the engine
 * carried out with it. A non-engine throw (catalog assembly) has no ledger and
 * reads exactly as before.
 */
function unwrapRunFailure(err: unknown): { error: unknown; partial?: MovementRunResult } {
  const error = runFailureCause(err);
  return err instanceof MovementRunFailed ? { error, partial: err.partial } : { error };
}

export interface MovementFiringOutcome {
  /** Null when the firing failed (the failure is recorded + returned). */
  result: MovementRunResult | null;
  /** The firing's error, when it failed. */
  error?: string;
  /** The segment stopped because its run lease was lost: another instance may
   *  be stepping the run, so nothing was recorded or settled, and the caller
   *  must leave the run's rows alone too. */
  leaseLost?: true;
  /** A resumed segment an operator's cancel stopped: the reason they gave.
   *  The step is recorded; tearing the run down is the run host's
   *  (its drain's `afterStep`). */
  cancelReason?: string;
}

/** A segment that lost its run lease stops where it is: it records nothing,
 *  settles nothing and touches no parked row, since the run may be another
 *  instance's now. Null for any other failure. */
function leaseLostOutcome(
  err: unknown,
  context: { runId: TriggerRunId; movementId: string },
): MovementFiringOutcome | null {
  const { error } = unwrapRunFailure(err);
  if (!(error instanceof RunLeaseLost)) return null;
  return stoppedForLostLease(error, context);
}

/** Consulted before every settle. A segment whose lease lapsed during its
 *  last statement has no boundary after it to stop at: the engine returns
 *  normally, and this is where the loss is noticed. */
function leaseLostBeforeSettle(
  lease: { isLost(): boolean } | null | undefined,
  context: { runId: TriggerRunId; movementId: string },
): MovementFiringOutcome | null {
  if (lease?.isLost() !== true) return null;
  return stoppedForLostLease(new RunLeaseLost(context.runId), context);
}

function stoppedForLostLease(
  error: RunLeaseLost,
  context: { runId: TriggerRunId; movementId: string },
): MovementFiringOutcome {
  logger.error('[MovementEngine] segment stopped: run lease lost; another instance may hold the run', context);
  return { result: null, error: error.message, leaseLost: true };
}

/** A first firing that lost its lease leaves its run `running` for the new
 *  holder or the orphan sweep, noting why on the row. */
async function noteLostFirstFiring(runId: TriggerRunId, lost: MovementFiringOutcome): Promise<MovementFiringOutcome> {
  await noteFirstFiringLeaseLost(runId).catch((noteErr) =>
    logger.warn('[MovementEngine] could not note the lost lease on the run', {
      runId,
      error: noteErr instanceof Error ? noteErr.message : String(noteErr),
    }),
  );
  return lost;
}

/**
 * The dispatcher-side movement firing: one trigger_run for the firing
 * (recorded from `MovementRunResult`, per-field provenance summaries on
 * the step), failure contained — a thrown engine error records a FAILED
 * trigger_run and returns it as a value, never propagating into dispatch.
 */
/**
 * Prediction-rule hook (plans/2026-07-13-movement-validity-lifecycle): the
 * stored validity is a prediction; a run whose outcome CONTRADICTS it refreshes
 * it. Best-effort and post-`finish()` — a re-check error must never mask the run
 * outcome. Gated two ways:
 *   - version-match (decision 7): only a run of the CURRENT source may
 *     (in)validate it, so a stale run (source edited since dispatch) is ignored;
 *   - contradiction only: a `valid` run succeeding, or a non-`valid` run failing,
 *     is expected — no re-check, no adapter hit.
 */
async function refreshValidityOnContradiction(input: {
  teamId: TeamId;
  /** The movement that ran: its id + the SOURCE THAT EXECUTED (the live row's
   *  shipped version's source on a firing; the pinned version's on a resume). */
  movement: { id: string; source: string };
  outcome: 'success' | 'failure';
}): Promise<void> {
  try {
    const fresh = await getMovementRow({
      teamId: input.teamId as unknown as string,
      id: input.movement.id,
    });
    if (!fresh) return;
    // Version-match: byte-identity is the version equivalence (content-hash
    // dedup). If the source moved on since this run executed, the run is stale
    // evidence about a program that no longer exists.
    if (fresh.source !== input.movement.source) return;
    const contradiction =
      (input.outcome === 'success' && fresh.validityStatus !== 'valid') ||
      (input.outcome === 'failure' && fresh.validityStatus === 'valid');
    if (!contradiction) return;
    // A drift re-check that reads the introspection CACHE can't see drift —
    // the cached schema still describes the pre-drift adapter. Clear it so the
    // re-validation introspects fresh. Scoped to THIS team: a failure here says
    // nothing about anybody else's connections, and busting theirs made every
    // other tenant in the process re-introspect their whole surface.
    if (input.outcome === 'failure') clearIntrospectionCache(input.teamId);
    const validation = await validateMovementForTeam({
      teamId: input.teamId as unknown as string,
      source: fresh.source,
      // The automation's validity is its own: judged on every connection it runs on.
      audience: { for: 'run' },
      languageVersion: fresh.languageVersion,
    });
    const assessment = assessMovementValidity({
      diagnostics: validation.diagnostics,
      gaps: validation.gaps,
    });
    await recordValidityOutcome({
      id: fresh.id,
      status: assessment.status,
      reason: assessment.reason,
      sourceHash: movementSourceHash(fresh.source),
      checkedAgainst: fresh.languageVersion,
    });
  } catch (err) {
    logger.warn('[MovementEngine] validity re-check failed', {
      movementId: input.movement.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Which door started a firing. A listen's firing (a trigger row judged an
 * arrival: an inbound delivery, a poll, a schedule, a Run now through a
 * provisioned manual listen) needs the pin's version to fire its listens. A
 * person's press of an automation with no listen this platform fires (a
 * carried version's Run now) needs it to run a segment, and carries the event
 * in that version's own shape, read only by that version.
 */
export type FiringDoor =
  | { kind: 'listen' }
  | { kind: 'manual'; event: CarriedEvent }
  /** A firing a carried version judged itself, its event in that version's
   *  shape (carried_delivery.ts, or a row a 0.12.13 door queued). The judging
   *  is done, so only the running is asked. */
  | { kind: 'judged'; event: CarriedEvent };

/** The capability a firing's door needs of the pin's version. */
function neededBy(door: FiringDoor): RunningCapability {
  switch (door.kind) {
    case 'listen':
      return 'listen';
    case 'manual':
    case 'judged':
      return 'run';
    default:
      return neverAsAny(door);
  }
}

/** Why `pin`'s version does not serve `door`, in the registry's text;
 *  undefined when it does. A legacy id is served by no door: this platform no
 *  longer carries its engine. */
export function doorRefusal(pin: LanguageVersion, door: FiringDoor): string | undefined {
  if (isLegacyLanguageVersion(pin)) return legacyRunRefusal(pin, neededBy(door));
  return refusalOf(pin, neededBy(door));
}

type MovementFiringInput = {
  teamId: TeamId;
  /** Which door started it: what the pin's version is asked for first. */
  door: FiringDoor;
  triggerId: string;
  /** The trigger row's display name (a `listen as "…"` label when aliased) —
   *  recorded on the run, NOT parsed for the fired movement. */
  triggerName: string;
  /** The movement this listener fires (`trigger.fired_movement_name`) — picks
   *  the movement in a multi-movement file. Absent ⇒ fall back to the legacy
   *  name convention, then the file's sole declaration. */
  firedMovementName?: string;
  /** What fires: the movement and the version it shipped. */
  movement: ShippedMovement;
  /** The event as this release records it on the run. */
  event: TriggerEvent;
  recordingTriggerType: TriggerRunTriggerType;
  dryRun?: boolean;
  /** Adopt a pre-created `running` trigger_run row (async manual run — the
   *  caller minted the id so it could return it before this firing started).
   *  Absent ⇒ the recorder mints its own id, as before. */
  existingRunId?: TriggerRunId;
  /** Where the delivery that started the run was kept in the arrival log. */
  triggerMark?: number;
  /** The receipt it runs from, when a carried version's door kept one. */
  triggerEventId?: TriggerEventId;
};

/** A fresh firing of a listener's movement. */
export async function runMovementFiring(
  input: MovementFiringInput,
): Promise<MovementFiringOutcome> {
  return withFiringContext(input, () => runMovementFiringInContext(input));
}

/** A firing refused before it starts (its door is not served by the pin's
 *  version, or a library it imports no longer stands): recorded failed with the
 *  refusal, loudly, and an issue for a live one. */
async function refuseFiring(refused: {
  input: MovementFiringInput;
  recorder: TriggerRunRecorder;
  movementName: string | undefined;
  refusal: string;
  /** What was refused, for the log. */
  because: 'door' | 'library';
}): Promise<MovementFiringOutcome> {
  const { input, recorder, refusal } = refused;
  logger.error(`[MovementEngine] firing refused: ${refused.because === 'door' ? 'the pinned version does not serve its door' : 'a library it imports no longer stands'}`, {
    triggerId: input.triggerId,
    movementId: input.movement.row.id,
    languageVersion: input.movement.version.languageVersion,
    door: input.door.kind,
    refusal,
  });
  if (!input.dryRun) {
    await recordMovementFailureIssue({
      teamId: input.teamId as unknown as string,
      movementId: input.movement.row.id,
      movementName: input.movement.row.name,
      triggerName: input.triggerName,
      runId: recorder.triggerRunId as unknown as string,
      message: refusal,
    }).catch((issueErr) =>
      logger.warn('[MovementEngine] failed to record failure issue', {
        error: issueErr instanceof Error ? issueErr.message : String(issueErr),
      }),
    );
  }
  recorder.recordStepFailure({
    tgId: `movement:${input.movement.row.id}`,
    tgName: refused.movementName ?? input.movement.row.name,
    sourceAdapterType: input.event.adapterType,
    message: refusal,
  });
  await recorder.finish();
  return { result: null, error: refusal };
}

async function runMovementFiringInContext(
  input: MovementFiringInput,
): Promise<MovementFiringOutcome> {
  const recorder = new TriggerRunRecorder({
    teamId: input.teamId,
    triggerId: input.triggerId,
    triggerName: input.triggerName,
    triggerType: input.recordingTriggerType,
    triggerEvent: input.event,
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    // Pin the version the run executes (P11): the shipped one it runs.
    movementVersionId: input.movement.version.id,
    ...(input.existingRunId !== undefined ? { existingRunId: input.existingRunId } : {}),
    ...(input.triggerEventId !== undefined ? { triggerEventId: input.triggerEventId } : {}),
  });
  await recorder.startOpsRun();
  const movementName = input.firedMovementName ?? firedMovementNameFromTriggerName(input.triggerName);
  // The door asks the pin's version for what it needs before anything else.
  // A version without it refuses, recorded as the firing's failure: nothing
  // runs on any engine.
  const refusal = doorRefusal(input.movement.version.languageVersion, input.door);
  if (refusal !== undefined) return refuseFiring({ input, recorder, movementName, refusal, because: 'door' });
  // Made once, here: a run that has started keeps the connections it began
  // with, so resuming one never asks again.
  const libraryLost = await libraryRefusal({ teamId: input.teamId, source: input.movement.version.source });
  if (libraryLost !== undefined) return refuseFiring({ input, recorder, movementName, refusal: libraryLost, because: 'library' });
  // The cooperative cancel gate (runs-and-cancel spec §cancel): reads
  // trigger_run.cancel_requested_at (debounced) so a user-requested cancel stops
  // the run at the next statement / LLM-call boundary. Fail-open — a read fault
  // reads as not-cancelled, so it never stops a healthy run.
  // The run's lease, for the life of the firing: a wake for a branch this
  // firing has already parked must not resume the run while its other
  // branches are still running here. The wake retries once the firing ends.
  let lease: HeldRunLease | null = null;
  const cancelGate = makeDbCancelGate(recorder.triggerRunId, {
    lease: { isLost: () => lease?.isLost() ?? false },
  });
  // The run's trace, held here so the recorder can publish it WHILE the run is
  // going. Without this the trace reached the row only at settle, so the one
  // run anybody needs to inspect — the slow one — was the one showing nothing.
  const trace: MovementTraceEntry[] = [];
  try {
    if (!input.dryRun) {
      // A non-parking firing used to create no row at all until it settled, so
      // there was nothing to inspect and nothing for a restart sweep to find.
      // The row now exists as `running` for the life of the firing.
      await recorder.ensureStarted();
      lease = await takeRunLease(recorder.triggerRunId);
      if (lease !== null) recorder.holdLease(lease);
      if (lease === null) {
        // A fresh run nobody else can know of: only a duplicate firing of
        // one pre-minted run id lands here. It fails, recorded as such.
        throw new Error(`run ${recorder.triggerRunId} could not take its run lease: another instance holds it`);
      }
      recorder.beginLiveTrace(trace);
    }
    const runFiring = () =>
      interpretMovementFiring({
        teamId: input.teamId,
        version: input.movement.version,
        door: input.door,
        ...(movementName !== undefined ? { movementName } : {}),
        event: engineEvent(input),
        firedAt: recorder.firedAt,
        triggerRunId: recorder.triggerRunId,
        ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        // A live firing can park at an `ask`; a dry run never does (test runs
        // don't create durable interactions). The park rows are written + the
        // run flipped to `parked` through this same recorder.
        ...(input.dryRun ? {} : { parksInto: recorder }),
        ...(lease !== null ? { lease } : {}),
        cancelGate,
        trace,
        ...(input.triggerMark !== undefined ? { triggerMark: input.triggerMark } : {}),
      });
    // The host bills its own model and plugin calls; this context is for what
    // it does not reach through those — the catalog assembly and any model
    // call an adapter makes itself.
    const result = await new LlmUsageContext({
      teamId: input.teamId as unknown as string,
      triggerRunId: recorder.triggerRunId as unknown as string,
      cancelGate,
    }).runAsync(runFiring);
    const lostBeforeSettle = leaseLostBeforeSettle(lease, {
      runId: recorder.triggerRunId,
      movementId: input.movement.row.id,
    });
    if (lostBeforeSettle !== null) return noteLostFirstFiring(recorder.triggerRunId, lostBeforeSettle);
    if (result.cancelled) {
      // The user cancelled the run: the engine stopped at a statement / LLM-call
      // boundary (never mid-write, P14). Settle it `failed` + cancel its open
      // asks — do NOT finish() (that would overwrite `failed` with a terminal
      // success/partial, exactly as a parked outcome must skip finish()). Earlier
      // writes stand and still re-dispatch their mutation events — so they go
      // onto the step channel first, or the run settles `failed` claiming it
      // wrote nothing while the records sit in the external systems.
      recorder.recordMovementStep({
        movementId: input.movement.row.id,
        movementName: result.movementName,
        sourceAdapterType: input.event.adapterType,
        result,
      });
      await recorder.snapshotSteps();
      await failRunAndCancelRequests({
        runId: recorder.triggerRunId,
        message: cancelGate.reason() ?? 'Cancelled by an operator',
      }).catch((err) =>
        logger.warn('[MovementEngine] cancel settle failed', {
          runId: recorder.triggerRunId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return { result };
    }
    if (result.parked) {
      // The run is parked (the sink already wrote interaction_request +
      // parked_run and marked trigger_run `parked`). Do NOT finish() — that
      // would overwrite the live `parked` row with a terminal status. The run
      // resumes when the answer arrives (a later chunk).
      // The pre-park writes are already in the external systems, so they belong
      // on the firing record NOW: snapshot them onto the run's append-only step
      // channel. The resuming recorder appends its own segment rather than
      // replacing this one.
      recorder.recordMovementStep({
        movementId: input.movement.row.id,
        movementName: result.movementName,
        sourceAdapterType: input.event.adapterType,
        result,
      });
      await recorder.snapshotSteps();
      return { result };
    }
    recorder.recordMovementStep({
      movementId: input.movement.row.id,
      movementName: result.movementName,
      sourceAdapterType: input.event.adapterType,
      result,
    });
    await recorder.finish();
    if (!input.dryRun) {
      await refreshValidityOnContradiction({
        teamId: input.teamId,
        movement: { id: input.movement.row.id, source: input.movement.version.source },
        outcome: 'success',
      });
      // A clean live run closes the movement's open issues (the quiet half
      // of the surprise-success path).
      await resolveMovementIssues({ movementId: input.movement.row.id }).catch(() => {});
    }
    return { result };
  } catch (err) {
    const context = { runId: recorder.triggerRunId, movementId: input.movement.row.id };
    const lost = leaseLostOutcome(err, context) ?? leaseLostBeforeSettle(lease, context);
    if (lost !== null) return noteLostFirstFiring(recorder.triggerRunId, lost);
    const { error, partial } = unwrapRunFailure(err);
    const message = describeRunFailure(error);
    logger.error('[MovementEngine] movement firing failed', {
      triggerId: input.triggerId,
      movementId: input.movement.row.id,
      error: message,
    });
    // A live failure lands in its Sentry-shaped ISSUE (one row per
    // fingerprint) — alerts fire on new/regression/threshold transitions,
    // never per occurrence (layer 2; replaces the old per-failure ping).
    // Test runs (dryRun) are the user experimenting; they stay quiet.
    if (!input.dryRun) {
      await recordMovementFailureIssue({
        teamId: input.teamId as unknown as string,
        movementId: input.movement.row.id,
        movementName: input.movement.row.name,
        triggerName: input.triggerName,
        runId: recorder.triggerRunId as unknown as string,
        message,
      }).catch((issueErr) =>
        logger.warn('[MovementEngine] failed to record failure issue', {
          error: issueErr instanceof Error ? issueErr.message : String(issueErr),
        }),
      );
    }
    recorder.recordStepFailure({
      tgId: `movement:${input.movement.row.id}`,
      tgName: movementName ?? input.movement.row.name,
      sourceAdapterType: input.event.adapterType,
      message,
      ...(partial !== undefined ? { partial } : {}),
    });
    await recorder.finish();
    if (!input.dryRun) {
      await refreshValidityOnContradiction({
        teamId: input.teamId,
        movement: { id: input.movement.row.id, source: input.movement.version.source },
        outcome: 'failure',
      });
    }
    return { result: null, error: message };
  } finally {
    // Belt and braces: `finish()` and `snapshotSteps()` each stop it, but a
    // path that reaches neither must not leave a timer republishing the trace
    // of a firing that is over.
    recorder.endLiveTrace();
    await lease?.release();
  }
}

// ── Entry point (b): resume a parked run (async user interaction §4.7) ───────

/**
 * Resume one parked movement run forward from its parked `ask` leaf. The
 * source is the PINNED version (`pinnedSource` — re-parsed so the AST and every
 * lexical address are byte-identical, P11), NOT the live movement row. The
 * recorder ADOPTS the existing `trigger_run` id so settling UPSERTS that row to
 * its terminal status + records the post-resume movement step (nodes_written
 * reflects the post-ask writes — the deferred step-recording, chunk 3.1 → here).
 *
 * Settle (§5.4): completed → record step + `finish()` (`success`); re-parked
 * deeper → leave the run parked (a new park row was written by the resumed
 * interpreter); an engine `ERROR`/throw → record the failure + `finish()`
 * (`failed`) — the caller cancels the run's open requests (P14: prior writes
 * stand).
 */
type ResumeFiringInput = {
  teamId: TeamId;
  triggerId: string;
  triggerName: string;
  /** The movement this listener fires (`trigger.fired_movement_name`) — picks
   *  the movement in a multi-movement file; falls back to the name convention. */
  firedMovementName?: string;
  /** The pinned version's source (P11) — what resume re-parses + executes. */
  pinnedSource: string;
  /** The pinned version's language version — the one the run STARTED under,
   *  never the movement's pin now (an upgrade may have moved it
   *  while the run was parked). */
  pinnedLanguageVersion: LanguageVersion;
  movementVersionId: string | null;
  /** The parked run's id — the recorder adopts it so the resume settles the
   *  same row. */
  runId: TriggerRunId;
  movementId: string;
  event: TriggerEvent;
  recordingTriggerType: TriggerRunTriggerType;
  /** The parked leaf's serialised scope (`parked_run.state`), as this release
   *  reads it. */
  state?: AnyParkedScopeState;
  /** The version whose own engine steps the run, and the event in its shape;
   *  absent when this release's engines do. */
  carried?: { lane: ResumingLane; event: CarriedEvent };
  /** The parked leaf's scope under `carried`: that version's, unread here. */
  carriedState?: unknown;
  /** The validated answer to bind as the ask's result. Absent under `reenter`
   *  (an await / recurring-timer resume re-enters at its statement, binding
   *  nothing). */
  answer?: unknown;
  /**
   * Re-enter AT the parked statement (§4.4) rather than stepping past an ask.
   * The await-resume driver passes `true`: the parked statement must be
   * re-evaluated against live data. Defaults to the ask behaviour (false).
   */
  reenter?: boolean;
  /** The leaf this segment re-entered (its address): a note its awaits make
   *  is kept with the segment's progress past it. */
  resumedLeaf?: string;
  /**
   * Multi-leaf settle decision (fan-out / parallel, §5.4). After the engine
   * completes a branch (no re-park, no error), this decides whether the RUN as a
   * whole is now complete: it decrements the leaf's enclosing join's
   * pending-count and reports whether the run still has open siblings. Returns
   * `runComplete: false` ⇒ the leaf finished but the join is still pending →
   * record the step but KEEP the run `parked`. Returns `runComplete: true` ⇒ this
   * was the last open branch → finalise the run `success`. Absent ⇒ the
   * single-ask path (the engine completing IS the run completing — finalise).
   */
  settleBranchComplete?: () => Promise<{ runComplete: boolean }>;
  /** Batch mode (asks-as-adapter chunk C, F18/F21): defer race settlement so the
   *  worker settles once post-batch with all winners. */
  deferRaceSettlement?: boolean;
  /** Post-batch race settlement: when set, this firing SETTLES the named race
   *  frame (build receipt from all winners, cancel losers, run the continuation)
   *  instead of resuming a parked leaf. `state` is any completed branch's state. */
  settleRaceFrameAddress?: string;
  /** The run lease the driver steps this segment under: lost, the segment
   *  stops at its next statement. */
  lease?: HeldRunLease;
};

/** One segment of a parked run on this release's engines. */
async function resumeOnThisRelease(
  input: ResumeFiringInput,
  context: { recorder: TriggerRunRecorder; movementName: string | undefined; cancelGate: DbCancelGate },
): Promise<MovementRunResult> {
  const { recorder, movementName, cancelGate } = context;
  const languageVersion = input.pinnedLanguageVersion;
  refuseHeldRun(languageVersion, 'resume');
  if (input.state === undefined) throw new Error(`run ${input.runId} is resumed on this release with no park state`);
  const teamCatalog = await runCatalogSnapshotForTeam(input.teamId, {
    source: input.pinnedSource,
    languageVersion,
    imports: 'shipped',
    audience: { for: 'run' },
  });
  const commonInput = {
    source: input.pinnedSource,
    languageVersion,
    ...(movementName !== undefined ? { movementName } : {}),
    event: engineEvent(input),
    teamId: tenantOfTeam(input.teamId),
    // The ORIGINAL firing's instant, read back off the run row by
    // `adoptOpsRun()` above: a run that waited a day on an answer still
    // computes the window it started with.
    firedAt: recorder.firedAt.toISOString(),
    // What the run spent before it parked, read back with its clock: the
    // cost cap is the run's, not the segment's — counted from the run's last
    // resume from a limit pause, which reset its usage. The cap is read
    // afresh: a run resumed after ops raised it meets the new one.
    costCapMicrodollars: runCostCapFromEnv(),
    priorSpentMicrodollars: recorder.priorSpentMicrodollars,
    capBaselineMicrodollars: recorder.capBaselineMicrodollars,
    // A run paused at its cost limit stays paused: a branch woken by its own
    // event takes it, then suspends before its next statement.
    limitPaused: recorder.limitPaused,
    // The engine that parked it, read back with the rest: the resume goes
    // back to it (`engineRoute`), whatever the emergency switch says now.
    ...(recorder.parkedOnEngine !== undefined ? { parkedOnEngine: recorder.parkedOnEngine } : {}),
    catalog: teamCatalog.snapshot,
    credentialIds: teamCatalog.credentialIds,
    runId: input.runId,
    // A resumed run can re-park at a deeper ask — it gets live parks too.
    host: productionEngineHost({
      teamId: input.teamId,
      triggerRunId: input.runId,
      parksInto: recorder,
      ...(input.lease !== undefined ? { lease: input.lease } : {}),
      ...(input.resumedLeaf !== undefined ? { resumedLeaf: input.resumedLeaf } : {}),
      cancel: cancelGate,
    }),
    state: input.state,
  };
  return input.settleRaceFrameAddress !== undefined
    ? settleRaceFrame({ ...commonInput, frameAddress: input.settleRaceFrameAddress })
    : resumeMovement({
        ...commonInput,
        ...(input.answer !== undefined ? { answer: input.answer } : {}),
        ...(input.reenter !== undefined ? { reenter: input.reenter } : {}),
        ...(input.deferRaceSettlement !== undefined ? { deferRaceSettlement: input.deferRaceSettlement } : {}),
      });
}

/** A parked run stepping forward: an ask answered, an await settled, a timer
 *  woken, or a race frame settling its winners. */
export async function resumeMovementFiring(
  input: ResumeFiringInput,
): Promise<MovementFiringOutcome> {
  return withFiringContext(input, () => resumeMovementFiringInContext(input));
}

async function resumeMovementFiringInContext(
  input: ResumeFiringInput,
): Promise<MovementFiringOutcome> {
  const recorder = new TriggerRunRecorder({
    teamId: input.teamId,
    triggerId: input.triggerId,
    triggerType: input.recordingTriggerType,
    triggerEvent: input.event,
    movementVersionId: input.movementVersionId,
    existingRunId: input.runId,
  });
  if (input.lease !== undefined) recorder.holdLease(input.lease);
  const leaseContext = { runId: input.runId, movementId: input.movementId };
  // Take back the ops feed run the parked firing opened, so finishing here
  // CLOSES it. Without this the recorder's `opsRunId` is null for the whole
  // resumed run and the event stays `running` after the user has answered.
  await recorder.adoptOpsRun();
  const movementName = input.firedMovementName ?? firedMovementNameFromTriggerName(input.triggerName);
  // A resumed run is cancellable too — same cooperative gate, keyed to the
  // adopted run id (runs-and-cancel spec §cancel) — and stops if the run lease
  // its driver holds is lost.
  const cancelGate = makeDbCancelGate(recorder.triggerRunId, {
    ...(input.lease !== undefined ? { lease: input.lease } : {}),
  });
  try {
    const languageVersion = input.pinnedLanguageVersion;
    const { carried } = input;
    const resumeFiring = carried !== undefined
      ? () =>
          resumeCarriedSegment({
            lane: carried.lane,
            teamId: input.teamId,
            triggerRunId: input.runId,
            cancel: cancelGate,
            ...(input.lease !== undefined ? { lease: input.lease } : {}),
            park: carriedParksOf(recorder, {
              ...(input.lease !== undefined ? { lease: input.lease } : {}),
              ...(input.resumedLeaf !== undefined ? { resumedLeaf: input.resumedLeaf } : {}),
            }),
            request: {
              source: input.pinnedSource,
              pin: languageVersion,
              ...(movementName !== undefined ? { movementName } : {}),
              event: carried.event,
              teamId: input.teamId,
              firedAt: recorder.firedAt.toISOString(),
              runId: input.runId,
              costCapMicrodollars: runCostCapFromEnv(),
              priorSpentMicrodollars: recorder.priorSpentMicrodollars,
              capBaselineMicrodollars: recorder.capBaselineMicrodollars,
              limitPaused: recorder.limitPaused,
              ...(recorder.parkedOnEngine !== undefined ? { parkedOnEngine: recorder.parkedOnEngine } : {}),
              state: input.carriedState ?? input.state,
              ...(input.answer !== undefined ? { answer: input.answer } : {}),
              ...(input.reenter !== undefined ? { reenter: input.reenter } : {}),
              ...(input.deferRaceSettlement !== undefined ? { deferRaceSettlement: input.deferRaceSettlement } : {}),
              ...(input.settleRaceFrameAddress !== undefined ? { settleRaceFrameAddress: input.settleRaceFrameAddress } : {}),
            },
          })
      : () => resumeOnThisRelease(input, { recorder, movementName, cancelGate });
    const result = await new LlmUsageContext({
      teamId: input.teamId as unknown as string,
      triggerRunId: input.runId as unknown as string,
      cancelGate,
    }).runAsync(resumeFiring);
    const lostBeforeSettle = leaseLostBeforeSettle(input.lease, leaseContext);
    if (lostBeforeSettle !== null) return lostBeforeSettle;
    if (result.cancelled) {
      // Cancelled mid-resume: skip finish()/markParked() (mirrors the
      // parked/re-park early return). Earlier writes stand (P14) — this
      // segment's go onto the step channel, appending to whatever the park
      // left there, before the drain that stepped it settles the run failed
      // with the reason.
      recorder.recordMovementStep({
        movementId: input.movementId,
        movementName: result.movementName,
        sourceAdapterType: input.event.adapterType,
        result,
      });
      await recorder.snapshotSteps();
      const reason = cancelGate.reason();
      return { result, ...(reason != null ? { cancelReason: reason } : {}) };
    }
    if (result.parked) {
      // Re-parked at a deeper ask — the new park rows + `parked` status were
      // written by the sink. Do NOT finish (it resumes again on its answer).
      // This segment's writes go onto the step channel now, same as the first
      // park's: a re-parking resume is not a run that wrote nothing.
      recorder.recordMovementStep({
        movementId: input.movementId,
        movementName: result.movementName,
        sourceAdapterType: input.event.adapterType,
        result,
      });
      await recorder.snapshotSteps();
      return { result };
    }
    // The branch completed. In a fan-out / parallel, completing ONE branch does
    // not complete the run — `settleBranchComplete` decrements the join and tells
    // us whether siblings remain. The step is recorded either way (its writes
    // belong on the firing record); the run is only FINALISED when the last
    // branch closes (§5.4).
    recorder.recordMovementStep({
      movementId: input.movementId,
      movementName: result.movementName,
      sourceAdapterType: input.event.adapterType,
      result,
    });
    const settle = input.settleBranchComplete
      ? await input.settleBranchComplete()
      : { runComplete: true };
    // The quiescence read took a round trip: look again before settling.
    const lostAtSettle = leaseLostBeforeSettle(input.lease, leaseContext);
    if (lostAtSettle !== null) return lostAtSettle;
    if (settle.runComplete) {
      await recorder.finish();
      // Prediction-rule hook on the resume's terminal success. The executed
      // source is the PINNED version's — the version-match guard inside skips
      // the re-check when the live source has moved on. Parked runs are always
      // live (dry runs never park), so no dryRun gate here.
      await refreshValidityOnContradiction({
        teamId: input.teamId,
        movement: { id: input.movementId, source: input.pinnedSource },
        outcome: 'success',
      });
      await resolveMovementIssues({ movementId: input.movementId }).catch(() => {});
    } else {
      // The branch finished but the join is still pending — persist what this
      // resume wrote (the step channel appends, so a sibling settling at the
      // same moment can't swallow it), but keep the run observably `parked`
      // (other siblings open).
      await recorder.snapshotSteps();
      await recorder.markParked();
    }
    return { result };
  } catch (err) {
    const lost = leaseLostOutcome(err, leaseContext) ?? leaseLostBeforeSettle(input.lease, leaseContext);
    if (lost !== null) return lost;
    const { error, partial } = unwrapRunFailure(err);
    const message = describeRunFailure(error);
    logger.error('[MovementEngine] resume firing failed', {
      triggerId: input.triggerId,
      movementId: input.movementId,
      runId: input.runId,
      error: message,
    });
    recorder.recordStepFailure({
      tgId: `movement:${input.movementId}`,
      tgName: movementName ?? input.movementId,
      sourceAdapterType: input.event.adapterType,
      message,
      ...(partial !== undefined ? { partial } : {}),
    });
    await recorder.finish();
    await refreshValidityOnContradiction({
      teamId: input.teamId,
      movement: { id: input.movementId, source: input.pinnedSource },
      outcome: 'failure',
    });
    await recordMovementFailureIssue({
      teamId: input.teamId as unknown as string,
      movementId: input.movementId,
      movementName: movementName ?? input.movementId,
      triggerName: input.triggerName,
      runId: input.runId as unknown as string,
      message,
    }).catch(() => {});
    return { result: null, error: message };
  }
}

/**
 * Run a fired callback's body as a SEGMENT of its owning run, on the engine of
 * the version that minted it (`callback(…)` was retired in 0.13, so it is always
 * a carried one). The run's team, billing and step ledger; no new run identity.
 *
 * It does not settle the run: the main continuation is parked and wakes through
 * its own mechanism. A body that throws fails the SEGMENT and stops there: a
 * failed side entry must not kill the primary await.
 */
export async function fireCallbackFiring(input: {
  teamId: TeamId;
  triggerId: string;
  triggerName: string;
  firedMovementName?: string;
  pinnedSource: string;
  pinnedLanguageVersion: LanguageVersion;
  movementVersionId: string | null;
  runId: TriggerRunId;
  movementId: string;
  event: TriggerEvent;
  recordingTriggerType: TriggerRunTriggerType;
  carried: { lane: ResumingLane; event: CarriedEvent };
  /** The callback's captured closure: the minting version's, unread here. */
  state: unknown;
  values: Record<string, unknown>;
  callIndex: number;
  lease?: HeldRunLease;
}): Promise<MovementFiringOutcome> {
  return withFiringContext(input, async () => {
    const recorder = new TriggerRunRecorder({
      teamId: input.teamId,
      triggerId: input.triggerId,
      triggerType: input.recordingTriggerType,
      triggerEvent: input.event,
      movementVersionId: input.movementVersionId,
      existingRunId: input.runId,
    });
    if (input.lease !== undefined) recorder.holdLease(input.lease);
    const leaseContext = { runId: input.runId, movementId: input.movementId };
    await recorder.adoptOpsRun();
    const movementName = input.firedMovementName ?? firedMovementNameFromTriggerName(input.triggerName);
    const cancelGate = makeDbCancelGate(recorder.triggerRunId, {
      ...(input.lease !== undefined ? { lease: input.lease } : {}),
    });
    try {
      const fire = () =>
        resumeCarriedSegment({
          lane: input.carried.lane,
          teamId: input.teamId,
          triggerRunId: input.runId,
          cancel: cancelGate,
          ...(input.lease !== undefined ? { lease: input.lease } : {}),
          park: carriedParksOf(recorder, input.lease !== undefined ? { lease: input.lease } : {}),
          request: {
            source: input.pinnedSource,
            pin: input.pinnedLanguageVersion,
            ...(movementName !== undefined ? { movementName } : {}),
            event: input.carried.event,
            teamId: input.teamId,
            // A body belongs to the run that minted it, clock included.
            firedAt: recorder.firedAt.toISOString(),
            runId: input.runId,
            costCapMicrodollars: runCostCapFromEnv(),
            priorSpentMicrodollars: recorder.priorSpentMicrodollars,
            capBaselineMicrodollars: recorder.capBaselineMicrodollars,
            ...(recorder.parkedOnEngine !== undefined ? { parkedOnEngine: recorder.parkedOnEngine } : {}),
            state: input.state,
            callback: { values: input.values, callIndex: input.callIndex },
          },
        });
      const result = await new LlmUsageContext({
        teamId: input.teamId as unknown as string,
        triggerRunId: input.runId as unknown as string,
        cancelGate,
      }).runAsync(fire);
      const lostBeforeSettle = leaseLostBeforeSettle(input.lease, leaseContext);
      if (lostBeforeSettle !== null) return lostBeforeSettle;
      recorder.recordMovementStep({
        movementId: input.movementId,
        movementName: result.movementName,
        sourceAdapterType: input.event.adapterType,
        result,
      });
      await recorder.snapshotSteps();
      return { result };
    } catch (err) {
      const lost = leaseLostOutcome(err, leaseContext) ?? leaseLostBeforeSettle(input.lease, leaseContext);
      if (lost !== null) return lost;
      const { error, partial } = unwrapRunFailure(err);
      const message = describeRunFailure(error);
      logger.error('[MovementEngine] callback body failed', { triggerId: input.triggerId, movementId: input.movementId, runId: input.runId, error: message });
      // The SEGMENT fails; the run does not.
      recorder.recordStepFailure({
        tgId: `movement:${input.movementId}`,
        tgName: movementName ?? input.movementId,
        sourceAdapterType: input.event.adapterType,
        message,
        ...(partial !== undefined ? { partial } : {}),
      });
      await recorder.snapshotSteps();
      return { result: null, error: message };
    }
  });
}

/** Legacy fallback: recover the fired movement from the old name convention
 *  (`movement/<file>/<movement>`) for rows provisioned before
 *  `fired_movement_name` existed and not yet re-saved. A `listen as "…"`
 *  alias has no movement in its name, so this returns undefined there — the
 *  reason the column is now the source of truth. Undefined ⇒ `runMovement`
 *  requires the file to declare exactly one movement. */
function firedMovementNameFromTriggerName(triggerName: string): string | undefined {
  const parts = triggerName.split('/');
  return parts.length >= 3 ? parts[parts.length - 1] : undefined;
}

/** A movement as it fires: its row (identity, name, validity) and the text it
 *  shipped. */
export interface ShippedMovement {
  row: MovementRow;
  version: ShippedVersion;
}

/** The current version of a movement: what a fresh firing runs and pins. */
export interface ShippedVersion {
  id: string;
  source: string;
  languageVersion: LanguageVersion;
}

/**
 * What a movement-derived trigger fires: the movement's shipped version.
 * `missing` = the row is gone (the FK clears `trigger.movement_id` on delete,
 * so this is a narrow race); `not_shipped` = no save of it ever shipped, so
 * there is nothing to run. The provisioner derives listeners only on a
 * shipped save, so a listener over an unshipped movement is a row from before
 * versioning.
 */
export async function shippedMovementForTrigger(input: {
  teamId: TeamId;
  movementId: string;
}): Promise<{ kind: 'shipped'; movement: ShippedMovement } | { kind: 'missing' } | { kind: 'not_shipped' }> {
  const row = await movementForTrigger(input);
  if (row === null) return { kind: 'missing' };
  if (row.currentVersionId === null) return { kind: 'not_shipped' };
  const version = await loadPinnedVersion(row.currentVersionId);
  // The pointer is a foreign key, so a version it names exists.
  if (version === null) return { kind: 'not_shipped' };
  return { kind: 'shipped', movement: { row, version: { id: row.currentVersionId, ...version } } };
}

/**
 * Load the movement row a movement-derived trigger fires. Null = the row
 * is gone (the FK clears `trigger.movement_id` on delete, so this is a
 * narrow race) — the caller reports it rather than dispatching nothing.
 */
export async function movementForTrigger(input: {
  teamId: TeamId;
  movementId: string;
}): Promise<MovementRow | null> {
  return getMovementRow({
    teamId: input.teamId as unknown as string,
    id: input.movementId,
  });
}
