// The wake slot's methods (docs/contracts/wake-slot.md): the host saying
// that work in its queue is ready now, or will be at an instant, so whatever
// starts its workers (a cloud queue, a scheduled task service) starts one
// then. Each answers `null` once the wake is arranged, not once the work ran.
// `kind` is the work row's kind (`fire_event`, `resume_timer`, …); a module
// may start a worker for that kind's pool, or ignore it.

import { z } from 'zod';

export const WAKE_METHODS = ['wake.now', 'wake.at'] as const;

export const WakeNowRequest = z.object({ kind: z.string().min(1) });
export type WakeNowRequestShape = z.infer<typeof WakeNowRequest>;

/** `at` as `Date.toISOString` writes it; one in the past is `wake.now`. */
export const WakeAtRequest = z.object({ kind: z.string().min(1), at: z.string().datetime() });
export type WakeAtRequestShape = z.infer<typeof WakeAtRequest>;
