// The system poll: the host's own events, made from the facts it keeps
// (records.ts). A run is failed, and a wait stranded, by many writers, and
// every one of them lands in the host's tables, so a poll over those tables
// since a mark catches them all, at the price of a minute's latency, which a
// failure notice can afford.
//
// One poll per listen's kinds (adapter protocol 2.6 shares a poll between
// the listens that take the same filter): the poll reads only the kinds the
// listen's WHERE names, and says so (`takenApplied`). A WHERE it cannot read
// leaves it reading every kind, and the host judges the WHERE itself.
//
// A program is never told about its own listen's failures: a handler that
// fails while reporting a failure would otherwise report itself, forever.
// Each event about a run is `notFor` the listen that started that run. A
// handler failing on ANOTHER listen's failures is a chain of runs, and the
// host's loop breaker caps it: each event is `about` its run, which the
// host matches to its own fact about that run.

import type { PollEdgeAnswer, PollEdgeInput } from 'module-kit';

import type { ReleaseMark, RunMark, SettledRun, StrandedWait, SystemRecords, UnjudgedArrival, UnjudgedMark, WaitMark } from './records';
import {
  ARRIVAL_NOT_JUDGED,
  EVENT_TYPE,
  EVENTS_EDGE,
  KIND_FIELD,
  RELEASE_APPLIED,
  RUN_FAILED,
  RUN_PAUSED,
  SYSTEM_EVENT_KINDS,
  WAIT_LOST_ITS_RECORD,
  type SystemEventFields,
  type SystemEventKind,
} from './types';

type Arrival = PollEdgeAnswer['arrivals'][number];

/** How often the host polls `Events` unless lf.yaml's `pollEvery` says otherwise. */
export const SYSTEM_POLL_EVERY_SECONDS = 60;

/** A fact's time is stamped before its row commits, so a row can appear with
 *  a time already behind the mark. Reading only rows older than this keeps
 *  the mark behind every write still in flight. */
export const DEFAULT_SETTLE_SECONDS = 10;

/** Rows per kind per poll: more waits for the next poll. */
export const DEFAULT_PAGE_SIZE = 100;

/** What an operator may set for the poll (the install's env: `SYSTEM_SETTLE_SECONDS`, `SYSTEM_PAGE_SIZE`). */
export interface SystemPollSettings {
  settleSeconds: number;
  pageSize: number;
}

export const DEFAULT_POLL_SETTINGS: SystemPollSettings = { settleSeconds: DEFAULT_SETTLE_SECONDS, pageSize: DEFAULT_PAGE_SIZE };

/** The lowest id, for a mark that has passed no row at its instant yet. */
const NIL_ID = '00000000-0000-0000-0000-000000000000';

/** Where the last poll stopped, per source of facts. */
export interface SystemCursor {
  failed?: RunMark;
  paused?: RunMark;
  stranded?: WaitMark;
  releases?: ReleaseMark;
  unjudged?: UnjudgedMark;
}

/** The kinds a taken filter names (`Kind == "…"`, `Kind IN [...]`); undefined
 *  for none, or for one this module cannot read (every kind is read, and the
 *  host judges the filter). */
export function kindsTaken(filter: unknown): SystemEventKind[] | undefined {
  if (typeof filter !== 'object' || filter === null) return undefined;
  const left: unknown = Reflect.get(filter, 'left');
  const right: unknown = Reflect.get(filter, 'right');
  const onKind = typeof left === 'object' && left !== null && Reflect.get(left, 'type') === 'property' && Reflect.get(left, 'propertyTypeId') === KIND_FIELD;
  const value: unknown = typeof right === 'object' && right !== null && Reflect.get(right, 'type') === 'static' ? Reflect.get(right, 'value') : undefined;
  if (Reflect.get(filter, 'type') !== 'compare' || !onKind) return undefined;
  const op: unknown = Reflect.get(filter, 'op');
  const names = op === 'eq' && typeof value === 'string' ? [value] : op === 'in' && Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
  return names === undefined ? undefined : SYSTEM_EVENT_KINDS.filter((kind) => names.includes(kind.name));
}

function cursorOf(cursor: unknown): SystemCursor | undefined {
  return typeof cursor === 'object' && cursor !== null ? (cursor as SystemCursor) : undefined;
}

const EMPTY_FIELDS = {
  Automation: '',
  'Automation Id': '',
  'Run Id': '',
  Version: '',
  Reason: '',
  Url: '',
  Adapter: '',
  Edge: '',
  'Record Id': '',
  Listen: '',
  'Delivery Id': '',
  'Arrival Id': '',
  Attempt: 0,
} as const;

