// "Run now" — inject an invocation event on a movement's MANUAL channel.
//
// Manual runs collapsed into an adapter (3_syntax_sketch.md "Composition,
// time, queries, failure"): a movement is runnable on demand when the
// SAVED source declares a manual-channel listener —
//
//   go = manual()
//   listen to go {} fire backfill
//
// Saving derives an ordinary `automations.trigger` row from that listen
// (kind 'manual'), and this module fires it by building a manual
// invocation event — carrying the initiating member, so `@user_*` /
// `@actor_*` resolve to whoever pressed the button — and dispatching it
// through `dispatchTriggerByIdEvent`, exactly like any inbound event:
// uniform run_mode gating (off = paused, dry_run = rehearse), uniform
// trigger_run recording, uniform emitted-event re-dispatch. There is no
// separate execution path for on-demand runs.
//
// An invocation OPTIONALLY carries text and/or files — the input a person
// types or drops into the movement when they run it. This is the single
// on-demand entry: callers either name the MOVEMENT (we discover its manual
// listener's derived trigger) or the TRIGGER directly. Files' bytes are
// streamed into document storage (`services.document.upload`); the returned
// `objectUri` rides on the payload as the file's owner-resolvable byte handle,
// which the manual adapter redeems via `resolveFileRef`.
//
// one on-demand invocation service
// owner-resolvable FileRef handles

import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import { MovementParseError } from 'movement-lang';
import { parseProgram } from 'legacy-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { teamDocumentKeyPrefix } from 'movement-engine/public/files';
import { services } from '../../../adapters/registry';
import { getQb, getAutomationsQb } from '../../../lib/kysely';
import { costMicrodollarsToUsd, runCostSummaries } from '../../../lib/llm_usage';
import { describeLimitPause, readLimitPause } from '../../movement_engine/limit_pause';
import { handleError } from '../../../lib/errors';
import { logger } from 'movement-engine/public/log';
import { flattenTriggerRunPlans, parseTriggerRunSteps } from '../runs/trigger_run_read';
import { dispatchTriggerByIdEvent } from '../triggers/router';
import { describeDroppedReason } from '../triggers/dropped_reason';
import { queueRun } from '../triggers/dispatch_event';
import { reportedFailureReason } from '../runs/trigger_run';
import { movementForTrigger } from './execute';
import { loadTriggerById } from '../storage/tg_table';
import {
  MANUAL_ADAPTER_TYPE,
  type ManualFile,
  type ManualInvocationPayload,
} from '../adapters/manual';
import { resolveAdapterSlug } from '../adapters/registry';
import { manualListenerMovements } from './files';
import { getMovementRow } from './store';
import { listDerivedTriggerRows } from './store';
import {
  describeRunAwaits,
  type AwaitDescription,
} from '../../movement_engine/await_description';
import { callbackUrl, listRunCallbacks } from '../../movement_engine/callback_store';
import { isWriteEffect } from 'movement-engine/public/trace';
import {
  describeExecutedVersion,
  type ExecutedMovementVersion,
} from './version_store';

export interface MovementRunNowSuccess {
  ok: true;
  /** The movement the manual listener fires. */
  movementName: string;
  /** Writes were captured, not committed (the listener rehearses). */
  dryRun: boolean;
  /** Writes the run applied — the "records processed" count. */
  recordCount: number;
  /** Per-node evaluation errors surfaced by the engine; empty on a clean run. */
  errors: { nodeId: string | null; message: string }[];
}

export interface MovementRunNowFailure {
  ok: false;
  errors: string[];
}

export type MovementRunNowResult = MovementRunNowSuccess | MovementRunNowFailure;

/** One file supplied to a Run-now — its bytes (base64) plus metadata. The
 *  service streams the bytes into document storage and records the resulting
 *  `objectUri` on the invocation payload. */
export interface RunMovementFileInput {
  filename: string;
  contentType: string;
  /** Base64-encoded file bytes. */
  contentBase64: string;
}

