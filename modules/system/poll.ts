// The system poll: the platform's own events, read from what the platform
// already records. `Run Failed` comes from its runs, the other kinds from the
// events it stores as they happen (a pause, the deploy check's three). The
// host hands both readers in (`SystemRecords`); the poll keeps the marks,
// picks the kinds a listen selected and shapes each event.
//
// WHY A POLL, NOT A PUSH. A run is marked failed by several independent writers
// (the run recorder, Run now's settle, the interaction failure path, a cancel),
// none of which goes through a shared queue. Hooking each one would be a seam
// per writer and a silent gap the day a fifth appears. The run table is where
// every one of them lands, so a poll over it since a checkpoint catches all of
// them uniformly — at the price of a minute or two of latency, which a failure
// notice can afford.
//
// An automation is never told about its own failures: a handler that fails
// while reporting a failure would otherwise report itself, forever. The host
// hands the listening automation's id in, and its own runs are skipped (the
// checkpoint still passes them, so they are never reconsidered). The platform
// names the listener by its movement's id; lf names it by the movement its
// listen fires, so a run lf recorded carries that movement too.
//
// Each event carries its kind's natural name as its `eventType` (adapter
// protocol 2.3: a source labels its poll events). It is the name a listen's
// `events:` selects with, so a host that narrows a listen's events by it
// passes exactly what the poll chose.

import type { DiscriminableEvent } from 'movement-engine/public/adapter';
import type { PollAnswer, PollInput } from 'module-kit';

import { eventConfigList } from 'movement-engine/public/inbound';
import {
  RUN_FAILED,
  RUN_PAUSED,
  SYSTEM_EVENT_KINDS,
  type SystemEventKind,
  type SystemEventPayload,
} from './types';

/** The platform's own table is cheap to read; a failure notice should not wait
 *  five minutes. Overridable per listen. */
export const SYSTEM_POLL_INTERVAL_SECONDS = 60;

/** A run's failure time is stamped before its row commits, so a row can appear
 *  with a time already behind the mark. Reading only rows older than this
 *  keeps the mark behind every write still in flight. */
const SETTLE_MS = 10_000;

/** Rows per poll. More than this waits for the next poll rather than
 *  delivering a flood in one tick. */
const PAGE_SIZE = 100;

/** The lowest id, for a mark that has no row at its instant yet. */
const NIL_ID = '00000000-0000-0000-0000-000000000000';

/** Where the last poll stopped in the failed runs: the (failed at, run id) of
 *  the last run it passed. Ordered on both so runs failing in the same
 *  millisecond are neither skipped nor delivered twice. */
export interface RunFailedMark {
  failedAt: string;
  runId: string;
}

/** Where the last poll stopped in the stored events, ordered the same way. */
export interface StoredEventMark {
  occurredAt: string;
  id: string;
}

export interface SystemCheckpoint {
  runFailed?: RunFailedMark;
  /** One mark across the stored kinds — they share one table and one order. */
  stored?: StoredEventMark;
}

/** One failed run, with the automation it belongs to — null for a run no
 *  automation owns (a legacy or simulated run), which the mark still passes
 *  but nothing delivers, since there is nothing to name or link. */
export interface FailedRun {
  runId: string;
  automation: { id: string; name: string } | null;
  /** The movement the run's listen fired, for a run lf recorded: an lf poll
   *  names the listening automation by that movement alone. */
  firedMovement?: string;
  /** Where a person opens the run, when that is not the automation's failed
   *  runs (an lf run is not listed there). */
  url?: string;
  reason: string;
  failedAt: Date;
}

/** One stored platform event. */
export interface StoredSystemEvent {
  id: string;
  /** The kind's `typeId`. */
  kind: string;
  payload: SystemEventPayload;
  occurredAt: Date;
}

/** What the host keeps of the platform's own events, for one tenant. */
export interface SystemRecords {
  /** The tenant's failed runs strictly after `after`, no later than `until`,
   *  oldest first; rehearsals left out. */
  failedRuns(input: { tenant: string; after: RunFailedMark; until: Date; limit: number }): Promise<FailedRun[]>;
  /** The tenant's stored events of `kinds` (type ids) strictly after `after`,
   *  no later than `until`, oldest first. */
  storedEvents(input: { tenant: string; kinds: readonly string[]; after: StoredEventMark; until: Date; limit: number }): Promise<StoredSystemEvent[]>;
  /** The web app's base URL, which an event's `Url` links into. */
  webBaseUrl(): string;
}

/** A failed run that belongs to an automation — the only kind delivered. */
type OwnedFailedRun = FailedRun & { automation: { id: string; name: string } };

/** The kinds read from the stored events rather than the runs. */
const STORED_KINDS: readonly SystemEventKind[] = SYSTEM_EVENT_KINDS.filter((kind) => kind !== RUN_FAILED);

function runFailedMark(checkpoint: unknown): RunFailedMark | undefined {
  const mark = (checkpoint as SystemCheckpoint | null | undefined)?.runFailed;
  return typeof mark?.failedAt === 'string' && typeof mark.runId === 'string' ? mark : undefined;
}

function storedMark(checkpoint: unknown): StoredEventMark | undefined {
  const mark = (checkpoint as SystemCheckpoint | null | undefined)?.stored;
  return typeof mark?.occurredAt === 'string' && typeof mark.id === 'string' ? mark : undefined;
}

/** The kinds a listen selected — `Run Failed` alone when it selected nothing
 *  (the manifest's default). */
function selectedKinds(config: unknown): SystemEventKind[] {
  const selected = eventConfigList((config as { events?: unknown } | null | undefined)?.events);
  if (selected.length === 0) return [RUN_FAILED];
  return SYSTEM_EVENT_KINDS.filter((kind) => selected.includes(kind.displayName));
}

