// The durable-park group — the production implementation of the engine's
// `park` family (its sink, waits and wake). The park rules (what a park writes and in which
// order, the lease fence, a race's losing subtrees, the cancel that raced a
// park) are the run-host core's (`runParkSink`); this supplies the hosted
// product's records around a park: the run row exists as `running` before
// anything is parked against it (lazily, through the firing's
// TriggerRunRecorder), the run is flipped to `parked`, and a limit pause is
// marked and announced.
//
// This keeps every DB concern OUT of the pure interpreter (which takes the sink
// as an injected dependency, exactly like `resolveAdapter`/`writeSink`).

import { runParkHost, type RunParkHost } from 'movement-engine/public/run-host';

import type { TriggerRunRecorder } from '../translation_graph/runs/trigger_run';

import { markRunLimitPaused } from './limit_pause';
import { hostedRunHost } from './run_host';

/**
 * Build the segment's park group, backed by its `TriggerRunRecorder` (the
 * run identity + version pin live there): where its parks go, its waits on
 * listenable edges, and the wake it asks for an arrival that landed while an
 * await parked.
 *
 * Given the run lease the segment holds, every park it commits lands only
 * while the run's lease is still that one: a holder whose lease lapsed
 * mid-statement is refused (`RunLeaseLost`) rather than overwriting the parks
 * of the instance that took the run over. `resumed` is the leaf a resumed
 * segment re-entered: a note its awaits make is kept with its progress.
 */
export function makeRecorderParks(recorder: TriggerRunRecorder, opts: { lease?: { token: string }; resumed?: string } = {}): RunParkHost {
  const runId = recorder.triggerRunId;
  return runParkHost(hostedRunHost(), {
    runId,
    teamId: recorder.teamId,
    ...(opts.lease !== undefined ? { fence: opts.lease.token } : {}),
    ...(opts.resumed !== undefined ? { resumed: opts.resumed } : {}),
    records: {
      ensureRun: () => recorder.ensureStarted(),
      markParked: () => recorder.markParked(),
      markLimitPaused: (pause) => markRunLimitPaused({ runId, teamId: recorder.teamId, triggerId: recorder.triggerId, pause }),
    },
  });
}
