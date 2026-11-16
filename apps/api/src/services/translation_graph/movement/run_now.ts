// "Run now": one invocation of a movement's manual listen.
//
// A movement is runnable on demand when its SAVED source listens to the
// host's manual unit (`listen to manual-[:Invocations]-> fire backfill`).
// Saving provisions that listen as a trigger row (its plan), and a press is an
// arrival on `Invocations`, judged by that one listen and kept as a delivery
// like any inbound one (inbound/listen_door.ts): the receipt, the arrival and
// the run's `fire_event` row are durable before the caller hears the run id,
// and the drain starts the run under the listen's receipt, through the same
// gates every firing passes (run mode: off = paused, dry_run = rehearse).
//
// An invocation OPTIONALLY carries text and/or files, and the member who
// pressed it (so `@user_*` / `@actor_*` resolve to them). Files' bytes are
// streamed into document storage (`services.document.upload`); the returned
// `objectUri` rides on the invocation as the file's owner-resolvable byte
// handle, which the manual adapter redeems via `resolveFileRef`.

import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { MovementParseError, parseProgram } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import { teamDocumentKeyPrefix } from 'movement-engine/public/files';
import { arrivalReceiptKey } from 'movement-engine/public/inbound';
import { services } from '../../../adapters/registry';
import { getAutomationsQb } from '../../../lib/kysely';
import { costMicrodollarsToUsd, runCostSummaries } from '../../../lib/llm_usage';
import { describeLimitPause, readLimitPause } from '../../movement_engine/limit_pause';
import { flattenTriggerRunPlans, parseTriggerRunSteps } from '../runs/trigger_run_read';
import { reportedFailureReason } from '../runs/trigger_run';
import {
  MANUAL_ADAPTER_TYPE,
  invocationArrival,
  type ManualFile,
  type ManualInvocationPayload,
} from '../adapters/manual';
import { manualListenerMovements } from './files';
import { getMovementRow, type MovementRow } from './store';
import { heldRunRefusal, legacyRunRefusal } from '../../movement_engine/dispatch/dispatch';
import {
  describeRunAwaits,
  type AwaitDescription,
} from '../../movement_engine/await_description';
import { isWriteEffect } from 'movement-engine/public/trace';
import {
  describeExecutedVersion,
  type ExecutedMovementVersion,
} from './version_store';
import {
  judgeArrivals,
  keepJudgedDelivery,
  savedListenOf,
  savedListens,
  type SavedListen,
} from '../../inbound/listen_door';
import { drainUntilIdle, notifyWork } from '../../work/drain';
import { QUEUED_RUN_WORK_KINDS } from '../../work/kinds';
import { carriedRunLaneOf } from './carried_run';
import { CARRIED_RUN_NOW_NAME, carriedRunTriggerId, queueCarriedRunNow } from './carried_run_now';
import { isLegacyLanguageVersion } from 'legacy-lang';
import type { Arrival } from 'engine-contracts';
import { logger } from 'movement-engine/public/log';
import { readKeptRequest } from '../../inbound/captured_request';
import { deliveryOriginOf } from '../../inbound/delivery_origin';
import { deliveryOf, reread } from '../../inbound/listen_replay';

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
  'listen to the manual unit and save first: `listen to manual-[:Invocations]-> fire <function>`; "Run now" is an arrival on its `Invocations`';

export interface MovementRunAsyncDispatched {
  ok: true;
  runId: string;
  status: 'running';
  movementName: string;
}

export type MovementRunAsyncResult = MovementRunAsyncDispatched | MovementRunNowFailure;

/**
 * Run a movement's manual listen once, now, IN THIS PROCESS: the dev CLI's
 * entry. The invocation is queued as every door queues it
 * (`runMovementAsync`), then this process drains the team's due work and
 * answers with the run as it settled. Every request door queues instead, so
 * no movement runs inside a request.
 */
export async function runMovementNow(
  input: RunMovementNowInput,
): Promise<MovementRunNowResult> {
  const queued = await runMovementAsync(input);
  if (!queued.ok) return queued;
  await drainUntilIdle({ owner: 'run-now', teamId: input.teamId });
  const status = await getMovementRunStatus({ teamId: input.teamId, runId: queued.runId });
  if ('error' in status) return { ok: false, errors: [status.error] };
  if (status.status === 'failed') {
    return { ok: false, errors: [status.failureReason ?? `run ${queued.runId} failed`] };
  }
  // Still running after this process drained: it did not run here (no
  // fire_event handler in this process, or another worker holds it), so
  // there is no outcome to answer with yet.
  if (status.status === 'running') {
    return { ok: false, errors: [`run ${queued.runId} did not settle in this process: follow it by its id`] };
  }
  return {
    ok: true,
    movementName: queued.movementName,
    dryRun: status.dryRun,
    recordCount: status.recordCount,
    errors: status.errors.map((e) => ({ nodeId: e.nodeId ?? null, message: e.message })),
  };
}

