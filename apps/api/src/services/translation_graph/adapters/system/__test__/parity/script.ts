// The script recorded parity drives for `system`: the whole read surface an
// author's movement touches, and the poll over a fixed world of failed runs
// and stored platform events. The world is read through two readers that log
// every question asked of them, so a replay must ask the platform the same
// questions as well as give the same answers.

import type { Adapter, DiscriminableEvent } from 'movement-engine/public/adapter';

import { makeMetaPosition, makeUnstablePosition } from 'movement-engine/public/catalog';

/** A failed run as the platform reads it (the run table joined to its automation). */
export interface WorldFailedRun {
  runId: string;
  automation: { id: string; name: string } | null;
  reason: string;
  failedAt: Date;
}

/** A stored platform event (the deploy check's, a pause). */
export interface WorldStoredEvent {
  id: string;
  kind: string;
  payload: Record<string, string>;
  occurredAt: Date;
}

export interface FailedRunQuery {
  teamId: string;
  after: { failedAt: string; runId: string };
  until: Date;
  limit: number;
}

export interface StoredEventQuery {
  teamId: string;
  kinds: readonly string[];
  after: { occurredAt: string; id: string };
  until: Date;
  limit: number;
}

/** The platform's two readers over the world, logging each question. */
export function worldReaders(log: unknown[]): {
  readFailedRuns(input: FailedRunQuery): Promise<WorldFailedRun[]>;
  readStoredEvents(input: StoredEventQuery): Promise<WorldStoredEvent[]>;
} {
  return {
    readFailedRuns: async (input) => {
      log.push({ reader: 'failedRuns', input: plain(input) });
      const after = new Date(input.after.failedAt).getTime();
      return FAILED_RUNS.filter((run) => {
        const at = run.failedAt.getTime();
        return at <= input.until.getTime() && (at > after || (at === after && run.runId > input.after.runId));
      }).slice(0, input.limit);
    },
    readStoredEvents: async (input) => {
      log.push({ reader: 'storedEvents', input: plain(input) });
      const after = new Date(input.after.occurredAt).getTime();
      return STORED_EVENTS.filter((event) => {
        const at = event.occurredAt.getTime();
        return (
          input.kinds.includes(event.kind) &&
          at <= input.until.getTime() &&
          (at > after || (at === after && event.id > input.after.id))
        );
      }).slice(0, input.limit);
    },
  };
}

/** The clock every poll reads. */
export const PARITY_NOW = new Date('2026-09-29T12:00:00.000Z');

const FAILED_RUNS: WorldFailedRun[] = [
  { runId: 'run-a', automation: { id: 'mov-crm', name: 'Sync CRM' }, reason: 'Attio refused the write: 403', failedAt: new Date('2026-09-29T11:51:00.000Z') },
  { runId: 'run-b', automation: { id: 'mov-alerts', name: 'Alerts' }, reason: 'own failure', failedAt: new Date('2026-09-29T11:52:00.000Z') },
  { runId: 'run-c', automation: null, reason: 'legacy run', failedAt: new Date('2026-09-29T11:53:00.000Z') },
  { runId: 'run-d', automation: { id: 'mov-crm', name: 'Sync CRM' }, reason: 'timeout', failedAt: new Date('2026-09-29T11:59:55.000Z') },
];

function payload(over: Partial<Record<string, string>>): Record<string, string> {
  return { automation: 'Sync CRM', automationId: 'mov-crm', runId: '', version: '', reason: 'r', url: 'http://web/movements/mov-crm', at: '2026-09-29T11:54:00.000Z', ...over };
}

const STORED_EVENTS: WorldStoredEvent[] = [
  { id: 'e-1', kind: 'validation_issue', payload: payload({ version: '0.12.0', reason: 'fix the listen' }), occurredAt: new Date('2026-09-29T11:54:00.000Z') },
  { id: 'e-2', kind: 'run_paused', payload: payload({ automationId: 'mov-alerts', reason: 'cost cap' }), occurredAt: new Date('2026-09-29T11:55:00.000Z') },
  { id: 'e-3', kind: 'run_paused', payload: payload({ reason: 'cost cap' }), occurredAt: new Date('2026-09-29T11:55:00.000Z') },
  { id: 'e-4', kind: 'release_applied', payload: payload({ automation: '', automationId: '', reason: 'v0.12' }), occurredAt: new Date('2026-09-29T11:56:00.000Z') },
  { id: 'e-5', kind: 'mystery_kind', payload: payload({}), occurredAt: new Date('2026-09-29T11:57:00.000Z') },
];