function event(input: { kind: SystemEventKind; id: string; at: string; fields: Partial<SystemEventFields>; run?: string; listen?: string | null; taken: boolean }): Arrival {
  const fields: SystemEventFields = { ...EMPTY_FIELDS, ...input.fields, 'Event Id': input.id, Kind: input.kind.name, At: input.at };
  return {
    edge: EVENTS_EDGE,
    identity: input.id,
    landing: { recordId: input.id, recordType: EVENT_TYPE, fields: { ...fields } },
    ...(input.run !== undefined ? { about: { recordType: 'Run', externalId: input.run } } : {}),
    ...(input.listen !== undefined && input.listen !== null ? { notFor: input.listen } : {}),
    ...(input.taken ? { takenApplied: true } : {}),
    occurredAt: input.at,
  };
}

function runEvent(kind: SystemEventKind, run: SettledRun, webBaseUrl: string | null, taken: boolean): Arrival {
  const activity = kind === RUN_FAILED ? 'view=activity&status=failed' : 'view=activity';
  const url = run.url ?? (webBaseUrl !== null && run.automation !== null ? `${webBaseUrl.replace(/\/$/, '')}/movements/${encodeURIComponent(run.automation.id)}?${activity}` : '');
  return event({
    kind,
    id: `${kind.id}:${run.runId}:${run.at}`,
    at: run.at,
    fields: { Automation: run.automation?.name ?? '', 'Automation Id': run.automation?.id ?? '', 'Run Id': run.runId, Reason: run.reason, Url: url },
    run: run.runId,
    listen: run.listen,
    taken,
  });
}

function waitEvent(wait: StrandedWait, taken: boolean): Arrival {
  return event({
    kind: WAIT_LOST_ITS_RECORD,
    id: `${WAIT_LOST_ITS_RECORD.id}:${wait.waitId}:${wait.at}`,
    at: wait.at,
    fields: {
      Automation: wait.automation?.name ?? '',
      'Automation Id': wait.automation?.id ?? '',
      'Run Id': wait.runId,
      Reason: `the record it waits on was deleted: nothing will arrive on ${wait.edge}`,
      Adapter: wait.adapter,
      Edge: wait.edge,
      'Record Id': wait.recordId ?? '',
    },
    run: wait.runId,
    listen: wait.listen,
    taken,
  });
}

function unjudgedEvent(unjudged: UnjudgedArrival, taken: boolean): Arrival {
  return event({
    kind: ARRIVAL_NOT_JUDGED,
    // One per listen, arrival and attempt, however often it is found: each
    // replay that still cannot judge it is reported again.
    id: `${ARRIVAL_NOT_JUDGED.id}:${unjudged.listen}:${unjudged.arrival}:${unjudged.attempt}`,
    at: unjudged.at,
    fields: {
      Automation: unjudged.automation.name,
      'Automation Id': unjudged.automation.id,
      Reason: unjudged.reason,
      Edge: unjudged.edge,
      'Record Id': unjudged.recordId ?? '',
      Listen: unjudged.listen,
      'Delivery Id': unjudged.deliveryId ?? '',
      'Arrival Id': unjudged.arrival,
      Attempt: unjudged.attempt,
    },
    ...(unjudged.cause !== null ? { run: unjudged.cause } : {}),
    listen: unjudged.listen,
    taken,
  });
}

/**
 * One poll of `Events` over the host's facts. The first poll (no cursor)
 * sets the marks and emits nothing: going live never replays what happened
 * before anyone listened. Each later one emits each new fact of the kinds
 * the listen asked for once, oldest first per kind, and sets the mark of a
 * kind the cursor has none for, emitting nothing of it.
 */