export interface RunMovementNowInput {
  /** Team scope — matches the movement / trigger's team. */
  teamId: string;
  /** Name the MOVEMENT: discover its manual listener's derived trigger row.
   *  Exactly one of `movementId` / `triggerId`. */
  movementId?: string;
  /** Name the TRIGGER directly (the legacy trigger-keyed submit entry).
   *  Exactly one of `movementId` / `triggerId`. */
  triggerId?: string;
  /** Free-form text supplied when running the movement (optional). */
  text?: string;
  /** Files supplied when running the movement (optional). */
  files?: RunMovementFileInput[];
  /** The member who pressed Run now — rides the event payload, feeding
   *  `@user_*` / `@actor_*` resolution and the run's actor attribution. */
  actor?: { email?: string; name?: string };
  /** The caller's id for this request. A retry carrying the same id is the
   *  same run, not a second one (the receipt's delivery id). */
  requestId?: string;
}

const NO_MANUAL_LISTENER_FIX =
  'declare a manual channel and save first — `go = manual()` + `listen to go {} fire <movement>`; "Run now" injects an event on that channel';

/**
 * Run a movement's manual channel once, now, IN THIS PROCESS — the dev CLI's
 * entry. Every request door queues instead (`runMovementAsync`), so no
 * movement runs inside a request. The single on-demand invocation
 * entry: the caller either names the MOVEMENT (we discover the manual
 * listener's derived trigger from its SAVED source) or names the TRIGGER
 * directly. Either way one `ManualInvocationPayload` — optionally carrying
 * text + files — is injected through NORMAL dispatch (`dispatchTriggerByIdEvent`).
 */
export async function runMovementNow(
  input: RunMovementNowInput,
): Promise<MovementRunNowResult> {
  const triggerId = await resolveManualTrigger(input);
  if (typeof triggerId !== 'string') return triggerId;

  const event = await buildManualInvocationEvent({ triggerId, input });

  const outcome = await dispatchTriggerByIdEvent({
    triggerId,
    event,
    teamId: input.teamId as TeamId,
  });
  if (outcome.droppedReason !== undefined) {
    return { ok: false, errors: [describeDroppedReason(outcome.droppedReason)] };
  }
  if (outcome.errors !== undefined && outcome.errors.length > 0) {
    return { ok: false, errors: outcome.errors.map((e) => e.message) };
  }
  const firing = outcome.movementFirings?.[0];
  if (!firing) {
    return { ok: false, errors: ['dispatch produced no firing'] };
  }
  return {
    ok: true,
    movementName: firing.movementName,
    dryRun: firing.dryRun,
    recordCount: firing.writes,
    errors: [],
  };
}

// ── Queued run (every on-demand door) ───────────────────────────────────────
//
// A non-trivial movement run (extraction + writes) outlasts any request: the
// MCP tool-call limit, a browser's patience, and a deployment that stops the
// api between requests. `runMovementAsync` resolves the manual trigger, builds
// the SAME invocation event `runMovementNow` would, and QUEUES it: the receipt,
// a `running` run row and a `dispatch_event` work row are durable before it
// returns the run id. Whichever worker drains next starts the run, adopting
// that id, so the row settles to its terminal status; the caller follows it
// with `getMovementRunStatus(runId)`.

export interface MovementRunAsyncDispatched {
  ok: true;
  runId: string;
  status: 'running';
  movementName: string;
}

export type MovementRunAsyncResult = MovementRunAsyncDispatched | MovementRunNowFailure;

/**
 * Queue a run of a movement's manual channel and return its id at once. Does
 * NOT run it; poll `getMovementRunStatus`. A retried request carrying the same
 * `requestId` gets the first request's run back.
 */
export async function runMovementAsync(
  input: RunMovementNowInput,
): Promise<MovementRunAsyncResult> {
  const triggerId = await resolveManualTrigger(input);
  if (typeof triggerId !== 'string') return triggerId;

  // The firing runs through the movement engine — so the trigger must resolve
  // to a movement row (the run pins its version). Resolve it now so the queued
  // run is faithful and a non-movement trigger is refused before queueing.
  const triggerRow = await loadTriggerById(triggerId);
  if (!triggerRow || triggerRow.movementId === null) {
    return {
      ok: false,
      errors: [`trigger ${triggerId} is not a movement trigger — nothing to run`],
    };
  }
  const movementRow = await movementForTrigger({
    teamId: input.teamId as TeamId,
    movementId: triggerRow.movementId,
  });
  if (!movementRow) {
    return { ok: false, errors: [`movement ${triggerRow.movementId} not found`] };
  }

  const event = await buildManualInvocationEvent({ triggerId, input });
  const { runId } = await queueRun({
    triggerId: triggerId as TriggerId,
    teamId: input.teamId as TeamId,
    event,
    movementVersionId: movementRow.currentVersionId,
  });
  return { ok: true, runId, status: 'running', movementName: movementRow.name };
}

