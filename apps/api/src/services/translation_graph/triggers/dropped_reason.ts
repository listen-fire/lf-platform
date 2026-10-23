// Why a dispatch ran nothing. The router decides it; every door that runs on
// someone's behalf (a queued run, the sync Run-now) names it in plain language.

import { neverAsAny } from 'movement-engine/public/types';

/** Why the dispatch produced no evaluations. */
export type DroppedReason =
  | 'native_echo'
  | 'trigger_not_found'
  | 'no_bound_tgs'
  | 'run_mode_off'
  // Loop-guard dispositions (Phase 1). `loop_guard_paused`: a team-budget
  // breach already paused this automation; the run is skipped, the receipt
  // stays replayable. `loop_guard_throttled`: a per-trigger rate breach held
  // this run; the stored receipt is re-dispatched after a delay (queue-don't-
  // drop), or flagged for replay when no receipt was provided.
  | 'loop_guard_paused'
  | 'loop_guard_throttled'
  // Opt-in echo-suppression (Phase 2). `echo_suppressed`: this listen has
  // `suppress_self` on and the SOURCE adapter confirmed WE authored this
  // inbound change — the firing is skipped so the author's 2-way sync
  // doesn't self-echo. The event is RECORDED as suppressed (replayable),
  // not dropped. Distinct from `native_echo` (the always-on Layer 14.4
  // token-registry drop) — this one is opt-in and capability-gated.
  | 'echo_suppressed'
  // Ownership gate (§6.4b): the source adapter requires a REGISTERED actor
  // on inbound events, and this event's actor didn't resolve to one — the
  // bot's own echo and unregistered senders drop by the same rule. The
  // event is RECORDED as suppressed (replayable), never silent.
  | 'actor_unregistered'
  // The trigger carries no movementId — a legacy TG-orchestration binding.
  // The TG execution engine has been retired (plans/2026-06-14-kill-tg), so
  // only movement-derived triggers execute; there is nothing to dispatch.
  | 'no_movement'
  // The listener's movement has no current version: no save of it ever
  // shipped, so there is no text to run (an unconfirmed edit is not one). The
  // receipt is RECORDED as suppressed (replayable).
  | 'not_shipped'
  // The team is lf-engined (its engine setting): lf runs its listeners, so the
  // platform's dispatch runs none. The receipt is RECORDED as suppressed
  // (replayable), so switching the team back can replay what lf did not see.
  | 'engine_lf';

/**
 * Every dispatch-gate drop, named for the person who started the run. A queued
 * run settles with this as its `failure_reason`, and the sync Run-now reports
 * it as an error, so a gated run never collapses into an unexplained "no
 * firing". Never leaks a raw sentinel.
 */
export function describeDroppedReason(reason: DroppedReason): string {
  switch (reason) {
    case 'run_mode_off':
      return "this listener is paused (run mode 'off') — set it live to run it";
    case 'loop_guard_paused':
      return 'held by the runaway-automation guard — a prior usage breach paused this automation; resume it from the app';
    case 'loop_guard_throttled':
      return 'throttled by the runaway-automation guard (rate limit) — this run was skipped; try again in a minute';
    case 'echo_suppressed':
      return "suppressed as this automation's own echo (suppress_self is on and the source change was written by it)";
    case 'actor_unregistered':
      return 'dropped — the person or bot behind the inbound event is not a registered user of this workspace';
    case 'native_echo':
      return "dropped as this workspace's own echo — the inbound change was made by its automations";
    case 'trigger_not_found':
      return 'the listener row was not found — re-save the automation, then run it again';
    case 'engine_lf':
      return "this team's automations run in lf, not on the platform (the team's engine setting)";
    case 'not_shipped':
      return 'this automation has never been saved live — an edit waiting for confirmation does not run; confirm or fix the save, then run it again';
    case 'no_bound_tgs':
    case 'no_movement':
      return 'this listener has no automation bound to it — re-save the automation, then run it again';
    default:
      return neverAsAny(reason);
  }
}