export async function pollSystemEvents(records: SystemRecords, input: PollEdgeInput, settings: SystemPollSettings = DEFAULT_POLL_SETTINGS, now: number = Date.now()): Promise<PollEdgeAnswer> {
  if (input.edge !== EVENTS_EDGE) throw new Error(`@lf/system: no edge ${input.edge} to poll (its one edge is ${EVENTS_EDGE})`);
  const taken = kindsTaken(input.filter);
  const asked = (kind: SystemEventKind) => taken === undefined || taken.includes(kind);
  const previous = cursorOf(input.cursor);
  const until = new Date(now - settings.settleSeconds * 1000).toISOString();
  const limit = settings.pageSize;
  const takenApplied = taken !== undefined;

  // A source arms where it is first asked for, whenever that is: the first
  // poll arms each of them, and a later one arms one a cursor lacks (a kind
  // this module learned after the cursor was made).
  const next: SystemCursor = { ...previous };
  if (asked(RUN_FAILED)) next.failed ??= { at: until, runId: NIL_ID };
  if (asked(RUN_PAUSED)) next.paused ??= { at: until, runId: NIL_ID };
  if (asked(WAIT_LOST_ITS_RECORD)) next.stranded ??= { at: until, waitId: NIL_ID };
  if (asked(RELEASE_APPLIED)) next.releases ??= { at: until, version: '' };
  if (asked(ARRIVAL_NOT_JUDGED)) next.unjudged ??= { at: until, listen: '', arrival: '', attempt: 0 };
  if (previous === undefined) return { arrivals: [], cursor: next };

  const arrivals: Arrival[] = [];
  const webBaseUrl = asked(RUN_FAILED) || asked(RUN_PAUSED) ? await records.webBaseUrl() : null;
  const settledKinds = [
    [RUN_FAILED, 'failed', records.failedRuns.bind(records)],
    [RUN_PAUSED, 'paused', records.pausedRuns.bind(records)],
  ] as const;
  for (const [kind, member, read] of settledKinds) {
    const mark = previous[member];
    if (!asked(kind) || mark === undefined) continue;
    const runs = await read({ after: mark, until, limit });
    const last = runs.at(-1);
    if (last !== undefined) next[member] = { at: last.at, runId: last.runId };
    // A run no program owns, or a rehearsal: the mark passes it, nothing is said.
    for (const run of runs) if (run.automation !== null && !run.rehearsal) arrivals.push(runEvent(kind, run, webBaseUrl, takenApplied));
  }
  if (asked(WAIT_LOST_ITS_RECORD) && previous.stranded !== undefined) {
    // Stranded waits are read without an upper bound; one inside the settle
    // window waits for the next poll, and so does every one after it.
    const waits = await records.strandedWaits({ after: previous.stranded, limit });
    const settled = waits.slice(0, firstPast(waits, until));
    const last = settled.at(-1);
    if (last !== undefined) next.stranded = { at: last.at, waitId: last.waitId };
    for (const wait of settled) arrivals.push(waitEvent(wait, takenApplied));
  }
  if (asked(RELEASE_APPLIED) && previous.releases !== undefined) {
    const releases = await records.releases({ after: previous.releases, limit });
    const settled = releases.slice(0, firstPast(releases, until));
    const last = settled.at(-1);
    if (last !== undefined) next.releases = { at: last.at, version: last.version };
    for (const release of settled) {
      arrivals.push(event({ kind: RELEASE_APPLIED, id: `${RELEASE_APPLIED.id}:${release.version}`, at: release.at, fields: { Version: release.version, Reason: `release ${release.version} is running` }, taken: takenApplied }));
    }
  }
  if (asked(ARRIVAL_NOT_JUDGED) && previous.unjudged !== undefined) {
    const unjudged = await records.unjudgedArrivals({ after: previous.unjudged, limit });
    const settled = unjudged.slice(0, firstPast(unjudged, until));
    const last = settled.at(-1);
    if (last !== undefined) next.unjudged = { at: last.at, listen: last.listen, arrival: last.arrival, attempt: last.attempt };
    for (const one of settled) {
      if (isUnjudgedReport(one)) {
        console.warn(`@lf/system: ${one.automation.id} could not judge the Arrival Not Judged event ${one.recordId ?? ''} (${one.reason}); not reported, so no listen is told of another's report about it`);
        continue;
      }
      arrivals.push(unjudgedEvent(one, takenApplied));
    }
  }
  return { arrivals, cursor: next };
}

/** Whether the arrival a listen could not judge is itself one of this
 *  module's `Arrival Not Judged` events (its record is the event, its id one
 *  this module minted). It is never reported in turn: two listens on `Events`
 *  that cannot judge such events would report each other's without end, once
 *  a poll, and no run would ever start for the loop breaker to count. */
function isUnjudgedReport(unjudged: UnjudgedArrival): boolean {
  return unjudged.edge === EVENTS_EDGE && (unjudged.recordId ?? '').startsWith(`${ARRIVAL_NOT_JUDGED.id}:`);
}

/** The index of the first row past `until`, else the length. */
function firstPast(rows: ReadonlyArray<{ at: string }>, until: string): number {
  const at = rows.findIndex((row) => Date.parse(row.at) > Date.parse(until));
  return at < 0 ? rows.length : at;
}