// ── Run status read (the poll target) ───────────────────────────────────────

export interface MovementRunStatus {
  runId: string;
  /** 'running' | 'parked' (waiting on a human ask) | 'success' | 'partial' | 'failed'. */
  status: string;
  /** Total writes the firing applied across its steps. */
  recordCount: number;
  /** The run rehearsed: its writes were captured, not committed. */
  dryRun: boolean;
  /** Per-step errors (terminal aggregate); empty on a clean run. */
  errors: Array<{ tgId?: string; nodeId?: string | null; message: string }>;
  startedAt: string;
  /** Set once the run reaches a terminal SUCCESS/partial state. */
  finishedAt: string | null;
  /** Set once the run FAILED. */
  failedAt: string | null;
  failureReason: string | null;
  /** Model-call cost this run incurred, in USD to 4 decimal places — 0 when
   *  it made no model calls. Rolled up from `llm_usage`. */
  costUsd: number;
  /** How many model calls this run made. */
  modelCalls: number;
  /** Present while the run is PAUSED at its cost limit (status stays
   *  'parked'): why, what it spent against the limit, and the limit. Resume it
   *  with `resumeRun`. */
  paused?: { reason: string; spentUsd: number; capUsd: number; pausedAt: string };
}

/**
 * Read one run's status by id, team-scoped — a caller may only read runs in a
 * team they can access (the `team_id` clause clamps it; a cross-team id is
 * simply not found). The poll target for `runMovementAsync`.
 */
export async function getMovementRunStatus(input: {
  teamId: string;
  runId: string;
}): Promise<MovementRunStatus | { error: string }> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', input.runId as TriggerRunId)
    .where('team_id', '=', input.teamId as TeamId)
    .select([
      'id',
      'status',
      'nodes_written',
      'dry_run',
      'errors',
      'started_at',
      'completed_at',
      'failed_at',
      'failure_reason',
      'limit_pause',
    ])
    .executeTakeFirst();
  if (!row) return { error: `run ${input.runId} not found` };
  const pause = readLimitPause(row.limit_pause);

  const errors = Array.isArray(row.errors)
    ? (row.errors as Array<Record<string, unknown>>).map((e) => ({
        ...(typeof e.tgId === 'string' ? { tgId: e.tgId } : {}),
        ...('nodeId' in e ? { nodeId: (e.nodeId ?? null) as string | null } : {}),
        message: typeof e.message === 'string' ? e.message : String(e.message ?? 'error'),
      }))
    : [];

  const cost = (await runCostSummaries([row.id as unknown as TriggerRunId])).get(
    row.id as unknown as string,
  );

  return {
    runId: row.id as unknown as string,
    status: row.status,
    recordCount: row.nodes_written,
    dryRun: row.dry_run,
    errors,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.completed_at ? row.completed_at.toISOString() : null,
    failedAt: row.failed_at ? row.failed_at.toISOString() : null,
    failureReason: reportedFailureReason(row),
    costUsd: costMicrodollarsToUsd(cost?.costMicrodollars ?? 0),
    modelCalls: cost?.calls ?? 0,
    ...(pause !== null
      ? {
          paused: {
            reason: describeLimitPause(pause),
            spentUsd: costMicrodollarsToUsd(pause.spentMicrodollars),
            capUsd: costMicrodollarsToUsd(pause.capMicrodollars),
            pausedAt: pause.pausedAt,
          },
        }
      : {}),
  };
}

// ── Run listing (discovery) ─────────────────────────────────────────────────

