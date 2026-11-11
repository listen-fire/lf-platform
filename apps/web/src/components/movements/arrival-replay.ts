// What a Replay on the activity list does to one arrival, by how it reached
// its listen: whether it runs it again on purpose, and what the person is
// asked before it does.

import { neverAsAny } from "movement-lang";

import type { RouterOutputs } from "@/lib/trpc";

export type ArrivalStatus = RouterOutputs["views"]["movement"]["events"][number]["status"];

export const REFUSED_REPLAY_QUESTION = "This was refused by its fire list. Run it anyway?";

/** Whether a replay of this arrival runs it again on purpose: only one that
 *  started a run before took its listen's receipt. */
export function replayForces(status: ArrivalStatus): boolean {
  switch (status) {
    case "ran":
    case "run_failed":
      return true;
    case "not_judged":
    case "refused":
      return false;
    default:
      return neverAsAny(status);
  }
}

/** What the person is asked before the replay, or null when it goes at once.
 *  A refused arrival's replay runs it on the replaying writer's word, past the
 *  fire list, so they are asked once. */
export function replayQuestion(status: ArrivalStatus): string | null {
  switch (status) {
    case "refused":
      return REFUSED_REPLAY_QUESTION;
    case "ran":
    case "run_failed":
    case "not_judged":
      return null;
    default:
      return neverAsAny(status);
  }
}
