// The wake slot: what tells a deployment's drain that work is due, so a drain
// that is not always running (a job started per wake) starts when a row comes
// due rather than at the next blind tick. The contract is lf's wake slot
// (`now(kind)`, `at(kind, at)`), filled in-process at boot from WAKE_MODULE
// (lib/wake.ts). Empty, nothing is told and every path behaves as before.
//
// A wake is a latency hint, never the work itself: the row is already in the
// store, and a scheduled drain finds it whether or not the wake was told. So
// an announcement waits a bounded time for its answer, never throws, and a
// failure is a log line.

import { logger } from 'movement-engine/public/log';

/** lf's wake slot, mirrored: answered once the wake is arranged. */
export interface WakeSlot {
  now(kind: string): Promise<void>;
  at(kind: string, at: Date): Promise<void>;
}

/** How long an enqueue waits for the wake's answer before going on without it. */
export const WAKE_WAIT_MS = 1_000;

const FAILURE_LOG_EVERY_MS = 60_000;

let slot: WakeSlot | undefined;
const inFlight = new Set<Promise<void>>();
let lastFailureLoggedAt: number | undefined;

/** Fill (or, with undefined, empty) the slot. Chosen at boot. */
export function installWake(wake: WakeSlot | undefined): void {
  slot = wake;
}

export function wakeInstalled(): boolean {
  return slot !== undefined;
}

function logFailure(kind: string, reason: string): void {
  const now = Date.now();
  if (lastFailureLoggedAt !== undefined && now - lastFailureLoggedAt < FAILURE_LOG_EVERY_MS) return;
  lastFailureLoggedAt = now;
  logger.warn(`[work] the wake was not told of ${kind} work (${reason}); a scheduled drain will find it`);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tell the wake that `kind` work is due at `dueAt` ("now" when it is not
 *  after `now`). Waits at most WAKE_WAIT_MS; a slower call is left running and
 *  tracked for settleWakes. Never throws. */
export async function announceWork(kind: string, dueAt: Date, now: Date = new Date()): Promise<void> {
  const wake = slot;
  if (wake === undefined) return;
  let call: Promise<void>;
  try {
    call = dueAt.getTime() <= now.getTime() ? wake.now(kind) : wake.at(kind, dueAt);
  } catch (error) {
    call = Promise.reject(error);
  }
  let answered = false;
  const tracked: Promise<void> = call
    .then(
      () => undefined,
      (error: unknown) => logFailure(kind, reasonOf(error)),
    )
    .finally(() => {
      answered = true;
      inFlight.delete(tracked);
    });
  inFlight.add(tracked);
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, WAKE_WAIT_MS);
    timer.unref();
  });
  await Promise.race([tracked, waited]);
  clearTimeout(timer);
  if (!answered) logFailure(kind, `no answer within ${WAKE_WAIT_MS} ms; the call carries on`);
}

/** Wait for the wakes still in flight, at most `timeoutMs`: for a process
 *  about to exit (a drain job), whose re-arms would otherwise go untold. */
export async function settleWakes(timeoutMs: number): Promise<void> {
  if (inFlight.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  await Promise.race([Promise.allSettled([...inFlight]), waited]);
  clearTimeout(timer);
}

/** Test-only: empty the slot and forget what is in flight and logged. */
export function resetWakeForTests(): void {
  slot = undefined;
  inFlight.clear();
  lastFailureLoggedAt = undefined;
}
