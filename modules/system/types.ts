// The platform's own events — the vocabulary the `system` adapter, its poll
// source and its handbook chapter all share.
//
// Five kinds, one record shape. Each kind is its own fires edge landing on its
// own node (a listen's parameter is addressed by the node it lands on, so five
// kinds sharing one node would be five listens nobody could tell apart), and
// every node carries the same fields, so a handler written for one reads the
// same way as a handler written for another.

/** Stable adapter identifier — the trigger `kind` of system-derived rows. */
export const SYSTEM_ADAPTER_TYPE = 'system';

/** One platform event kind: its internal type id (lowercase, stable), the
 *  natural name authors see (the edge, the node, AND the `events:` value), the
 *  discrimination tag the poll source stamps, and what an author is told. */
export interface SystemEventKind {
  typeId: string;
  displayName: string;
  tag: string;
  description: string;
}

export const RUN_FAILED: SystemEventKind = {
  typeId: 'run_failed',
  displayName: 'Run Failed',
  tag: 'system:run_failed',
  description:
    'An automation run ended failed. Delivered within a couple of minutes of ' +
    'the run settling; an automation is never told about its own failures, ' +
    'and a rehearsal (dry run) failing is not reported.',
};

export const RUN_PAUSED: SystemEventKind = {
  typeId: 'run_paused',
  displayName: 'Run Paused',
  tag: 'system:run_paused',
  description:
    'An automation run paused because it reached its cost limit (the per-run cap on model calls and ' +
    'paid services this deployment sets). Every branch of the run stopped before its next statement, ' +
    'and it stays paused until someone resumes it; resuming resets its usage. `Reason` says what it ' +
    'spent and the limit. Delivered within a couple of minutes of the pause.',
};

/** The deploy check's three kinds: emitted once per release, as it runs. */
const ON_DEPLOY = 'Emitted by the check that runs as a new release is deployed.';

export const VALIDATION_ISSUE: SystemEventKind = {
  typeId: 'validation_issue',
  displayName: 'Validation Issue',
  tag: 'system:validation_issue',
  description:
    `A saved automation does not validate cleanly under the release's current language ` +
    `version, so it stays on the version it is written in. \`Reason\` lists what to repair. ${ON_DEPLOY}`,
};

export const DEPRECATED_VERSION: SystemEventKind = {
  typeId: 'deprecated_version',
  displayName: 'Deprecated Version',
  tag: 'system:deprecated_version',
  description:
    `A saved automation is written in a language version the running release deprecates; ` +
    `it still runs, until a later release removes that version. ${ON_DEPLOY}`,
};

export const RELEASE_APPLIED: SystemEventKind = {
  typeId: 'release_applied',
  displayName: 'Release Applied',
  tag: 'system:release_applied',
  description:
    `A new release was deployed and its check ran over this workspace's automations. ` +
    `\`Reason\` names the release and how many automations moved to the current language ` +
    `version, stayed with warnings, or failed. Not about one automation: \`Automation\` is empty. ${ON_DEPLOY}`,
};

export const SYSTEM_EVENT_KINDS: readonly SystemEventKind[] = [
  RUN_FAILED,
  RUN_PAUSED,
  VALIDATION_ISSUE,
  DEPRECATED_VERSION,
  RELEASE_APPLIED,
];

/** The `events:` vocabulary — the natural names, exactly as an author writes
 *  them (`listen to sys { events: ["Run Failed"] }`). */
export const SYSTEM_SUBSCRIBABLE_EVENTS: readonly string[] = SYSTEM_EVENT_KINDS.map(
  (k) => k.displayName,
);

/** What every platform event carries — the seeded position's data, keyed by
 *  the internal field ids `describe` declares. */
export interface SystemEventPayload {
  automation: string;
  automationId: string;
  /** Empty when the event concerns no run. */
  runId: string;
  /** The language version's name; empty when the event concerns none. */
  version: string;
  reason: string;
  url: string;
  /** ISO instant, UTC. */
  at: string;
}