export interface MovementRunSummary {
  runId: string;
  /** The listener whose firing this run records (a movement has one trigger
   *  per `listen` statement) — empty if the trigger has no name. */
  lane: string;
  /** How the run was triggered: webhook | manual | snapshot | mutation | … */
  triggerType: string | null;
  /** running | parked | success | partial | failed. */
  status: string;
  /** How many of this run's writes actually landed in a target system. */
  committed: number;
  /** How many were REHEARSED — captured, not committed (a `dry_run` target,
   *  or a whole-run rehearsal). `committed + captured` = total writes. */
  captured: number;
  /** Total writes the firing applied across its steps (committed + captured). */
  recordCount: number;
  startedAt: string;
  finishedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  /** Model-call cost this run incurred, in USD to 4 decimal places — 0 when
   *  it made no model calls. Rolled up from `llm_usage`. */
  costUsd: number;
  /** How many model calls this run made. */
  modelCalls: number;
}

/**
 * List a movement's recent runs, newest first — the discovery surface that
 * hands an agent the run ids a listener-fired movement never otherwise
 * exposes. Two hops: the movement's triggers (one per `listen`), then their
 * runs, merged across lanes and tagged with the firing trigger's name. Mirrors
 * the web runs list (`movementRunsImpl`) on the MCP surface.
 */
export async function listMovementRuns(input: {
  teamId: string;
  movementId: string;
  limit?: number;
}): Promise<MovementRunSummary[]> {
  const teamId = input.teamId as TeamId;
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  const triggerRows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', teamId)
    .where('movement_id', '=', input.movementId as MovementId)
    .select(['id', 'name'])
    .execute();
  if (triggerRows.length === 0) return [];

  const triggerIds = triggerRows.map((r) => r.id as unknown as TriggerId);
  const laneByTriggerId = new Map(
    triggerRows.map((r) => [r.id as unknown as string, r.name ?? '']),
  );

  const runRows = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('team_id', '=', teamId)
    .where('trigger_id', 'in', triggerIds)
    .select([
      'id',
      'trigger_id',
      'trigger_type',
      'status',
      'nodes_written',
      'dry_run',
      'steps',
      'started_at',
      'completed_at',
      'failed_at',
      'failure_reason',
    ])
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();

  const costByRunId = await runCostSummaries(
    runRows.map((r) => r.id as unknown as TriggerRunId),
  );

  return runRows.map((row) => {
    const { committed, captured } = projectRunWrites(row.steps, row.dry_run);
    const cost = costByRunId.get(row.id as unknown as string);
    return {
      runId: row.id as unknown as string,
      lane: laneByTriggerId.get(row.trigger_id as unknown as string) ?? '',
      triggerType: row.trigger_type,
      status: row.status,
      committed,
      captured,
      recordCount: row.nodes_written,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.completed_at ? row.completed_at.toISOString() : null,
      failedAt: row.failed_at ? row.failed_at.toISOString() : null,
      failureReason: reportedFailureReason(row),
      costUsd: costMicrodollarsToUsd(cost?.costMicrodollars ?? 0),
      modelCalls: cost?.calls ?? 0,
    };
  });
}

// ── Run inspection (the resolved write-plan) ────────────────────────────────

/** One write the firing applied (or rehearsed) — the concrete record landed
 *  in a target system, with the FINAL field values it sent. */
export interface MovementRunWrite {
  /** The movement binding / node this write came from. */
  binding: string;
  /** `${adapter}:${recordType}` — where the record landed. */
  target: string;
  /**
   * What this write did: `create` (record minted), `update` (at least one
   * field sent), `attach` (nothing but the parent association sent — a
   * matched record whose own fields were unchanged), `noop` (nothing sent
   * at all), or `link` / `unlink` / `delete` for the standalone statements.
   * `match` is a record a `match` FOUND: listed so a reader sees what the run
   * resolved to, never written and never counted as a write.
   */
  action: string;
  /** Whether this write actually landed in the target system. False when it
   *  was REHEARSED — the target instance was constructed `dry_run: true`, or
   *  the whole run was a rehearsal — so the effect was captured, not
   *  committed. A live run can still capture a `dry_run` instance's write. */
  committed: boolean;
  externalId?: string;
  /** The edge, for a standalone link/unlink. */
  link?: unknown;
  /** The parent record(s) this write hangs off + the connecting edge —
   *  a linked/tuple write's structural attachment. Absent for root writes. */
  parents?: unknown;
  /** What the TARGET SYSTEM did about those parents: `made` (the record was
   *  not attached and now is) or `already` (it was). Absent for a root write,
   *  and for runs recorded before the systems were asked. `parents` is what
   *  the author wrote; this is what the system did about it. */
  association?: 'made' | 'already';
  /** The resolved field values sent to the adapter (post no-op suppression) —
   *  every `?:` outcome and enum coercion already applied. */
  values: Record<string, unknown>;
  /** Per-field origin (extraction site / prior write) when captured. */
  provenance?: unknown;
}

