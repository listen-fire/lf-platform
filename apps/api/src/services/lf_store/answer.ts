// The store slot served over the platform's run tables: one handler per
// method, each reading its params as lf's own bridge does (crates/lf/src/
// contract_store.rs: camel case, an absent optional string `null`) and
// answering the rows of crates/lf/src/store_wire.rs. A bad param is
// `bad_request`; a fenced write that lost its lease is `run_lease_lost`
// (`data: { runId }`); an unknown method is `method_not_implemented`; any
// other failure is the store's own (`module_error`).

import { z } from 'zod';
import { SlotRefusal, type SlotAnswer } from 'module-runtime/module_wire/wire';
import { MANIFEST_PROTOCOL_VERSION } from 'engine-contracts';

import type { WireSlotManifestShape } from 'engine-contracts/slots';

import * as callbacks from './callbacks';
import * as inbound from './inbound';
import * as live from './live_state';
import * as runs from './runs';
import * as work from './work';
import { LF_STORE_METHODS, isLfStoreMethod, type LfStoreMethod } from './methods';
import { pool, type LfTenant } from './scope';

export const LF_STORE_MANIFEST: WireSlotManifestShape = {
  protocolVersion: MANIFEST_PROTOCOL_VERSION,
  name: 'lf-platform-store',
  kind: 'core',
  slot: 'store',
  methods: [...LF_STORE_METHODS],
};

// ── Params ──────────────────────────────────────────────────────────────────

const str = z.string();
/** An optional string: absent and `null` alike are `null`. */
const optStr = z.string().nullish().transform((v) => v ?? null);
const int = z.number().int();
/** A flag: absent is false. */
const flag = z.boolean().nullish().transform((v) => v === true);
/** Any JSON value; absent is stored as `null`, as `x ?? null`. */
const value = z.unknown().optional().transform((v) => v ?? null);
const strings = z.array(z.string());
const optStrings = z.array(z.string()).nullish().transform((v) => v ?? null);

const RunStartParams = z.object({
  id: str,
  file: str,
  movement: str,
  startedAt: str,
  input: str,
  deliveryId: optStr,
});

const ParkParams = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('timer'), wakeAt: str }),
  z.object({ kind: z.literal('await'), teamId: str, adapterType: str, correlationKey: str }),
  z.object({ kind: z.literal('limit') }),
]);

const DeliveryParams = z.object({
  id: str,
  externalId: optStr,
  receivedAt: str,
  source: z.enum(['webhook', 'hook', 'emit', 'cli']),
  inline: z.boolean(),
  replayOf: optStr,
  events: z.array(z.unknown()),
});

const WorkRowParams = z.object({
  kind: str,
  key: str,
  // Present, though it may be `null`.
  payload: z.unknown().refine((v) => v !== undefined, 'expected a payload'),
  dueAt: optStr,
  teamId: optStr,
});

/** `inbound.keepDelivery` tells an absent cursor (left as it is) from a
 *  `null` one (saved): the presence is read before the schema sees it. */
const KeepDeliveryParams = z.preprocess(
  (raw) =>
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...raw, checkpoint: 'checkpoint' in raw ? { saved: Reflect.get(raw, 'checkpoint') ?? null } : null }
      : raw,
  z.object({
    subscriptionId: str,
    checkpoint: z.object({ saved: z.unknown() }).nullable(),
    delivery: DeliveryParams,
    work: z.array(WorkRowParams),
  }),
);

// ── Dispatch ────────────────────────────────────────────────────────────────

interface Handler {
  answer(scope: LfTenant, params: Record<string, unknown>): Promise<unknown>;
}

/** A method's params schema and what it does with them. */
function handler<S extends z.ZodType>(schema: S, run: (scope: LfTenant, params: z.output<S>) => Promise<unknown>): Handler {
  return {
    async answer(scope, raw) {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new SlotRefusal('bad_request', `${issue?.path.join('.') || 'params'}: ${issue?.message ?? 'not this method\'s params'}`);
      }
      return run(scope, parsed.data);
    },
  };
}

const runId = z.object({ runId: str });