/** The poll as a subject offers it. */
export interface SubjectPoll {
  readonly pollIntervalSeconds: number;
  getEvents(input: { config: unknown; checkpoint?: unknown; movementId?: string }): Promise<{ events: DiscriminableEvent[]; checkpoint?: unknown }>;
}

export interface SystemParitySubject {
  adapter: Adapter;
  poll: SubjectPoll;
}

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

const NAMES = ['Run Failed', 'Run Paused', 'Validation Issue', 'Deprecated Version', 'Release Applied'];

const MARK = { runFailed: { failedAt: '2026-09-29T11:50:00.000Z', runId: '00000000-0000-0000-0000-000000000000' }, stored: { occurredAt: '2026-09-29T11:50:00.000Z', id: '00000000-0000-0000-0000-000000000000' } };

export async function runSystemParityScript(subject: SystemParitySubject): Promise<TranscriptEntry[]> {
  const transcript: TranscriptEntry[] = [];
  const step = async (name: string, call: () => Promise<unknown>): Promise<void> => {
    try {
      transcript.push({ step: name, answer: plain(await call()) });
    } catch (error) {
      transcript.push({ step: name, answer: { error: error instanceof Error ? error.message : String(error) } });
    }
  };
  const { adapter, poll } = subject;

  await step('adapterType', async () => adapter.adapterType);
  await step('supportedTriggers', async () => adapter.supportedTriggers);
  await step('listEntryPoints', () => adapter.listEntryPoints());
  await step('edgesFrom root', async () => adapter.edgesFrom?.(makeMetaPosition('system')));
  for (const name of [...NAMES, 'run_failed', 'release_applied', 'Nope']) {
    await step(`describe ${name}`, () => adapter.describe(name));
  }
  await step('listEventTypes', async () => adapter.listEventTypes?.());
  const position = makeUnstablePosition({ adapterType: 'system', recordType: 'Run Failed', data: { reason: 'boom', url: 'http://x/m', at: '2026-09-29T11:00:00.000Z' } });
  for (const field of ['Reason', 'reason', 'Url', 'At', 'Run Id', 'Missing']) {
    await step(`getFieldValue ${field}`, () => adapter.getFieldValue({ position, fieldId: field }));
  }
  await step('getFieldValue foreign', () =>
    adapter.getFieldValue({ position: makeUnstablePosition({ adapterType: 'attio', recordType: 'x', data: {} }), fieldId: 'Reason' }),
  );

  await step('pollIntervalSeconds', async () => poll.pollIntervalSeconds);
  await step('poll first (default kinds)', () => poll.getEvents({ config: {}, movementId: 'mov-alerts' }));
  await step('poll first (all kinds)', () => poll.getEvents({ config: { events: NAMES }, movementId: 'mov-alerts' }));
  await step('poll Run Failed from mark', () => poll.getEvents({ config: {}, checkpoint: { runFailed: MARK.runFailed }, movementId: 'mov-alerts' }));
  await step('poll Run Failed without a listener', () => poll.getEvents({ config: { events: ['Run Failed'] }, checkpoint: { runFailed: MARK.runFailed } }));
  await step('poll stored kinds from mark', () =>
    poll.getEvents({ config: { events: ['Run Paused', 'Validation Issue', 'Release Applied'] }, checkpoint: MARK, movementId: 'mov-alerts' }),
  );
  await step('poll all kinds from mark', () => poll.getEvents({ config: { events: NAMES }, checkpoint: MARK, movementId: 'mov-alerts' }));
  await step('poll unknown kind only', () => poll.getEvents({ config: { events: ['Nope'] }, checkpoint: MARK }));
  await step('poll events as a string', () => poll.getEvents({ config: { events: 'Validation Issue' }, checkpoint: MARK }));
  await step('poll a malformed checkpoint', () => poll.getEvents({ config: {}, checkpoint: { runFailed: { failedAt: 1 } } }));
  return transcript;
}

/** As JSON carries it. */
function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}
