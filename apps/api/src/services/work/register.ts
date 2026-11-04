// The core's work: every core kind's handler, and the periodic rows that keep
// the core's sweeps and every registered unit's periodic kinds running. Units
// register their own kinds (`registerWorkKinds`, drain.ts); the deployment
// that runs the drain composes them (startup/automations.ts).

import { MINUTE, SECOND } from '../../constants';
import { registerAwaitWork } from '../movement_engine/await_resume';
import { registerCallbackFireWork } from '../movement_engine/callback_fire';
import { registerTimerWork } from '../movement_engine/timer_resume';
import { registerCronWork } from '../movement_scheduler/worker';
import { registerCarriedPollWork } from '../poll_source/carried_worker';
import { registerPollWork } from '../poll_source/worker';
import { registerListenSubscriptionWork } from '../translation_graph/movement/listen_subscriptions';
import { registerBringUpListensWork } from '../translation_graph/movement/listens_up';
import { registerRunOrphanSweepWork } from '../translation_graph/runs/trigger_run';
import { registerFireEventWork } from '../inbound/fire_event';
import { registerCarriedRunWork } from '../translation_graph/movement/carried_run_now';
import { registerDispatchWork } from '../translation_graph/triggers/dispatch_event';
import { registerReadDeliveryWork } from '../inbound/carried_delivery';
import { periodicUnitWorkKinds, type CoreWorkKind } from './kinds';
import { ensurePeriodicWork, removeRetiredWork } from './store';

/** Production's cadence for `cron_reconcile`: a 0.12.13 service beside this one
 *  ensures the same row. */
const CRON_RECONCILE_MS = 30 * SECOND;

const CORE_PERIODIC_WORK: ReadonlyArray<{ kind: CoreWorkKind; intervalMs: number }> = [
  { kind: 'poll_reconcile', intervalMs: 30 * SECOND },
  { kind: 'cron_reconcile', intervalMs: CRON_RECONCILE_MS },
  { kind: 'listen_subscription_retry', intervalMs: 5 * MINUTE },
  { kind: 'timer_sweep', intervalMs: 30 * SECOND },
  { kind: 'run_orphan_sweep', intervalMs: 30 * SECOND },
];

/** Kinds a past build ran and this one does not. Their periodic rows would
 *  otherwise sit in the table forever, claimed and released for want of a
 *  handler, so they are deleted where the periodic rows are ensured. */
const RETIRED_WORK_KINDS: readonly string[] = ['await_resume_sweep', 'ask_expiry_sweep'];

/** Upsert every periodic row — the core's and each registered unit's — and
 *  delete the retired kinds' rows. Idempotent; the drain loop retries it until
 *  it succeeds once. */
async function ensureAutomationsPeriodicWork(): Promise<void> {
  await Promise.all([
    ...[...CORE_PERIODIC_WORK, ...periodicUnitWorkKinds()].map(({ kind, intervalMs }) =>
      ensurePeriodicWork({ kind, key: kind, intervalMs }),
    ),
    removeRetiredWork(RETIRED_WORK_KINDS),
  ]);
}

/** Register every core kind's handler. */
function registerCoreWork(): void {
  registerTimerWork();
  registerPollWork();
  registerCarriedPollWork();
  registerCronWork();
  registerListenSubscriptionWork();
  registerBringUpListensWork();
  registerFireEventWork();
  registerCarriedRunWork();
  registerDispatchWork();
  registerReadDeliveryWork();
  registerAwaitWork();
  registerCallbackFireWork();
  registerRunOrphanSweepWork();
}

export { ensureAutomationsPeriodicWork, registerCoreWork };
