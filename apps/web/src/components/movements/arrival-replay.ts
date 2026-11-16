// What a Replay on the activity list does to one arrival, by how it reached
// its listen: whether it runs it again on purpose.

import { neverAsAny } from "movement-lang";

import type { RouterOutputs } from "@/lib/trpc";

export type ArrivalStatus = RouterOutputs["views"]["movement"]["events"][number]["status"];

/** Whether a replay of this arrival runs it again on purpose: only one that
 *  started a run before took its listen's receipt. */
export function replayForces(status: ArrivalStatus): boolean {
  switch (status) {
    case "ran":
    case "run_failed":
      return true;
    case "not_judged":
    case "waiting_for_host":
    case "does_not_fire":
      return false;
    default:
      return neverAsAny(status);
  }
}