/** Every method has its handler: the type says so, and the unit test checks it. */
const HANDLERS: { readonly [M in LfStoreMethod]: Handler } = {
  // Stateless: every method works without it (`RpcStoreBackend(address)`
  // never sends it). It names the tenant lf's own runs are kept under.
  'store.open': handler(z.object({}).passthrough(), async (scope) => ({ tenant: scope.tenant })),

  'runs.start': handler(RunStartParams, runs.startRun),
  'runs.requestCancel': handler(z.object({ runId: str, reason: optStr }), runs.requestCancel),
  'runs.status': handler(runId, runs.runStatus),
  'runs.complete': handler(runId, (scope, p) =>
    runs.settleRun(scope, { runId: p.runId, status: 'completed', outcome: null, at: new Date().toISOString() }),
  ),
  'runs.settle': handler(z.object({ runId: str, status: str, outcome: value, at: str }), runs.settleRun),
  'runs.markParked': handler(runId, (scope, p) => runs.markParked(pool(), scope, p.runId)),
  'runs.get': handler(runId, runs.getRun),
  'runs.list': handler(z.object({ limit: int }), runs.listRuns),
  'runs.appendTrace': handler(z.object({ runId: str, segmentId: str, entries: z.array(z.unknown()) }), runs.appendTrace),
  'runs.traceLength': handler(runId, runs.traceLength),
  'runs.spent': handler(runId, runs.runSpent),
  'runs.addSpend': handler(z.object({ runId: str, microdollars: z.number() }), runs.addRunSpend),
  'runs.resetSpendBaseline': handler(runId, runs.resetSpendBaseline),
  'records.cancelRequest': handler(runId, runs.cancelRequest),
  'records.markFailed': handler(z.object({ runId: str, message: str }), runs.markFailed),
  'records.closeRun': handler(runId, (scope, p) => callbacks.revokeRunCallbacks(pool(), scope, p.runId)),

  'callbacks.mint': handler(
    z.object({ teamId: str, runId: str, address: str, params: value, state: value, singleUse: flag, expiresAt: optStr }),
    callbacks.mint,
  ),
  'callbacks.get': handler(z.object({ id: str }), callbacks.get),
  'callbacks.record': handler(z.object({ id: str, values: value, bodyDueAt: str }), callbacks.record),
  'callbacks.markBodyStarted': handler(z.object({ id: str, callIndex: int, fence: optStr }), callbacks.markBodyStarted),
  'callbacks.landed': handler(z.object({ ids: strings }), callbacks.landed),
  'callbacks.revokeRun': handler(runId, (scope, p) => callbacks.revokeRunCallbacks(pool(), scope, p.runId)),

  'parks.putLeaf': handler(
    z.object({ runId: str, address: str, reason: str, wakeAt: optStr, state: value, fence: optStr }),
    (scope, p) => live.putLeaf(pool(), scope, p),
  ),
  'parks.claimLeaf': handler(z.object({ runId: str, address: str, reason: optStr }), live.claimLeaf),
  'parks.finishLeaf': handler(z.object({ runId: str, address: str, fence: optStr }), live.finishLeaf),
  'parks.leaves': handler(z.object({ runId: str, parkedOnly: flag, reason: optStr, dueBy: optStr }), live.leaves),
  'parks.deleteLeaves': handler(z.object({ runId: str, addresses: strings }), live.deleteLeaves),

  'joins.recordJoin': handler(z.object({ runId: str, frameAddress: str, pending: int, fence: optStr }), live.recordJoin),
  'joins.decrementJoin': handler(
    z.object({ runId: str, frameAddress: str, branchAddress: str, leafAddress: str }),
    live.decrementJoin,
  ),
  'joins.persistBranchExport': handler(
    z.object({ runId: str, frameAddress: str, branchAddress: str, branchIndex: int, exports: value }),
    live.persistBranchExport,
  ),
  'joins.collectBranchExports': handler(z.object({ runId: str, frameAddress: str }), live.collectBranchExports),
  'joins.hasPendingJoins': handler(runId, live.hasPendingJoins),
  'joins.frames': handler(runId, live.frames),
  'joins.deleteFrames': handler(z.object({ runId: str, frameAddresses: strings }), live.deleteFrames),

  'correlations.correlate': handler(
    z.object({ runId: str, teamId: str, address: str, adapterType: str, correlationKey: str }),
    live.correlate,
  ),
  'correlations.correlated': handler(z.object({ adapterType: str, teamId: str, correlationKey: str }), live.correlated),
  'correlations.ofRun': handler(z.object({ runId: str, adapterType: str }), live.ofRun),
  'correlations.drop': handler(z.object({ runId: str, address: str }), live.dropCorrelation),
  'correlations.dropRun': handler(runId, live.dropRunCorrelations),

  'leases.claim': handler(z.object({ runId: str, ttlMs: int }), live.claimLease),
  'leases.renew': handler(z.object({ runId: str, token: str, ttlMs: int }), live.renewLease),
  'leases.release': handler(z.object({ runId: str, token: str }), live.releaseLease),
  'leases.dropRunState': handler(z.object({ runId: str, fence: optStr }), live.dropRunState),

  'work.enqueue': handler(z.object({ kind: str, key: str, payload: value, dueAt: optStr, teamId: optStr }), work.enqueue),
  'work.enqueueIfAbsent': handler(z.object({ kind: str, key: str, payload: value, dueAt: optStr, teamId: optStr }), work.enqueueIfAbsent),
  'work.claimDue': handler(z.object({ limit: int, leaseMs: int, dueBy: optStr, kinds: optStrings }), work.claimDue),
  'work.complete': handler(z.object({ id: str, claim: str }), work.complete),
  'work.release': handler(z.object({ id: str, claim: str, dueAt: optStr, why: optStr }), work.release),

  'sources.put': handler(z.object({ teamId: str, hash: str, source: str }), live.putSource),
  'sources.get': handler(z.object({ teamId: str, hash: str }), live.getSource),

  'inbound.checkpoint': handler(z.object({ subscriptionId: str }), inbound.checkpoint),
  'inbound.saveCheckpoint': handler(z.object({ subscriptionId: str, checkpoint: value }), inbound.saveCheckpoint),
  'processes.list': handler(z.object({}).passthrough(), (scope) => inbound.listProcesses(scope)),
  'processes.swap': handler(z.object({ version: int, processes: value }), inbound.swapProcesses),
  'events.claim': handler(z.object({ listen: str, key: str }), inbound.claimEvent),
  'events.startRun': handler(RunStartParams.extend({ listen: str, key: str }), (scope, p) => {
    const { listen, key, ...run } = p;
    return inbound.startEventRun(scope, { listen, key, run });
  }),
  'runs.lapsed': handler(z.object({ staleMs: int, limit: int }), runs.lapsedRuns),
  'parks.commit': handler(
    z.object({ runId: str, address: str, state: value, fence: optStr, park: ParkParams }),
    live.commitPark,
  ),
  'work.bury': handler(z.object({ id: str, claim: str, reason: str }), work.bury),
  'inbound.keepDelivery': handler(KeepDeliveryParams, inbound.keepDelivery),
  'inbound.deliveries': handler(z.object({ subscriptionId: optStr, since: optStr, limit: int }), inbound.deliveries),
  'inbound.delivery': handler(z.object({ id: str }), inbound.delivery),
  'inbound.sweepDeliveries': handler(z.object({ before: str, limit: int }), inbound.sweepDeliveries),
  'inbound.forgetDeliveryId': handler(z.object({ id: str }), inbound.forgetDeliveryId),
};

/** Whether a method has a handler: the unit test's check over the list. */
export function hasHandler(method: string): boolean {
  return isLfStoreMethod(method) && HANDLERS[method] !== undefined;
}

/** The slot's answer in one tenant. Settings are the install's and carry
 *  nothing this module reads: they are never logged. */
export function answerFor(scope: LfTenant): SlotAnswer {
  return async (method, params) => {
    if (!isLfStoreMethod(method)) throw new SlotRefusal('method_not_implemented', `no method "${method}"`);
    try {
      return await HANDLERS[method].answer(scope, params);
    } catch (error) {
      if (error instanceof SlotRefusal && error.code === 'bad_request') {
        throw new SlotRefusal('bad_request', `${method}: ${error.message}`, error.data);
      }
      throw error;
    }
  };
}