export interface MovementRunInspection {
  runId: string;
  status: string;
  /** How many of this run's writes actually landed in a target system. */
  committed: number;
  /** How many were REHEARSED — captured, not committed (a `dry_run` target,
   *  or a whole-run rehearsal). `committed + captured` = total writes. */
  captured: number;
  triggerType: string | null;
  startedAt: string;
  finishedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  /** The source event that fired the run — what the movement saw at the door. */
  sourceEvent: unknown;
  /** The saved version this run executed, against the current one — a run
   *  that fired before the last save ran older logic. Null for runs with
   *  no pinned version. */
  executedVersion: ExecutedMovementVersion | null;
  changedFields: string[] | null;
  /** The resolved write-plan: every record the firing wrote, in program order. */
  writes: MovementRunWrite[];
  /** The decision trace: gate outcomes, branch/block positions, extraction
   *  emissions, AI calls, field misses — why the firing wrote what it wrote. */
  trace: unknown[];
  errors: Array<{ tgId?: string; nodeId?: string | null; message: string }>;
  /** Model-call cost this run incurred, in USD to 4 decimal places — 0 when
   *  it made no model calls. Rolled up from `llm_usage`. */
  costUsd: number;
  /** How many model calls this run made. */
  modelCalls: number;
  /** What a PARKED run is waiting on, in plain language — one line per live
   *  await/timer leaf (P22). Empty for a run that is not waiting on anything an
   *  author chose (running / finished / on a spending-limit hold). */
  awaiting: AwaitDescription[];
  /** The deferred invocations this run handed out — a button's payload, a
   *  link's target — with what has been fired at each. A fire is a SEGMENT of
   *  this same run, so its writes are already in `writes`; this is what says
   *  where they came from, and what is still tappable. */
  callbacks: MovementRunCallback[];
}

/** One minted callback, as the inspector shows it. `calls` is the ledger: what
 *  was actually fired, in order. */
export interface MovementRunCallback {
  id: string;
  url: string;
  /** live | fired (a single-use claim) | revoked (the run ended). */
  status: string;
  singleUse: boolean;
  expiresAt: string | null;
  /** The fire-time signature, declaration order. */
  params: Array<{ name: string; type: string }>;
  calls: Array<{ at: string; values: Record<string, unknown> }>;
}

function appliedPlanToWrite(
  plan: Record<string, unknown>,
  fallbackCommitted: boolean,
): MovementRunWrite {
  const created = plan.created === true;
  const kind = typeof plan.kind === 'string' ? plan.kind : undefined;
  const outcome = typeof plan.outcome === 'string' ? plan.outcome : undefined;
  // `kind` (link | unlink | delete | match) IS the action. For a record write the
  // engine states its own outcome — create | update | attach | noop — because
  // `created` alone cannot separate a field update from a parent-only attach
  // from a write that sent nothing. Runs recorded before `outcome` existed
  // fall back to the two-way `created` split.
  const action = kind ?? outcome ?? (created ? 'create' : 'update');
  // The per-write commit truth. Runs recorded before the flag existed lack it;
  // they fall back to the run-level rehearsal flag (the only signal they have).
  const committed = typeof plan.committed === 'boolean' ? plan.committed : fallbackCommitted;
  return {
    binding: typeof plan.nodeId === 'string' ? plan.nodeId : '',
    target: `${String(plan.adapterType ?? '')}:${String(plan.recordType ?? '')}`,
    action,
    committed,
    ...(typeof plan.externalId === 'string' ? { externalId: plan.externalId } : {}),
    ...(plan.link !== undefined ? { link: plan.link } : {}),
    ...(Array.isArray(plan.parents) && plan.parents.length > 0 ? { parents: plan.parents } : {}),
    ...(plan.association === 'made' || plan.association === 'already'
      ? { association: plan.association }
      : {}),
    values:
      plan.writtenValues && typeof plan.writtenValues === 'object'
        ? (plan.writtenValues as Record<string, unknown>)
        : {},
    ...(plan.provenance !== undefined ? { provenance: plan.provenance } : {}),
  };
}

