// What `@lf/system` reads: the host's facts about its own runs and waits.
// The platform hands them in from its own tables (`systemModuleWith`), as
// listen-fire's records door does for listen-fire
// (docs/contracts/system-events.md in listen-fire, "Adopting it elsewhere").
// The facts name no event kind: which are events, and what each says, is
// the poll's (poll.ts).

/** Where a page of runs left off: its last run (when it settled, and its id). */
export interface RunMark {
  at: string;
  runId: string;
}

/** Where a page of stranded waits left off: its last wait. */
export interface WaitMark {
  at: string;
  waitId: string;
}

/** Where a page of releases left off: its last release. */
export interface ReleaseMark {
  at: string;
  version: string;
}

/** Where a page of unjudged arrivals left off: its last one. */
export interface UnjudgedMark {
  at: string;
  listen: string;
  arrival: string;
  /** Absent in a cursor kept before replays were attempts of their own: 0. */
  attempt?: number;
}

/** The program a run belongs to; null for a run no program owns. */
export interface Automation {
  id: string;
  name: string;
}

/** A run that settled failed (or paused). */
export interface SettledRun {
  runId: string;
  automation: Automation | null;
  /** The listen whose arrival started it, by its pipeline: an event about it
   *  is never that listen's. Null for a run no listen started. */
  listen: string | null;
  /** A rehearsal (a dry run): its failure is not reported. */
  rehearsal: boolean;
  reason: string;
  /** When it failed (or paused), ISO 8601. */
  at: string;
  /** Where a person opens it, when the host has such a page. */
  url?: string;
}

/** A wait parked on a record that was deleted (docs/contracts/stranded-waits.md). */
export interface StrandedWait {
  waitId: string;
  runId: string;
  automation: Automation | null;
  listen: string | null;
  /** The module its record is in, and the edge it waits on. */
  adapter: string;
  edge: string;
  /** The deleted record's id; null when the host does not know it. */
  recordId: string | null;
  /** When the host found it stranded, ISO 8601. */
  at: string;
}

/** A listen that could not judge an arrival (its WHERE reads what the
 *  arrival's module could not read), kept once per listen, arrival and
 *  attempt. */
export interface UnjudgedArrival {
  /** The listen, by its pipeline: an event about it is never that listen's. */
  listen: string;
  /** The arrival, as the listen names it. */
  arrival: string;
  automation: Automation;
  /** The kept delivery it came in; null when the host kept none. */
  deliveryId: string | null;
  edge: string;
  /** The module the arrival came from; null on a fact kept before the host
   *  kept it (store migration 17). */
  adapter: string | null;
  recordId: string | null;
  /** What landed, as its module reported it (`{ recordType, fields }`); null
   *  on a fact kept before the host kept it. This module knows its own
   *  `Arrival Not Judged` events by it. */
  landing: unknown;
  reason: string;
  /** The run whose write caused the arrival, when one did: the event is
   *  about it, so a run the event fires continues its chain. */
  cause: string | null;
  /** When the host found it could not judge it, ISO 8601. */
  at: string;
  /** Which judging it was: 0 as it was delivered, one more for each replay
   *  of it through the listen (`listen-fire listens replay`). */
  attempt: number;
}

/** A release the host first ran under, and when. */
export interface Release {
  version: string;
  at: string;
}

/** The host's facts, each read a page at a time after a mark, oldest first. */
export interface SystemRecords {
  /** Runs failed after `after` and no later than `until`. */
  failedRuns(input: { after: RunMark; until: string; limit: number }): Promise<SettledRun[]>;
  /** Runs paused at their cost limit, likewise. */
  pausedRuns(input: { after: RunMark; until: string; limit: number }): Promise<SettledRun[]>;
  /** Waits stranded after `after`. */
  strandedWaits(input: { after: WaitMark; limit: number }): Promise<StrandedWait[]>;
  /** Releases first run after `after`. */
  releases(input: { after: ReleaseMark; limit: number }): Promise<Release[]>;
  /** Arrivals a listen could not judge, found after `after`. */
  unjudgedArrivals(input: { after: UnjudgedMark; limit: number }): Promise<UnjudgedArrival[]>;
  /** The web app's base URL an event's `Url` links into; null where the host has none. */
  webBaseUrl(): Promise<string | null>;
}
