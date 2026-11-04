// The await-resume worker: a `wake_await` row names one wait an arrival
// answered (`{ waitId, runId, address }`, queued in the same write that logged
// the arrival, or by the park group when an arrival landed as the await
// parked). The run host core's `wakeWait` steps the run under its lease,
// re-entering the await parked at the address, which reads the wait's
// arrivals and binds its own landing. This module supplies the hosted pieces:
// the per-run single-flight slot, the step (resume_step.ts) and the handler.

import { waitWakeOf, wakeWait, type StepperFor } from 'movement-engine/public/run-host';
import { logger } from 'movement-engine/public/log';

import { correlatedAwaitsLane, type CarriedStepperFor } from '@listen-fire/language-versions';
import { z } from 'zod';

import type { WorkHandler } from '../work/kinds';

import { getAutomationsQb } from '../../lib/kysely';
import { registerWorkHandler, WorkDeferred } from '../work/drain';
import { createSingleFlight } from './single_flight';
import { hostedLeaseOptions, hostedRunHost } from './run_host';
import { triggerRunIdOf } from './run_host_store';
import { carriedRunHost } from './carried_host';
import { carriedRunStep, parkedRunStep } from './resume_step';

// Single-flight per run (F18/F21): concurrent wakes for the SAME run
// coalesce — one drain runs, gathering ALL of that run's currently-resolvable
// leaves as one batch (which is what makes the multi-winner tie deterministic);
// a wake arriving mid-drain queues exactly one follow-up rather than racing a
// second overlapping drain that would double-settle the same race frame.
/** Exported so the CALLBACK fire path shares the very same slot: a fire's body
 *  segment and an await resume of the same run must never overlap (one movement
 *  instance at a time, F21). A drain enters through `coalesce` — it re-gathers
 *  the run's resolvable leaves every pass, so arrivals mid-flight collapse onto
 *  one follow-up; a fire enters through `exclusive` — its body belongs to ONE
 *  recorded call and must never be replayed. A caller already inside the slot
 *  must use `drainRunAwaits` directly — re-entering the slot for its own key
 *  would await its own promise. */
export const runResumeSlot = createSingleFlight<string>();

export const awaitStepper: StepperFor = ({ runId, lease }) => parkedRunStep({ runId: triggerRunIdOf(runId), lease, log: 'AwaitResume' });

export const carriedStepper: CarriedStepperFor = ({ runId, lease }) => carriedRunStep({ runId: triggerRunIdOf(runId), lease, log: 'AwaitResume' });

/** A wake that names an adapter identity rather than a wait: a run parked on a
 *  key, as 0.12 parks one, which only a version that parks on keys steps. */
const correlatedWakeSchema = z.object({ adapterType: z.string(), teamId: z.string(), correlationKey: z.string() });

/** Drives each run parked on one adapter identity, by its version's own rules. */
async function resumeCorrelated(wake: z.infer<typeof correlatedWakeSchema>): Promise<void> {
  const lane = correlatedAwaitsLane();
  if (lane === undefined) {
    logger.warn('[AwaitResume] a wake_await row names a key, and no version this platform carries parks on keys: dropped', { wake });
    return;
  }
  const { wakeAwaits } = await lane();
  const { busy } = await logged({ ...wake }, () =>
    wakeAwaits(carriedRunHost(), {
      wake,
      stepper: carriedStepper,
      around: (runId, body) => runResumeSlot.coalesce(runId, body),
      lease: hostedLeaseOptions(),
    }),
  );
  if (busy.length > 0) throw new WorkDeferred(`run ${busy.join(', ')} is held by another process`);
}

/**
 * One wait's wake: drive its run through the per-run slot (this process's
 * own wakes of a run collapse onto one pass), then the run's lease (no other
 * process steps it meanwhile). A run held elsewhere is not lost: the wake row
 * retries with backoff. A run gone since its wait was answered steps nothing.
 */
export async function resumeWait(payload: unknown): Promise<void> {
  const wake = waitWakeOf(payload);
  if (wake === null) {
    const correlated = correlatedWakeSchema.safeParse(payload);
    if (correlated.success) return resumeCorrelated(correlated.data);
    logger.warn('[AwaitResume] a wake_await row names no wait: dropped', { payload });
    return;
  }
  const run = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', triggerRunIdOf(wake.runId))
    .select('team_id')
    .executeTakeFirst();
  if (run === undefined) return;
  const { busy } = await logged({ ...wake }, () =>
    wakeWait(hostedRunHost(), {
      wake,
      teamId: run.team_id,
      stepper: awaitStepper,
      around: (runId, body) => runResumeSlot.coalesce(runId, body),
      lease: hostedLeaseOptions(),
    }),
  );
  if (busy) throw new WorkDeferred(`run ${wake.runId} is held by another process`);
}

/** A failed drain is logged, then rethrown so the wake row that brought it is
 *  released for a backoff retry rather than completed: with no poll behind it,
 *  a wake that failed on a transient fault and was then deleted would strand
 *  the run. */
async function logged<T>(context: Record<string, unknown>, drain: () => Promise<T>): Promise<T> {
  try {
    return await drain();
  } catch (err) {
    logger.error('[AwaitResume] run resume failed', { ...context, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export const wakeAwaitHandler: WorkHandler = {
  run: resumeWait,
};

export function registerAwaitWork(): void {
  registerWorkHandler('wake_await', wakeAwaitHandler);
}
