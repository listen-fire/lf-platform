// The platform's own events: the vocabulary `@lf/system`'s adapter, its poll
// and its handbook section share (docs/contracts/system-events.md in
// listen-fire, whose bundled `@lf/system` this module follows).
//
// One edge, `Events`, lands on one record, `Event`; its `Kind` says which of
// the seven things happened. Every event carries the same fields, so a handler
// written for one kind reads the same way as one written for another, and a
// listen names the kinds it wants with a WHERE the module takes:
// `sys-[e:Events WHERE e.Kind IN ["Run Failed", "Wait Lost Its Record"]]->`.

/** The adapter type: what a program's `connect` of `@lf/system` names. */
export const SYSTEM_ADAPTER_TYPE = 'system';

/** The root edge every event arrives on, and the record it lands on. */
export const EVENTS_EDGE = 'Events';
export const EVENT_TYPE = 'Event';

/** The field a listen narrows the kinds by. */
export const KIND_FIELD = 'Kind';

/** One kind of event: its name (the `Kind` an author writes) and what an
 *  author is told of it. */
export interface SystemEventKind {
  name: string;
  /** The stable lowercase id an event's id starts with. */
  id: string;
  description: string;
}

export const RUN_FAILED: SystemEventKind = {
  name: 'Run Failed',
  id: 'run_failed',
  description:
    'A run ended failed. A program is never told about the failures of its own listen, and a rehearsal (a dry run) failing is not reported.',
};

export const RUN_PAUSED: SystemEventKind = {
  name: 'Run Paused',
  id: 'run_paused',
  description:
    'A run paused at its cost limit, and stays paused until someone resumes it. `Reason` says what it spent and the limit.',
};

export const VALIDATION_ISSUE: SystemEventKind = {
  name: 'Validation Issue',
  id: 'validation_issue',
  description:
    'A saved program does not validate cleanly under the running release, so it cannot be upgraded to it yet. `Reason` lists what to repair.',
};

export const DEPRECATED_VERSION: SystemEventKind = {
  name: 'Deprecated Version',
  id: 'deprecated_version',
  description:
    'A saved program is written in a language version the running release deprecates; it still runs.',
};

export const RELEASE_APPLIED: SystemEventKind = {
  name: 'Release Applied',
  id: 'release_applied',
  description:
    'A new release is running. `Version` is the language version it runs, which on a hosted platform is not the platform\'s own release number. Not about one program: `Automation` and `Run Id` are empty.',
};

export const WAIT_LOST_ITS_RECORD: SystemEventKind = {
  name: 'Wait Lost Its Record',
  id: 'wait_lost_its_record',
  description:
    'A run waits on a record that was deleted, so nothing will ever arrive on its wait (docs/contracts/stranded-waits.md). `Adapter`, `Edge` and `Record Id` say which wait; a `race` with a `sleep` is the way out. A program is never told about its own listen\'s waits.',
};

export const ARRIVAL_NOT_JUDGED: SystemEventKind = {
  name: 'Arrival Not Judged',
  id: 'arrival_not_judged',
  description:
    'A listen could not tell whether something that arrived fires it: its WHERE reads a field the module could not read (the provider did not answer a lookup), or a record the arrival does not carry. That listen ran nothing for it; the arrival\'s other listens ran as usual. `Listen`, `Delivery Id` and `Arrival Id` say which listen, which delivery and which arrival; `Attempt` is 0 as delivered, one more for each replay. Reported once per listen and arrival, and once more for each replay that still cannot judge it (`listen-fire listens replay`, which puts the delivery through that listen again once the provider answers). A program is never told about its own listen\'s arrivals.',
};

export const SYSTEM_EVENT_KINDS: readonly SystemEventKind[] = [RUN_FAILED, RUN_PAUSED, VALIDATION_ISSUE, DEPRECATED_VERSION, RELEASE_APPLIED, WAIT_LOST_ITS_RECORD, ARRIVAL_NOT_JUDGED];

