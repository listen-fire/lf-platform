// 0.12's parks and resumes: production's run host at 0.12.13
// (`movement_engine/run_host.ts`, `park_sink.ts`, `callback_sink.ts` on main)
// built from 0.12's own run host core, so a run parked under 0.12 is stepped by
// 0.12's rules: a callback's ledger, an await correlated to an adapter identity,
// park state version 2, and the keepers that close what stands behind a
// withdrawn await.
//
// The platform keeps the rows and hands them over as functions over plain data
// (./run_types.ts). Its fenced writes answer `lease-lost` rather than throwing
// its own class, and this file throws 0.12's `RunLeaseLost`, which is the class
// 0.12's engine and rules read.

import { RunLeaseLost } from '@listen-fire/engine/public/errors';
import {
  callbackAwaitKeeper,
  callbackSink,
  coerceCallbackValues as coreCoerceCallbackValues,
  drainDueTimers as coreDrainDueTimers,
  drainRun as coreDrainRun,
  parkSources,
  queueAwaitWake as coreQueueAwaitWake,
  runCallbackBody as coreRunCallbackBody,
  runParkSink,
  wakeAwaits as coreWakeAwaits,
  type CallbackRecord,
  type CallbackStore,
  type RunHost,
  type RunHostStore,
} from '@listen-fire/engine/public/run-host';
import { isCallbackParamType, type CallbackParamSpec } from '@listen-fire/engine-contracts';
import type { EngineHost } from '@listen-fire/engine/public/host';
import type { SegmentDirectory } from '@listen-fire/engine/public/host';
import { tenantIdOf } from '@listen-fire/engine-contracts';

import type {
  CarriedCallbackRecord,
  CarriedCallbackStore,
  CarriedParks,
  CarriedRunHost,
  CarriedStep,
  CarriedStepperFor,
  FencedWrite,
  RunCallbackBodyInput,
} from './run_types';

const ASK_ADAPTER_TYPE = 'ask';

function landed(written: FencedWrite, runId: string): void {
  if (written === 'lease-lost') throw new RunLeaseLost(runId);
}

function storeOf(host: CarriedRunHost): RunHostStore {
  const { parks, joins, correlations, leases, work, sources } = host.store;
  return {
    parks: {
      putLeaf: async (input) => landed(await parks.putLeaf(input), input.runId),
      claimLeaf: (input) => parks.claimLeaf(input),
      finishLeaf: (input) => parks.finishLeaf(input),
      leaves: (input) => parks.leaves(input),
      deleteLeaves: (input) => parks.deleteLeaves(input),
    },
    joins: {
      recordJoin: async (input) => landed(await joins.recordJoin(input), input.runId),
      decrementJoin: (input) => joins.decrementJoin(input),
      persistBranchExport: (input) => joins.persistBranchExport(input),
      collectBranchExports: (input) => joins.collectBranchExports(input),
      hasPendingJoins: (input) => joins.hasPendingJoins(input),
      frames: (input) => joins.frames(input),
      deleteFrames: (input) => joins.deleteFrames(input),
    },
    correlations,
    leases,
    work,
    sources,
  };
}

/** A stored signature in 0.12's terms; a parameter 0.12 has no type for was not
 *  written by 0.12, and fails here by name. */
function paramsOf(params: CarriedCallbackRecord['params']): CallbackParamSpec[] {
  return params.map(({ name, type }) => {
    if (!isCallbackParamType(type)) throw new Error(`a callback's parameter ${name} has type ${type}, which 0.12 does not have`);
    return { name, type };
  });
}

function callbackOf(record: CarriedCallbackRecord): CallbackRecord {
  return { ...record, params: paramsOf(record.params) };
}

