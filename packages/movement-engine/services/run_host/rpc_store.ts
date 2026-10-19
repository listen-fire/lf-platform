// A run host backend a store module serves: every family of `RunHostStore`
// (store.ts) as the store slot's methods (docs/contracts/store-slot.md),
// carried as adapter protocol 2 calls over HTTP (a Unix socket on this box).
// It is how the contract suite (contract.ts), written once in TypeScript,
// holds a backend in another language to the same meaning —
// `lf --contract-store <state.db>` (crates/lf) first.
//
// A method is `<family>.<method>` as `RunHostStore` names it, its params the
// method's one input object, its result the method's answer; the callback
// family is `callbacks.<method>` as `CallbackStore` names it, and the run
// records `records.<method>` as `RunRecords` does. The error code
// `run_lease_lost` (`data: { runId }`) is rethrown as the core's
// `RunLeaseLost`, so the rules over the store see the one refusal they handle.

import { z } from 'zod';
import { CALLBACK_PARAM_TYPES } from 'engine-contracts';
import { RUN_LEASE_LOST_CODE } from 'engine-contracts/slots';
import { RunLeaseLost } from '../movement_engine/errors';
import { SlotClient, SlotRefused, startModule, type SlotAddress } from 'module-runtime/module_wire/wire';
import type { RunRecords } from './rules';
import type { CallbackClaim, CallbackStore, ClaimedWork, RunHostStore } from './store';

const Nothing = z.null();
const Leaf = z.object({
  address: z.string(),
  reason: z.string(),
  status: z.enum(['parked', 'resuming']),
  wakeAt: z.string().nullable(),
});
const Claimed = z.object({ reason: z.string(), state: z.unknown() }).nullable();
const Correlated = z.object({ runId: z.string(), teamId: z.string(), address: z.string() });
const Work = z.object({ id: z.string(), kind: z.string(), key: z.string(), payload: z.unknown(), claim: z.string() });
const Callback = z.object({
  id: z.string(),
  teamId: z.string(),
  runId: z.string(),
  address: z.string(),
  params: z.array(z.object({ name: z.string(), type: z.enum(CALLBACK_PARAM_TYPES) })),
  state: z.unknown(),
  calls: z.array(z.object({ at: z.string(), values: z.record(z.string(), z.unknown()), bodyStartedAt: z.string().optional() })),
  singleUse: z.boolean(),
  expiresAt: z.string().nullable(),
  status: z.enum(['live', 'fired', 'revoked']),
});
const Claim: z.ZodType<CallbackClaim> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recorded'), callback: Callback, callIndex: z.number() }),
  z.object({ kind: z.literal('not_found') }),
  z.object({ kind: z.literal('closed'), callback: Callback }),
  z.object({ kind: z.literal('expired'), callback: Callback }),
]);

/** The work claim the server reads: no more than it needs, whatever the caller spreads in. */
function claimOf(work: ClaimedWork & { dueAt?: string }): Record<string, unknown> {
  return { id: work.id, kind: work.kind, key: work.key, claim: work.claim, ...(work.dueAt !== undefined ? { dueAt: work.dueAt } : {}) };
}

export class RpcStoreBackend {
  readonly store: RunHostStore;
  readonly callbacks: CallbackStore;
  /** The run records the server keeps beside its families. */
  readonly runs: RunRecords;
  private readonly started: Promise<{ client: SlotClient; close(): Promise<void> }>;

  /** The store module `command` starts, or the one already at `address`. */
  constructor(command: string, args: readonly string[]);
  constructor(address: SlotAddress);
  constructor(target: string | SlotAddress, args: readonly string[] = []) {
    this.started =
      typeof target === 'string'
        ? startModule(target, args).then((module) => ({ client: new SlotClient(module.address), close: () => module.close() }))
        : Promise.resolve({ client: new SlotClient(target), close: async () => undefined });
    // A failed start is met by the first call; never an unhandled rejection.
    this.started.catch(() => undefined);
    this.store = this.families();
    this.callbacks = this.callbackFamily();
    this.runs = this.runRecords();
  }

  /** One call; its result read by `schema`. A fenced write refused because
   *  the run's lease is gone throws the core's `RunLeaseLost`. */
  async call<S extends z.ZodType>(method: string, params: object, schema: S): Promise<z.infer<S>> {
    const { client } = await this.started;
    try {
      return await client.read(method, params, schema);
    } catch (error) {
      if (error instanceof SlotRefused && error.code === RUN_LEASE_LOST_CODE) {
        const runId = error.data !== null && typeof error.data === 'object' ? Reflect.get(error.data, 'runId') : undefined;
        throw new RunLeaseLost(typeof runId === 'string' ? runId : '');
      }
      throw error;
    }
  }

