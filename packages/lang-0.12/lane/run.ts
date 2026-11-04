// 0.12's run host: a segment someone started (Run now, a test run, a
// validate-then-run) and a segment of a run it parked. It is production's
// engine host at 0.12.13
// (`movement/engine_host.ts` on main) built from 0.12's own host kit, so the
// segment opens at host families v1, its adapters are 0.12's modules
// (./modules.ts), and every error the engine branches on by class is 0.12's
// own: a lost lease is 0.12's `RunLeaseLost`, a park this platform does not
// resume is 0.12's `MovementEngineError`.
//
// What the platform shares with every version crosses as functions over plain
// data (./run_types.ts): its billed model calls, its file text and rendering,
// its record bindings, its cross-run write locks, its acting-user rules, its
// cancel and lease, and its write ledger. What leaves here is plain data: the
// run's result, or why it failed, as text. Its parks go through 0.12's own
// run host core over the platform's rows (./resume.ts).

import {
  NEVER_CANCELLED,
  RANDOM_IDS,
  SegmentDirectory,
  WALL_CLOCK,
  actingPrincipalOf,
  adapterTable,
  appendingInto,
  closeSegmentWith,
  hostSegments,
  openSegmentWith,
  segmentScopedCalls,
  type EngineHost,
  type HostAdapters,
} from '@listen-fire/engine/public/host';
import { WRITE_METHODS } from '@listen-fire/engine/public/adapter';
import { refuseUnsupportedParkStateVersion, tenantIdOf, triggerEventSchema, type AnyParkedScopeState } from '@listen-fire/engine-contracts';
import {
  MovementEngineError,
  MovementRunFailed,
  RunLeaseLost,
  describeError,
  runFailureCause,
} from '@listen-fire/engine/public/errors';
import { fireCallbackBody, resumeMovement, runMovement, settleRaceFrame, type CancelGate, type MovementRunResult } from '@listen-fire/engine/public/movement-engine';
import { segmentWriteLocks } from '@listen-fire/engine/public/write-locks';
import { MovementParseError, RUN_HOST_UNITS, parseProgram, type Program } from '@listen-fire/movement-lang';
import type { TriggerEvent } from '@listen-fire/engine/public/inbound';

import { parkFamiliesOf } from './resume';
import { MANUAL_ADAPTER_TYPE, type ManualInvocationPayload } from '../units/manual';

import { teamSnapshot } from './catalog';
import { importClosure, readingPin } from './imports';
import { moduleTable } from './modules';
import type { EventReading, ResumeRequest, RunPlatform, SegmentOutcome, SegmentRequest } from './run_types';

/** The platform's cancel and lease as 0.12's gate: a lost lease is 0.12's
 *  `RunLeaseLost`, thrown at the same boundaries a cancel stops at. */
function cancelGateOf(control: RunPlatform['control'], runId: string | undefined): CancelGate {
  const leaseHeld = (): void => {
    if (control.leaseLost()) throw new RunLeaseLost(runId ?? 'this run');
  };
  return {
    cancelled: async () => {
      leaseHeld();
      return control.cancelled();
    },
    cancelledNow: async () => {
      leaseHeld();
      return control.cancelledNow();
    },
  };
}

/** `adapters`, keeping each record write in the platform's write ledger the
 *  moment its module answers it, as the platform keeps its own release's. A
 *  rehearsed instance sends nothing, so nothing is kept. */