function callbacksOf(callbacks: CarriedCallbackStore): CallbackStore {
  return {
    mint: (input) => callbacks.mint(input),
    get: async (input) => {
      const found = await callbacks.get(input);
      return found === null ? null : callbackOf(found);
    },
    record: async (input) => {
      const claim = await callbacks.record(input);
      switch (claim.kind) {
        case 'not_found':
          return claim;
        case 'recorded':
          return { ...claim, callback: callbackOf(claim.callback) };
        case 'closed':
        case 'expired':
          return { kind: claim.kind, callback: callbackOf(claim.callback) };
        default: {
          const unknown: never = claim;
          throw new Error(`unknown callback claim ${JSON.stringify(unknown)}`);
        }
      }
    },
    markBodyStarted: (input) => callbacks.markBodyStarted(input),
    landed: (input) => callbacks.landed(input),
    revokeRun: (input) => callbacks.revokeRun(input),
  };
}

/** The run host over the platform's rows: 0.12's rules, its keepers. */
function runHostOf(host: CarriedRunHost): RunHost {
  const store = storeOf(host);
  return {
    store,
    keepers: [
      { adapterType: ASK_ADAPTER_TYPE, loadResolvable: host.askAwaits.loadResolvable, abandon: host.askAwaits.abandon },
      callbackAwaitKeeper(store, callbacksOf(host.callbacks)),
    ],
    runs: host.runs,
    log: host.log,
  };
}

/** The durable half of one 0.12 segment's host: where its parks and callbacks
 *  go, what wakes them, and the library texts they pin. */
export function parkFamiliesOf(input: { parks: CarriedParks; runId: string; teamId: string; segments: SegmentDirectory }): Pick<Required<EngineHost['park']>, 'sink' | 'callbacks' | 'sources' | 'wake'> {
  const { parks, runId, teamId, segments } = input;
  const host = runHostOf(parks.host);
  return {
    sink: runParkSink(host, {
      runId,
      teamId,
      ...(parks.fence !== undefined ? { fence: parks.fence } : {}),
      records: { ensureRun: parks.ensureRun, markParked: parks.markParked, markLimitPaused: parks.markLimitPaused },
    }),
    callbacks: callbackSink(callbacksOf(parks.host.callbacks), { runId, teamId, url: parks.callbackUrl, ensureRun: parks.ensureRun }),
    sources: parkSources(host.store.sources, teamId),
    wake: async ({ segmentId, adapterType, correlationKey }) => {
      await coreQueueAwaitWake(host.store, { adapterType, teamId: tenantIdOf(segments.facts(segmentId).teamId), correlationKey });
      parks.notifyWork();
    },
  };
}

export function drainDueTimers(host: CarriedRunHost, input: { runId: string; dueBy: string; lease?: Parameters<typeof coreDrainDueTimers>[1]['lease']; step: CarriedStep }): Promise<'done' | 'leaseLost'> {
  return coreDrainDueTimers(runHostOf(host), input);
}

export function drainLeaves(
  host: CarriedRunHost,
  input: { runId: string; addresses: readonly string[]; reason: string; lease?: Parameters<typeof coreDrainRun>[1]['lease']; step: CarriedStep; until?: () => Promise<boolean> },
): Promise<'done' | 'leaseLost'> {
  const { addresses, reason, ...rest } = input;
  return coreDrainRun(runHostOf(host), { ...rest, leaves: { addresses, reason } });
}

export function wakeAwaits(
  host: CarriedRunHost,
  input: {
    wake: { adapterType: string; teamId: string; correlationKey: string };
    stepper: CarriedStepperFor;
    around?: (runId: string, body: () => Promise<void>) => Promise<void>;
    lease?: Parameters<typeof coreWakeAwaits>[1]['lease'];
  },
): Promise<{ busy: string[] }> {
  return coreWakeAwaits(runHostOf(host), input);
}

export function queueAwaitWake(
  host: CarriedRunHost,
  wake: { adapterType: string; teamId: string; correlationKey: string },
  opts: { coalesceKey?: string; dueAt?: string } = {},
): Promise<void> {
  return coreQueueAwaitWake(storeOf(host), wake, opts);
}

export function runCallbackBody(host: CarriedRunHost, input: RunCallbackBodyInput) {
  return coreRunCallbackBody(runHostOf(host), callbacksOf(host.callbacks), input);
}

export function coerceCallbackValues(params: CarriedCallbackRecord['params'], raw: Record<string, unknown>) {
  return coreCoerceCallbackValues(paramsOf(params), raw);
}