// ── Queued run (every on-demand door) ───────────────────────────────────────
//
// A non-trivial movement run (extraction + writes) outlasts any request: the
// MCP tool-call limit, a browser's patience, and a deployment that stops the
// api between requests. So a press is kept as a delivery whose one arrival
// its listen took: the receipt, the arrival and the run's `fire_event` row
// are durable before this returns the run id, and whichever worker drains
// next starts the run under that id. The caller follows it with
// `getMovementRunStatus(runId)`.

/**
 * Queue a run of a movement's manual listen and return its id at once. Does
 * NOT run it; poll `getMovementRunStatus`. A retried request carrying the same
 * `requestId` is the same delivery, and gets the first request's run id back.
 */
export async function runMovementAsync(
  input: RunMovementNowInput,
): Promise<MovementRunAsyncResult> {
  // The movement is read once: its pin chooses the run host.
  const row = input.triggerId === undefined && input.movementId !== undefined ? await getMovementRow({ teamId: input.teamId, id: input.movementId }) : undefined;
  if (row) {
    const carried = await carriedRunNowOf(input, row);
    if (carried !== undefined) return carried;
  }
  const listen = await resolveManualListen(input, row);
  if (!('pipeline' in listen)) return listen;

  const invocation = await buildInvocation(input);
  const arrival = invocationArrival(invocation);
  const now = new Date();
  const judged = await judgeArrivals({
    listens: [listen],
    delivery: { adapterType: MANUAL_ADAPTER_TYPE, credentialsId: null },
    arrivals: [arrival],
    now,
  });
  const run = judged.minted[0];
  if (run === undefined) {
    return {
      ok: false,
      errors: judged.lines.length > 0 ? judged.lines : [`${listen.file}: its manual listen did not take the invocation`],
    };
  }
  // A retry of the same request names the same run: its id is the request's.
  const minted = input.requestId !== undefined
    ? [{ ...run, runId: requestRunId({ teamId: input.teamId, pipeline: listen.pipeline, requestId: input.requestId }) }]
    : [run];
  await keepJudgedDelivery({
    teamId: input.teamId as TeamId,
    subscriptionId: MANUAL_ADAPTER_TYPE,
    adapterType: MANUAL_ADAPTER_TYPE,
    externalId: input.requestId !== undefined ? `run-now:${listen.pipeline}:${input.requestId}` : null,
    // A person asked for this run, as `listen-fire run` asks for one.
    source: 'cli',
    arrivals: [arrival],
    judged: { ...judged, minted },
    now,
  });
  notifyWork();
  return { ok: true, runId: minted[0]!.runId, status: 'running', movementName: listen.file };
}

// ── Run with this event ─────────────────────────────────────────────────────
//
// A stored arrival put through an automation's own listens as if it had passed
// their filters: someone with write on the automation vouches for it, as a
// Run now's press does (a writer could change the filter anyway). It is kept
// as a replay delivery of the one stored, under receipts of its own, so a
// listen that ran the arrival before runs it again.

export interface RunWithEventInput {
  teamId: string;
  automationId: string;
  deliveryId: string;
  /** Which of the arrivals the delivery brought, in the order it brought them. */
  arrivalIndex: number;
  /** Who vouched for it: a person, or (no `userId`) a machine key. */
  by: { userId?: string; credentialId?: string };
}

export interface RunWithEventStarted {
  ok: true;
  /** One run for each listen of the automation the arrival came on. */
  runIds: string[];
  movementName: string;
}

/** The module's arrivals in the order the delivery's ledger names them (the order an event's index counts in). */
function inBroughtOrder(arrivals: readonly Arrival[], brought: readonly string[] | undefined): Arrival[] {
  if (brought === undefined) return [...arrivals];
  return brought.flatMap((key) => arrivals.filter((arrival) => !('gone' in arrival) && arrivalReceiptKey(arrival) === key));
}

export const noSuchEvent = (deliveryId: string): MovementRunNowFailure => ({
  ok: false,
  errors: [`no delivery ${deliveryId} is kept for this team: a delivery past its retention is forgotten`],
});

/**
 * Queue a run of each listen of `automationId` that hears the arrival
 * `arrivalIndex` of the kept delivery `deliveryId`, without reading the
 * listen's filter. Does NOT run them; poll each run id.
 */
