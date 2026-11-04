// What a run parked under a carried version (one whose awaits and callbacks
// live in `adapter_await` and `callback`) leaves standing when it ends: its
// correlations, its open asks, its live callbacks. A run that never wrote any
// of these finds nothing to close, so the one failure path every version shares
// closes them without asking which version the run is on.

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { abandonAskAwaits } from '../asks/carried_ask_awaits';
import { revokeRunCallbacks } from './callback_store';
import { dropRunCorrelations } from './carried_correlations';

export async function closeCarriedRun(runId: TriggerRunId): Promise<void> {
  await abandonAskAwaits({ runId });
  await dropRunCorrelations(runId);
  await revokeRunCallbacks(runId);
}