/**
 * Project a firing's persisted `steps` into the agent-facing write list plus
 * the per-run commit summary. Shared by `inspectMovementRun` (which surfaces
 * the writes) and `listMovementRuns` (which surfaces the counts). `runDryRun`
 * is the run-level rehearsal flag — used ONLY as the per-write fallback for
 * older runs that predate the per-write `committed` flag; a current run's
 * writes each carry their own truth (a live run can still capture a `dry_run`
 * instance's write).
 */
export function projectRunWrites(
  steps: unknown,
  runDryRun: boolean,
): { writes: MovementRunWrite[]; committed: number; captured: number } {
  const writes = flattenTriggerRunPlans(steps)
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => appliedPlanToWrite(p, !runDryRun));
  // A record a `match` found is listed (the reader sees what the run resolved
  // to) but was not written, so neither count includes it.
  const effects = writes.filter((w) => isWriteEffect({ kind: w.action }));
  const committed = effects.filter((w) => w.committed).length;
  return { writes, committed, captured: effects.length - committed };
}

/**
 * Read one run's full captured detail — the source event, the resolved
 * write-plan (every target + final field values), and the decision trace —
 * team-scoped (a cross-team id is simply not found). This is the "did it
 * actually do what I meant" surface, especially for a `dry_run` rehearsal: the
 * data all lives on the persisted `trigger_run`; this projects it for a reader.
 */
export async function inspectMovementRun(input: {
  teamId: string;
  runId: string;
}): Promise<MovementRunInspection | { error: string }> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', input.runId as TriggerRunId)
    .where('team_id', '=', input.teamId as TeamId)
    .select([
      'id',
      'status',
      'dry_run',
      'trigger_type',
      'trigger_payload',
      'movement_version_id',
      'changed_fields',
      'steps',
      'errors',
      'started_at',
      'completed_at',
      'failed_at',
      'failure_reason',
    ])
    .executeTakeFirst();
  if (!row) return { error: `run ${input.runId} not found` };

  const { writes, committed, captured } = projectRunWrites(row.steps, row.dry_run);

  const trace: unknown[] = [];
  for (const step of parseTriggerRunSteps(row.steps)) {
    const stepTrace = (step.diagnostics as Record<string, unknown> | undefined)?.trace;
    if (Array.isArray(stepTrace)) trace.push(...stepTrace);
  }

  const errors = Array.isArray(row.errors)
    ? (row.errors as Array<Record<string, unknown>>).map((e) => ({
        ...(typeof e.tgId === 'string' ? { tgId: e.tgId } : {}),
        ...('nodeId' in e ? { nodeId: (e.nodeId ?? null) as string | null } : {}),
        message: typeof e.message === 'string' ? e.message : String(e.message ?? 'error'),
      }))
    : [];

  // What it is waiting on, named in plain language (P22) — only meaningful for a
  // parked run, and cheap enough to always compute (a parked-leaf read).
  const awaiting =
    row.status === 'parked' ? await describeRunAwaits(row.id as unknown as TriggerRunId) : [];

  const cost = (await runCostSummaries([row.id as unknown as TriggerRunId])).get(
    row.id as unknown as string,
  );

  return {
    runId: row.id as unknown as string,
    status: row.status,
    committed,
    captured,
    triggerType: row.trigger_type,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.completed_at ? row.completed_at.toISOString() : null,
    failedAt: row.failed_at ? row.failed_at.toISOString() : null,
    failureReason: reportedFailureReason(row),
    costUsd: costMicrodollarsToUsd(cost?.costMicrodollars ?? 0),
    modelCalls: cost?.calls ?? 0,
    sourceEvent: row.trigger_payload,
    executedVersion: await describeExecutedVersion({ versionId: row.movement_version_id }),
    changedFields: row.changed_fields,
    writes,
    trace,
    errors,
    awaiting,
    callbacks: (await listRunCallbacks(row.id as unknown as TriggerRunId)).map((c) => ({
      id: c.id,
      url: callbackUrl(c.id),
      status: c.status,
      singleUse: c.singleUse,
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      params: c.params,
      calls: c.calls,
    })),
  };
}