  /** A run row the backend can park against (the contract's `newRun`). */
  async startRun(input: { id: string; file: string; movement: string; startedAt: string; input: string }): Promise<void> {
    await this.call('runs.start', input, Nothing);
  }

  /** An operator asks to cancel the run (the records contract's `requestCancel`). */
  async requestCancel(input: { runId: string; reason: string | null }): Promise<void> {
    await this.call('runs.requestCancel', input, Nothing);
  }

  /** The run's status as the server's run record holds it (`runStatus`). */
  runStatus(runId: string): Promise<string> {
    return this.call('runs.status', { runId }, z.string());
  }

  /** Mark the run completed (`completeRun`). */
  async completeRun(runId: string): Promise<void> {
    await this.call('runs.complete', { runId }, Nothing);
  }

  /** End the module this backend started. */
  async close(): Promise<void> {
    const started = await this.started.catch(() => undefined);
    await started?.close();
  }

  private callbackFamily(): CallbackStore {
    const call = this.call.bind(this);
    return {
      mint: (input) => call('callbacks.mint', input, z.object({ id: z.string() })),
      get: (input) => call('callbacks.get', input, Callback.nullable()),
      record: (input) => call('callbacks.record', input, Claim),
      markBodyStarted: (input) => call('callbacks.markBodyStarted', input, z.boolean()),
      landed: (input) => call('callbacks.landed', input, z.array(z.string())),
      revokeRun: async (input) => {
        await call('callbacks.revokeRun', input, Nothing);
      },
    };
  }

  private runRecords(): RunRecords {
    const call = this.call.bind(this);
    return {
      cancelRequest: (input) => call('records.cancelRequest', input, z.object({ reason: z.string().nullable() }).nullable()),
      markFailed: async (input) => {
        await call('records.markFailed', input, Nothing);
      },
      closeRun: async (input) => {
        await call('records.closeRun', input, Nothing);
      },
    };
  }

  private families(): RunHostStore {
    const call = this.call.bind(this);
    return {
      parks: {
        putLeaf: async (input) => {
          await call('parks.putLeaf', input, Nothing);
        },
        claimLeaf: (input) => call('parks.claimLeaf', input, Claimed),
        finishLeaf: async (input) => {
          await call('parks.finishLeaf', input, Nothing);
        },
        leaves: (input) => call('parks.leaves', input, z.array(Leaf)),
        deleteLeaves: async (input) => {
          await call('parks.deleteLeaves', input, Nothing);
        },
      },
      joins: {
        recordJoin: async (input) => {
          await call('joins.recordJoin', input, Nothing);
        },
        decrementJoin: (input) => call('joins.decrementJoin', input, z.object({ closed: z.boolean() })),
        persistBranchExport: async (input) => {
          await call('joins.persistBranchExport', input, Nothing);
        },
        collectBranchExports: (input) =>
          call('joins.collectBranchExports', input, z.array(z.object({ branchAddress: z.string(), branchIndex: z.number(), exports: z.unknown() }))),
        hasPendingJoins: (input) => call('joins.hasPendingJoins', input, z.boolean()),
        frames: (input) => call('joins.frames', input, z.array(z.string())),
        deleteFrames: async (input) => {
          await call('joins.deleteFrames', input, Nothing);
        },
      },
      correlations: {
        correlate: async (input) => {
          await call('correlations.correlate', input, Nothing);
        },
        correlated: (input) => call('correlations.correlated', input, z.array(Correlated)),
        ofRun: (input) => call('correlations.ofRun', input, z.array(Correlated.extend({ correlationKey: z.string() }))),
        drop: async (input) => {
          await call('correlations.drop', input, Nothing);
        },
        dropRun: async (input) => {
          await call('correlations.dropRun', input, Nothing);
        },
      },
      leases: {
        claim: (input) => call('leases.claim', input, z.object({ token: z.string() }).nullable()),
        renew: (input) => call('leases.renew', input, z.boolean()),
        release: async (input) => {
          await call('leases.release', input, Nothing);
        },
        dropRunState: (input) => call('leases.dropRunState', input, z.boolean()),
      },
      work: {
        enqueue: async (input) => {
          await call('work.enqueue', input, Nothing);
        },
        claimDue: (input) => call('work.claimDue', input, z.array(Work)),
        complete: async (work) => {
          await call('work.complete', claimOf(work), Nothing);
        },
        release: async (work) => {
          await call('work.release', claimOf(work), Nothing);
        },
      },
      sources: {
        put: async (input) => {
          await call('sources.put', input, Nothing);
        },
        get: (input) => call('sources.get', input, z.string().nullable()),
      },
    };
  }
}