/** What `Kind` an omitted kind means in a 0.12 listen (`listen to sys {}`). */
export const DEFAULT_KIND = RUN_FAILED;

/** Every event's fields, as their names: what a landing carries. */
export interface SystemEventFields {
  'Event Id': string;
  Kind: string;
  Automation: string;
  'Automation Id': string;
  /** Empty when the event concerns no run. */
  'Run Id': string;
  /** The release's version; empty when the event concerns none. */
  Version: string;
  Reason: string;
  /** A link to where a person sees it; empty where the host has no such page. */
  Url: string;
  /** ISO instant, UTC. */
  At: string;
  /** For a wait that lost its record: the module its record is in; else empty. */
  Adapter: string;
  /** For a wait that lost its record, the edge it waits on; for an arrival not judged, the edge it arrived on. */
  Edge: string;
  /** For a wait that lost its record, the deleted record; for an arrival not judged, the record that landed. */
  'Record Id': string;
  /** For an arrival not judged: the listen, by its pipeline; else empty. */
  Listen: string;
  /** For an arrival not judged: the kept delivery it came in; else empty. */
  'Delivery Id': string;
  /** For an arrival not judged: the arrival, as the listen names it (its edge, record, identity and version); else empty. */
  'Arrival Id': string;
  /** For an arrival not judged: 0 as delivered, one more for each replay that still could not judge it; else 0. */
  Attempt: number;
}

/** The fields' declarations, in the order a handler reads them. */
export const SYSTEM_EVENT_FIELDS: ReadonlyArray<{ name: keyof SystemEventFields; kind: 'string' | 'number' | 'date' | 'enum'; description: string }> = [
  { name: 'Event Id', kind: 'string', description: 'Names the event: the same on every poll that finds it.' },
  { name: 'Kind', kind: 'enum', description: 'Which thing happened. A listen names the kinds it wants: `e.Kind == "Run Failed"`, or `e.Kind IN [...]`.' },
  { name: 'Automation', kind: 'string', description: 'The program the event is about (its movement); empty when it concerns none.' },
  { name: 'Automation Id', kind: 'string', description: 'That program’s id (on listen-fire, `<file>:<movement>`).' },
  { name: 'Run Id', kind: 'string', description: 'The run the event is about; empty when it concerns none.' },
  { name: 'Version', kind: 'string', description: 'The release involved; empty when none is.' },
  { name: 'Reason', kind: 'string', description: 'What happened, in words: for a failed run, why it failed.' },
  { name: 'Url', kind: 'string', description: 'A link to where a person sees it; empty where the host has no such page.' },
  { name: 'At', kind: 'date', description: 'When it happened (UTC).' },
  { name: 'Adapter', kind: 'string', description: 'For a wait that lost its record: the module its record is in. Empty on every other kind.' },
  { name: 'Edge', kind: 'string', description: 'For a wait that lost its record: the edge it waits on. For an arrival not judged: the edge it arrived on. Empty on every other kind.' },
  { name: 'Record Id', kind: 'string', description: 'For a wait that lost its record: the deleted record’s id. For an arrival not judged: the record that arrived. Empty on every other kind.' },
  { name: 'Listen', kind: 'string', description: 'For an arrival not judged: the listen that could not judge it, as the host names it. Empty on every other kind.' },
  { name: 'Delivery Id', kind: 'string', description: 'For an arrival not judged: the delivery it came in, which the host keeps for a while (on listen-fire `deliveries.retainDays`, 14 days by default); empty when the host kept none. Empty on every other kind.' },
  { name: 'Arrival Id', kind: 'string', description: 'For an arrival not judged: the arrival, as the listen names it (its edge, record, identity and version). Empty on every other kind.' },
  { name: 'Attempt', kind: 'number', description: 'For an arrival not judged: 0 when it was delivered, one more for each replay (`listen-fire listens replay`) that still could not judge it. 0 on every other kind.' },
];