export async function runWithEvent(input: RunWithEventInput): Promise<RunWithEventStarted | MovementRunNowFailure> {
  const teamId = input.teamId as TeamId;
  const row = await deliveryOf(teamId, input.deliveryId);
  if (row === null) return noSuchEvent(input.deliveryId);
  const movement = await getMovementRow({ teamId: input.teamId, id: input.automationId });
  if (!movement) return nothingToRun({ movementId: input.automationId });
  const refusal = heldRunRefusal(movement.languageVersion);
  if (refusal !== undefined) return { ok: false, errors: [refusal] };
  if (row.request === null) {
    return {
      ok: false,
      errors: [
        row.replayOf !== null
          ? `delivery ${row.id} is a replay of ${row.replayOf}: run with an event of ${row.replayOf} itself`
          : `delivery ${row.id} kept no request (it was kept before deliveries kept theirs): its events cannot be run again`,
      ],
    };
  }
  const kept = readKeptRequest(row.request);
  if (kept === null) return { ok: false, errors: [`delivery ${row.id}'s kept request is not one the platform can read`] };
  const origin = await deliveryOriginOf({ teamId, deliveryId: row.id });
  if (origin === null || origin.adapterType === null) {
    return { ok: false, errors: [`delivery ${row.id} does not say which module delivered it: its events cannot be run again`] };
  }
  const { adapterType } = origin;
  // A page kept before deliveries recorded a connection still names its own.
  const delivery = { adapterType, credentialsId: origin.credentialsId ?? ('page' in kept ? kept.page.credential ?? null : null) };

  const listens = (await savedListens({ teamId, adapterType, movementId: movement.id as MovementId })).filter(
    (listen) => delivery.credentialsId === null || listen.credentialsId === null || listen.credentialsId === delivery.credentialsId,
  );
  const [first] = listens;
  if (first === undefined) {
    return { ok: false, errors: [`'${movement.name}' has no listen on ${adapterType} that hears the connection delivery ${row.id} came for`] };
  }

  let arrivals: Arrival[];
  try {
    if ('page' in kept) arrivals = kept.page.arrivals;
    else {
      const read = await reread(first, adapterType, kept.request);
      if ('refused' in read) return { ok: false, errors: [read.refused] };
      arrivals = inBroughtOrder(read.arrivals, kept.request.arrivalIds);
    }
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
  const arrival = arrivals[input.arrivalIndex];
  if (arrival === undefined || 'gone' in arrival) {
    return { ok: false, errors: [`delivery ${row.id} brought no event at ${input.arrivalIndex} that can be run (it brought ${arrivals.length})`] };
  }

  const now = new Date();
  const judged = await judgeArrivals({ listens, delivery, arrivals: [arrival], now, vouched: true });
  if (judged.minted.length === 0) {
    return { ok: false, errors: judged.lines.length > 0 ? judged.lines : [`no listen of '${movement.name}' takes an event on ${arrival.edge}: nothing to run`] };
  }
  const replay = await keepJudgedDelivery({
    teamId,
    subscriptionId: row.subscriptionId,
    adapterType,
    externalId: null,
    source: 'cli',
    arrivals: [arrival],
    judged,
    replayOf: row.id,
    credentialsId: row.credentialsId,
    forced: true,
    now,
  });
  notifyWork();
  logger.info(`[RunWithEvent] ${input.by.userId ?? 'a machine'}${input.by.credentialId !== undefined ? ` (key ${input.by.credentialId})` : ''} ran event ${input.arrivalIndex} of delivery ${row.id} through '${movement.name}' without its filter: ${replay.deliveryId}`);
  return { ok: true, runIds: replay.fires.map((fire) => fire.runId), movementName: movement.name };
}

/** A Run now of a movement whose pin a carried version runs: queued on that
 *  version's run host (./carried_run_now.ts). Undefined for any other. */
async function carriedRunNowOf(input: RunMovementNowInput, row: MovementRow): Promise<MovementRunAsyncResult | undefined> {
  // No new run starts on a legacy id: said here, with the remedy.
  if (isLegacyLanguageVersion(row.languageVersion)) return { ok: false, errors: [legacyRunRefusal(row.languageVersion, 'run')] };
  const lane = await carriedRunLaneOf(row.languageVersion);
  if (lane === undefined) return undefined;
  return queueCarriedRunNow({
    lane,
    teamId: input.teamId,
    movementId: row.id,
    name: row.name,
    pin: row.languageVersion,
    invocation: await buildInvocation(input),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
}

/** A run id that is a function of the request: `(team, listen, request)`
 *  hashed into the UUID layout. */
function requestRunId(input: { teamId: string; pipeline: string; requestId: string }): TriggerRunId {
  const hex = createHash('sha256').update(JSON.stringify([input.teamId, input.pipeline, input.requestId])).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}` as TriggerRunId;
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
  if (!row) return (await queuedRunStatus(input)) ?? { error: `run ${input.runId} not found` };
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

/**
 * A run its delivery queued and no worker has started yet: its `fire_event`
 * row is waiting, and its run row is written as the row starts it (under its
 * listen's receipt, inbound/fire_event.ts). Running, as far as its caller
 * goes.
 */
async function queuedRunStatus(input: { teamId: string; runId: string }): Promise<MovementRunStatus | null> {
  const row = await getAutomationsQb(['work'])
    .selectFrom('work')
    .where('host', '=', 'platform')
    .where('kind', 'in', [...QUEUED_RUN_WORK_KINDS])
    .where('team_id', '=', input.teamId)
    .where('dead_at', 'is', null)
    .where(sql<boolean>`payload->>'runId' = ${input.runId}`)
    .select('created_at')
    .executeTakeFirst();
  if (!row) return null;
  return {
    runId: input.runId,
    status: 'running',
    recordCount: 0,
    dryRun: false,
    errors: [],
    startedAt: row.created_at.toISOString(),
    finishedAt: null,
    failedAt: null,
    failureReason: null,
    costUsd: 0,
    modelCalls: 0,
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
  // A run someone started on a carried version is recorded under the
  // movement's own id: there is no listen row for it (./carried_run_now.ts).
  const triggerIds: string[] = [...triggerRows.map((r) => r.id), carriedRunTriggerId(input.movementId)];
  const laneByTriggerId = new Map([
    ...triggerRows.map((r) => [r.id, r.name ?? ''] as const),
    [carriedRunTriggerId(input.movementId), CARRIED_RUN_NOW_NAME] as const,
  ]);

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
  };
}

/**
 * The invocation a press is — streaming any files into document storage.
 */
async function buildInvocation(input: RunMovementNowInput): Promise<ManualInvocationPayload & { submissionId: string }> {
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
  return {
    firedAt: new Date().toISOString(),
    submissionId: input.requestId ?? randomUUID(),
    ...(input.actor?.email !== undefined ? { actorEmail: input.actor.email } : {}),
    ...(input.actor?.name !== undefined ? { actorName: input.actor.name } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}

/**
 * The manual listen to run. With `triggerId` it is that listen. With
 * `movementId` the SAVED source is the gate: it must parse and listen to the
 * manual unit, and that listen must be provisioned.
 */
/**
 * What a run of something that is not there answers. A route that may not
 * show the caller the automation answers the same, so the name is not
 * confirmed.
 */
export function nothingToRun(asked: { movementId: string } | { triggerId: string }): MovementRunNowFailure {
  return 'triggerId' in asked
    ? { ok: false, errors: [`trigger ${asked.triggerId} is no manual listen of this team: nothing to run`] }
    : { ok: false, errors: [`movement ${asked.movementId} not found`] };
}

async function resolveManualListen(
  input: RunMovementNowInput,
  /** The movement `movementId` names, when the caller read it already. */
  read?: MovementRow | null,
): Promise<SavedListen | MovementRunNowFailure> {
  if (input.triggerId !== undefined) {
    const listen = await savedListenOf(input.triggerId as TriggerId);
    if (listen === null || listen.teamId !== input.teamId || listen.plan.adapter !== MANUAL_ADAPTER_TYPE) {
      return nothingToRun({ triggerId: input.triggerId });
    }
    return listen;
  }
  if (input.movementId === undefined) {
    return { ok: false, errors: ['runMovementNow needs exactly one of movementId / triggerId'] };
  }

  const row = read !== undefined ? read : await getMovementRow({ teamId: input.teamId, id: input.movementId });
  if (!row) {
    return nothingToRun({ movementId: input.movementId });
  }
  // A pin this build does not run is refused before this release's parser
  // reads its text.
  const refusal = heldRunRefusal(row.languageVersion);
  if (refusal !== undefined) return { ok: false, errors: [refusal] };

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
      errors: [`'${row.name}' has no manual listen — ${NO_MANUAL_LISTENER_FIX}`],
    };
  }

  // Saving provisions the listen; one in the text without a row means the
  // last save didn't go live.
  const [listen] = await savedListens({
    teamId: input.teamId as TeamId,
    adapterType: MANUAL_ADAPTER_TYPE,
    movementId: row.id as MovementId,
  });
  if (listen === undefined) {
    return {
      ok: false,
      errors: [
        `'${row.name}' listens to the manual unit but its listen is not provisioned — save the file (a clean save provisions it), then run again`,
      ],
    };
  }
  return listen;
}
