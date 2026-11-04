// The hosted product as a carried version's run host: the same rows every
// version parks in, its correlations and callbacks, and the product's run
// records. The rules over them are the version's own
// (`@listen-fire/language-versions`, `ResumingLane`). A fenced write answers
// `lease-lost` rather than throwing this release's class: the version throws its
// own.

import { RunLeaseLost } from 'movement-engine/public/errors';
import { logger } from 'movement-engine/public/log';

import type { CarriedRunHost, FencedWrite } from '@listen-fire/language-versions';

import { abandonAskAwaits, loadResolvableAskAwaits } from '../asks/carried_ask_awaits';
import { postgresCallbackStore } from './callback_store';
import { postgresCorrelations } from './carried_correlations';
import { hostedRunHost } from './run_host';
import { postgresRunHostStore, triggerRunIdOf } from './run_host_store';
import { revokeRunCallbacks } from './callback_store';

async function fenced(write: () => Promise<void>): Promise<FencedWrite> {
  try {
    await write();
    return 'written';
  } catch (error) {
    if (error instanceof RunLeaseLost) return 'lease-lost';
    throw error;
  }
}

/** The carried run host. Built at call time, as the hosted one is. */
export function carriedRunHost(): CarriedRunHost {
  const { parks, joins, leases, work, sources } = postgresRunHostStore;
  const { runs } = hostedRunHost();
  return {
    store: {
      parks: {
        putLeaf: (input) => fenced(() => parks.putLeaf({ ...input, reason: parkReasonOf(input.reason) })),
        claimLeaf: (input) => parks.claimLeaf(input),
        finishLeaf: (input) => parks.finishLeaf(input),
        leaves: (input) => parks.leaves(input),
        deleteLeaves: (input) => parks.deleteLeaves(input),
      },
      joins: {
        recordJoin: (input) => fenced(() => joins.recordJoin(input)),
        decrementJoin: (input) => joins.decrementJoin(input),
        persistBranchExport: (input) => joins.persistBranchExport(input),
        collectBranchExports: (input) => joins.collectBranchExports(input),
        hasPendingJoins: (input) => joins.hasPendingJoins(input),
        frames: (input) => joins.frames(input),
        deleteFrames: (input) => joins.deleteFrames(input),
      },
      correlations: postgresCorrelations,
      leases,
      work,
      sources,
    },
    callbacks: postgresCallbackStore,
    askAwaits: {
      loadResolvable: ({ runId }) => loadResolvableAskAwaits({ runId: triggerRunIdOf(runId) }),
      abandon: ({ runId, addresses }) => abandonAskAwaits({ runId: triggerRunIdOf(runId), ...(addresses !== undefined ? { addresses } : {}) }),
    },
    runs: {
      cancelRequest: runs.cancelRequest,
      markFailed: runs.markFailed,
      closeRun: ({ runId }) => revokeRunCallbacks(triggerRunIdOf(runId)).then(() => undefined),
    },
    log: logger,
  };
}

const CORE_PARK_REASONS = ['timer', 'await', 'limit'] as const;
type CoreParkReason = (typeof CORE_PARK_REASONS)[number];

/** A reason a carried version's sink parks for, checked at this boundary: every
 *  version's parks live in one column. */
function parkReasonOf(reason: string): CoreParkReason {
  const known = CORE_PARK_REASONS.find((core) => core === reason);
  if (known === undefined) throw new Error(`a carried version parked for '${reason}', which the run rows do not hold`);
  return known;
}