/**
 * Build the `ManualInvocationPayload` event for a run — streaming any files
 * into document storage. Shared by the sync (`runMovementNow`) and async
 * (`runMovementAsync`) entries so both inject an identical event.
 */
async function buildManualInvocationEvent(args: {
  triggerId: string;
  input: RunMovementNowInput;
}): Promise<TriggerEvent> {
  const { triggerId, input } = args;
  // Stream each file into document storage; the returned objectUri becomes the
  // file's owner-resolvable byte handle on the payload.
  const files: ManualFile[] = [];
  for (const file of input.files ?? []) {
    const buffer = Buffer.from(file.contentBase64, 'base64');
    // Under the team's key prefix: what makes the file the team's to read
    // back (`streamFileRef`'s ownership check).
    const { objectUri } = await services.document.upload(Readable.from(buffer), {
      filename: file.filename,
      mimeType: file.contentType,
      contentLength: buffer.length,
      keyPrefix: teamDocumentKeyPrefix(input.teamId),
    });
    files.push({
      objectUri,
      filename: file.filename,
      contentType: file.contentType,
      size: buffer.length,
    });
  }

  const text = input.text?.trim() || undefined;
  const payload: ManualInvocationPayload = {
    firedAt: new Date().toISOString(),
    submissionId: input.requestId ?? randomUUID(),
    ...(input.actor?.email !== undefined ? { actorEmail: input.actor.email } : {}),
    ...(input.actor?.name !== undefined ? { actorName: input.actor.name } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
  return {
    pipelineInputId: `trigger:${triggerId}`,
    adapterType: MANUAL_ADAPTER_TYPE,
    triggerType: 'webhook',
    payload,
    occurredAt: payload.firedAt,
    ...(input.requestId !== undefined ? { idempotencyKey: input.requestId } : {}),
  };
}

/**
 * Resolve the trigger to dispatch on. With `triggerId` it's that trigger,
 * verbatim. With `movementId` the SAVED source is the gate: it must parse and
 * declare a manual listener whose derived trigger row is provisioned. Returns
 * the trigger id on success, or a `MovementRunNowFailure` describing why not.
 */
async function resolveManualTrigger(
  input: RunMovementNowInput,
): Promise<string | MovementRunNowFailure> {
  if (input.triggerId !== undefined) return input.triggerId;
  if (input.movementId === undefined) {
    return { ok: false, errors: ['runMovementNow needs exactly one of movementId / triggerId'] };
  }

  const row = await getMovementRow({ teamId: input.teamId, id: input.movementId });
  if (!row) {
    return { ok: false, errors: [`movement ${input.movementId} not found`] };
  }

  // The gate is the TEXT: the saved source must declare a manual listener.
  let manualTargets: string[];
  try {
    manualTargets = manualListenerMovements(parseProgram(row.source));
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    return {
      ok: false,
      errors: [`'${row.name}' does not parse — fix the file and save before running it`],
    };
  }
  if (manualTargets.length === 0) {
    return {
      ok: false,
      errors: [`'${row.name}' has no manual listener — ${NO_MANUAL_LISTENER_FIX}`],
    };
  }

  // The listener's derived trigger row is the channel. Saving reconciles
  // it; a manual listen in the text without a row means the last save
  // didn't go live.
  const derived = await listDerivedTriggerRows(row.id);
  const manualTriggers = derived.filter(
    (t) => resolveAdapterSlug(t.kind) === MANUAL_ADAPTER_TYPE,
  );
  if (manualTriggers.length === 0) {
    return {
      ok: false,
      errors: [
        `'${row.name}' declares a manual listener but no listener row is provisioned — save the file (a clean save derives it), then run again`,
      ],
    };
  }
  return manualTriggers[0].id;
}