/** The automation's run history, filtered to its failures — the page a person
 *  opens to see this run beside the others. */
export function failedRunsUrl(webBaseUrl: string, automationId: string): string {
  return `${webBaseUrl.replace(/\/$/, '')}/movements/${encodeURIComponent(automationId)}?view=activity&status=failed`;
}

export function runFailedEvent(run: OwnedFailedRun, webBaseUrl: string): DiscriminableEvent {
  const at = run.failedAt.toISOString();
  const payload: SystemEventPayload = {
    automation: run.automation.name,
    automationId: run.automation.id,
    runId: run.runId,
    // A failed run's version is not what went wrong; the field is part of the
    // one record shape every kind shares.
    version: '',
    reason: run.reason,
    url: run.url ?? failedRunsUrl(webBaseUrl, run.automation.id),
    at,
  };
  return {
    payload,
    externalId: run.runId,
    // Per-trigger receipt dedupe: a run is reported to a listener once, even if
    // a crash between dispatch and checkpoint replays the poll.
    idempotencyKey: `${RUN_FAILED.tag}:${run.runId}`,
    tag: RUN_FAILED.tag,
    eventType: RUN_FAILED.displayName,
    occurredAt: at,
  };
}

export function storedSystemEvent(event: StoredSystemEvent): DiscriminableEvent | null {
  const kind = STORED_KINDS.find((k) => k.typeId === event.kind);
  if (kind === undefined) return null;
  return {
    payload: event.payload,
    externalId: event.id,
    // Per-trigger receipt dedupe, as for a failed run.
    idempotencyKey: `${kind.tag}:${event.id}`,
    tag: kind.tag,
    eventType: kind.displayName,
    occurredAt: event.occurredAt.toISOString(),
  };
}

/** One poll for one tenant over the host's records. */
export async function pollSystemEvents(records: SystemRecords, tenant: string, input: PollInput): Promise<PollAnswer> {
  const previous = (input.checkpoint ?? {}) as SystemCheckpoint;
  const kinds = selectedKinds(input.config);
  const until = new Date(Date.now() - SETTLE_MS);

  const runFailed = kinds.includes(RUN_FAILED)
    ? await pollRunFailed(records, { tenant, mark: runFailedMark(input.checkpoint), until, movementId: input.movementId })
    : { events: [], mark: previous.runFailed };
  const storedKinds = kinds.filter((kind) => kind !== RUN_FAILED);
  const stored =
    storedKinds.length > 0
      ? await pollStored(records, { tenant, kinds: storedKinds, mark: storedMark(input.checkpoint), until, movementId: input.movementId })
      : { events: [], mark: previous.stored };

  return {
    events: [...runFailed.events, ...stored.events],
    checkpoint: {
      ...previous,
      ...(runFailed.mark !== undefined ? { runFailed: runFailed.mark } : {}),
      ...(stored.mark !== undefined ? { stored: stored.mark } : {}),
    },
  };
}

/** Whether a failed run is the listening automation's own: by the
 *  automation's id, or, for a run lf recorded, by the movement it fired. */
function isListenersOwn(run: OwnedFailedRun, movementId: string | undefined): boolean {
  if (movementId === undefined) return false;
  return run.automation.id === movementId || run.firedMovement === movementId;
}

async function pollRunFailed(
  records: SystemRecords,
  input: { tenant: string; mark: RunFailedMark | undefined; until: Date; movementId: string | undefined },
): Promise<{ events: DiscriminableEvent[]; mark: RunFailedMark }> {
  // First poll: set the mark and emit nothing. Going live never replays the
  // failures that happened before anyone was listening.
  if (input.mark === undefined) {
    return { events: [], mark: { failedAt: input.until.toISOString(), runId: NIL_ID } };
  }
  const runs = await records.failedRuns({ tenant: input.tenant, after: input.mark, until: input.until, limit: PAGE_SIZE });
  const last = runs[runs.length - 1];
  const webBaseUrl = records.webBaseUrl();
  return {
    events: runs
      .filter((run): run is OwnedFailedRun => run.automation !== null)
      .filter((run) => !isListenersOwn(run, input.movementId))
      .map((run) => runFailedEvent(run, webBaseUrl)),
    mark: last === undefined ? input.mark : { failedAt: last.failedAt.toISOString(), runId: last.runId },
  };
}

async function pollStored(
  records: SystemRecords,
  input: { tenant: string; kinds: readonly SystemEventKind[]; mark: StoredEventMark | undefined; until: Date; movementId: string | undefined },
): Promise<{ events: DiscriminableEvent[]; mark: StoredEventMark }> {
  // First poll: set the mark and emit nothing, as for failed runs.
  if (input.mark === undefined) {
    return { events: [], mark: { occurredAt: input.until.toISOString(), id: NIL_ID } };
  }
  // An automation IS told about its own validation issue: unlike a failure,
  // hearing about it cannot produce another one. A pause is like a failure:
  // a handler that paused while reporting a pause would report itself, so an
  // automation is never told about its own runs pausing.
  const events = await records.storedEvents({
    tenant: input.tenant,
    kinds: input.kinds.map((kind) => kind.typeId),
    after: input.mark,
    until: input.until,
    limit: PAGE_SIZE,
  });
  const last = events[events.length - 1];
  return {
    events: events.flatMap((event) => {
      if (event.kind === RUN_PAUSED.typeId && event.payload.automationId === input.movementId) return [];
      const discriminable = storedSystemEvent(event);
      return discriminable === null ? [] : [discriminable];
    }),
    mark: last === undefined ? input.mark : { occurredAt: last.occurredAt.toISOString(), id: last.id },
  };
}