export function ledgered(adapters: HostAdapters, keepWrite: NonNullable<RunPlatform['keepWrite']>): HostAdapters {
  const instances = new Map<string, { adapterType: string; rehearsed: boolean }>();
  return {
    async resolve(resolution) {
      const resolved = await adapters.resolve(resolution);
      instances.set(`${resolution.segmentId}:${resolved.instance}`, {
        adapterType: resolved.adapterType,
        rehearsed: resolution.dryRun === true,
      });
      return resolved;
    },
    async call(call) {
      const sentAt = new Date().toISOString();
      const answer = await adapters.call(call);
      const instance = instances.get(`${call.segmentId}:${call.instance}`);
      if (!WRITE_METHODS.some((method) => method === call.method) || 'error' in answer || instance === undefined || instance.rehearsed) return answer;
      const result: unknown = answer.result;
      if (typeof result === 'object' && result !== null && 'notFound' in result) return answer;
      const args: unknown = call.args;
      const recordType = typeof args === 'object' && args !== null && 'recordType' in args && typeof args.recordType === 'string' ? args.recordType : undefined;
      const written =
        typeof result === 'object' && result !== null && 'externalId' in result && typeof result.externalId === 'string'
          ? result.externalId
          : typeof args === 'object' && args !== null && 'externalId' in args && typeof args.externalId === 'string'
            ? args.externalId
            : undefined;
      if (recordType === undefined || written === undefined) return answer;
      try {
        await keepWrite({ adapterType: instance.adapterType, recordType, externalId: written, at: sentAt });
      } catch (err) {
        return {
          error: {
            kind: 'adapter_error',
            message: `keeping the write of ${recordType} ${written} in the write ledger failed after the write was sent: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
      return answer;
    },
  };
}

/** A rehearsal parks nothing, so it has nothing to wake. */
const unwokenByARehearsal = async (): Promise<void> => {};

/** The engine host one 0.12 segment runs on. */
function hostFor(request: { dryRun?: boolean; runId?: string; teamId: string; trace?: SegmentRequest['trace'] }, platform: RunPlatform): EngineHost {
  const segments = new SegmentDirectory();
  const modules = moduleTable(platform.modules);
  const table = adapterTable({
    segments,
    resolveLive: ({ adapterType, teamId, credentialsId, constructionArgs }) =>
      modules.resolve(adapterType, {
        teamId,
        ...(credentialsId !== undefined ? { credentialsId } : {}),
        ...(constructionArgs !== undefined ? { constructionArgs } : {}),
      }),
    credentials: platform.credentials,
    ...segmentScopedCalls,
    ...(platform.writeSink !== undefined ? { writeSink: platform.writeSink } : {}),
  });
  const locks = segmentWriteLocks(platform.locks);
  const adapters: HostAdapters =
    platform.keepWrite !== undefined
      ? ledgered({ resolve: (r) => table.resolve(r), call: (c) => table.call(c) }, platform.keepWrite)
      : { resolve: (r) => table.resolve(r), call: (c) => table.call(c) };
  const cancel = request.dryRun === true && platform.keepWrite === undefined ? NEVER_CANCELLED : cancelGateOf(platform.control, request.runId);
  return {
    segment: {
      open: (opening) => openSegmentWith(opening, { segments, locks, open: hostSegments.open }),
      close: (closing) => closeSegmentWith(closing, { segments, table, locks, close: hostSegments.close }),
    },
    adapters,
    llm: platform.llm,
    park: {
      ...(platform.parks !== undefined && request.runId !== undefined
        ? parkFamiliesOf({ parks: platform.parks, runId: request.runId, teamId: request.teamId, segments })
        : { wake: unwokenByARehearsal }),
      bindings: platform.bindings,
    },
    control: { cancel },
    files: {
      resolveFileText: platform.files.resolveFileText,
      render: platform.files.render,
    },
    lookup: {
      resolveActingUser: async ({ triggerId, segmentId, instance, event }) => {
        const user = await platform.actingUser({
          teamId: segments.facts(segmentId).teamId,
          ...(triggerId !== undefined ? { triggerId } : {}),
          candidates: () => table.answer({ segmentId, instance, method: 'getActorCandidates', args: { event } }),
        });
        return actingPrincipalOf(user);
      },
    },
    locks: { acquire: (input) => locks.acquire(input), release: (input) => locks.release(input) },
    ...(request.trace !== undefined ? { trace: appendingInto(request.trace) } : {}),
    clock: WALL_CLOCK,
    ids: RANDOM_IDS,
  };
}

function pinOfLibrary(name: string, request: Pick<SegmentRequest, 'pin' | 'team'>): string {
  return readingPin(request.team.files.find((f) => f.name === name)?.languageVersion ?? request.pin, request.pin);
}

/** The libraries a program imports, parsed under the pin each is read at;
 *  one 0.12 cannot parse is left to the run's own check to report. */
function librariesOf(files: Record<string, { source: string }>, request: Pick<SegmentRequest, 'pin' | 'team'>): Program[] {
  return Object.entries(files).flatMap(([name, file]) => {
    try {
      return [parseProgram(file.source, { languageVersion: pinOfLibrary(name, request) })];
    } catch (error) {
      if (error instanceof MovementParseError) return [];
      throw error;
    }
  });
}

/** A failure, as text and the code 0.12 gave it, with what the run had done. */
function failureOf(err: unknown): SegmentOutcome {
  const cause = runFailureCause(err);
  if (cause instanceof RunLeaseLost) return { kind: 'lease-lost', message: cause.message };
  const partial: MovementRunResult | undefined = err instanceof MovementRunFailed ? err.partial : undefined;
  return {
    kind: 'failed',
    message: describeError(cause),
    ...(cause instanceof MovementEngineError ? { code: cause.code } : {}),
    ...(partial !== undefined ? { partial } : {}),
  };
}

/** A program and its imports read under their pins, against the team's 0.12
 *  catalog: what a segment runs against, from its first statement or a park. */
async function preparedProgram(request: Pick<SegmentRequest, 'source' | 'pin' | 'team' | 'teamId'>, platform: RunPlatform) {
  const program = parseProgram(request.source, { languageVersion: request.pin });
  const closure = importClosure(program, request.pin, request.team.files);
  // An import of a library on another version is the program's own error,
  // named with both versions, before anything runs.
  if (closure.diagnostics.length > 0) {
    throw new MovementEngineError('MOVENG_CHECK', closure.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
  }
  const catalog = await teamSnapshot({
    team: request.team,
    files: closure.files,
    sources: [
      { source: request.source, pin: request.pin },
      ...Object.entries(closure.files).map(([name, file]) => ({ source: file.source, pin: pinOfLibrary(name, request) })),
    ],
    reading: {
      teamId: request.teamId,
      modules: platform.modules,
      programs: [program, ...librariesOf(closure.files, request)],
    },
  });
  return { catalog: catalog.snapshot, credentialIds: Object.fromEntries(request.team.credentials.map((row) => [row.name, row.id])) };
}

/**
 * Runs one 0.12 segment from its first statement, against the team's 0.12
 * catalog, on 0.12's engine. Never throws for the run's own failure: the
 * outcome says how it ended.
 */
export async function runSegment(request: SegmentRequest, platform: RunPlatform): Promise<SegmentOutcome> {
  try {
    const prepared = await preparedProgram(request, platform);
    const result = await runMovement({
      source: request.source,
      languageVersion: request.pin,
      ...(request.movementName !== undefined ? { movementName: request.movementName } : {}),
      event: triggerEventSchema.parse(request.event),
      teamId: tenantIdOf(request.teamId),
      firedAt: request.firedAt,
      ...(request.costCapMicrodollars !== undefined ? { costCapMicrodollars: request.costCapMicrodollars } : {}),
      ...prepared,
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      ...(request.dryRun !== undefined ? { dryRun: request.dryRun } : {}),
      host: hostFor(request, platform),
    });
    return { kind: 'ran', result };
  } catch (err) {
    return failureOf(err);
  }
}

/** A row's park state as 0.12 reads it: refused by name when 0.12 did not write
 *  it, and read whole by 0.12's engine from here. */
function parkStateOf(state: unknown): AnyParkedScopeState {
  if (!isParkState(state)) throw new MovementEngineError('MOVENG_RUNTIME', 'a parked leaf has no readable park state');
  refuseUnsupportedParkStateVersion(state.version);
  return state;
}

function isParkState(state: unknown): state is AnyParkedScopeState {
  return typeof state === 'object' && state !== null && 'version' in state && typeof state.version === 'number';
}

/**
 * Runs one segment of a run 0.12 parked, on 0.12's engine, from the pinned text:
 * a leaf resumed, a race settled with its winners, or a callback's body.
 */
export async function resumeSegment(request: ResumeRequest, platform: RunPlatform): Promise<SegmentOutcome> {
  try {
    const prepared = await preparedProgram(request, platform);
    const common = {
      source: request.source,
      languageVersion: request.pin,
      ...(request.movementName !== undefined ? { movementName: request.movementName } : {}),
      event: triggerEventSchema.parse(request.event),
      teamId: tenantIdOf(request.teamId),
      firedAt: request.firedAt,
      ...(request.costCapMicrodollars !== undefined ? { costCapMicrodollars: request.costCapMicrodollars } : {}),
      ...(request.priorSpentMicrodollars !== undefined ? { priorSpentMicrodollars: request.priorSpentMicrodollars } : {}),
      ...(request.capBaselineMicrodollars !== undefined ? { capBaselineMicrodollars: request.capBaselineMicrodollars } : {}),
      ...(request.limitPaused !== undefined ? { limitPaused: request.limitPaused } : {}),
      ...(request.parkedOnEngine !== undefined ? { parkedOnEngine: request.parkedOnEngine } : {}),
      ...prepared,
      runId: request.runId,
      host: hostFor(request, platform),
      state: parkStateOf(request.state),
    };
    if (request.callback !== undefined) return { kind: 'ran', result: await fireCallbackBody({ ...common, ...request.callback }) };
    if (request.settleRaceFrameAddress !== undefined) {
      return { kind: 'ran', result: await settleRaceFrame({ ...common, frameAddress: request.settleRaceFrameAddress }) };
    }
    return {
      kind: 'ran',
      result: await resumeMovement({
        ...common,
        ...(request.reenter !== undefined ? { reenter: request.reenter } : {}),
        ...(request.deferRaceSettlement !== undefined ? { deferRaceSettlement: request.deferRaceSettlement } : {}),
      }),
    };
  } catch (err) {
    return failureOf(err);
  }
}

/**
 * The movements a 0.12 program's manual listens fire, in file order: what
 * Run now can start (`listen to manual fire backfill`, or a construction of
 * `manual` bound to a name). Production's `manualListenerMovements` at
 * 0.12.13. A program 0.12 cannot parse has none.
 */
export function manualListens(request: { source: string; pin: string }): string[] {
  let program;
  try {
    program = parseProgram(request.source, { languageVersion: request.pin });
  } catch (error) {
    if (error instanceof MovementParseError) return [];
    throw error;
  }
  const importOriginals = new Map<string, string>();
  const constructionAdapters = new Map<string, string>();
  for (const unit of RUN_HOST_UNITS) constructionAdapters.set(unit, unit);
  for (const statement of program.statements) {
    if (statement.kind === 'import') {
      for (const { name, alias } of statement.names) {
        if (alias !== undefined) importOriginals.set(alias, name);
        constructionAdapters.delete(alias ?? name);
      }
    } else if (statement.kind === 'assign' && statement.value.kind === 'construct') {
      const callee = statement.value.construct.callee;
      constructionAdapters.set(statement.name, importOriginals.get(callee) ?? callee);
    }
  }
  return program.statements.flatMap((statement) =>
    statement.kind === 'listen' && constructionAdapters.get(statement.instance) === MANUAL_ADAPTER_TYPE ? [statement.movement] : [],
  );
}

/** A Run now press as the event 0.12's manual unit reads: production's
 *  `buildManualInvocationEvent` at 0.12.13. `key` names what fired it, as a
 *  trigger's id named it there. */
export function manualInvocationEvent(input: { key: string; invocation: ManualInvocationPayload; requestId?: string }): TriggerEvent {
  return {
    pipelineInputId: `trigger:${input.key}`,
    adapterType: MANUAL_ADAPTER_TYPE,
    triggerType: 'webhook',
    payload: input.invocation,
    occurredAt: input.invocation.firedAt,
    ...(input.requestId !== undefined ? { idempotencyKey: input.requestId } : {}),
  };
}

/** An event in 0.12's shape, read with 0.12's own schema: what the platform
 *  records of it (its run row), or why 0.12 cannot read it. */
export function readEvent(event: Readonly<Record<string, unknown>>): EventReading {
  const parsed = triggerEventSchema.safeParse(event);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'event'}: ${issue.message}`).join('; ') };
  const { pipelineInputId, adapterType, triggerType, payload, recordId, occurredAt, idempotencyKey } = parsed.data;
  return {
    ok: true,
    record: {
      pipelineInputId,
      adapterType,
      triggerType,
      ...(payload !== undefined ? { payload } : {}),
      ...(recordId !== undefined ? { recordId } : {}),
      ...(occurredAt !== undefined ? { occurredAt: String(occurredAt) } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    },
  };
}
