// The calls recorded parity makes, in order, against one Granola
// implementation. Each later call is built from what an earlier one answered,
// so the script walks the seeded notes the way a run would: describe the
// types, pull past meetings (bounded and not), read every field and the
// attendees of a landed note. The poll script polls the `Meetings` edge as the
// platform's shared poll does (adapter protocol 2.6) and derives each
// arrival's actor from the trigger event the platform builds for its run. The
// transcript is every answer, as JSON; two implementations agree when their
// transcripts and the requests they made are identical.

import type { Expression } from 'movement-lang/expression/types';
import type { Adapter } from 'movement-engine/public/adapter';
import type { EdgePoller } from '../../../../../poll_source/edge_poller';

import { makeMetaPosition } from 'movement-engine/public/catalog';
import { arrivalTriggerOf } from 'movement-engine/public/inbound';

export interface ParitySubject {
  adapter: Adapter;
  poll: EdgePoller;
}

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

const prop = (name: string): Expression => ({ type: 'property', propertyTypeId: name }) as Expression;
const value = (v: string | number | boolean | null): Expression => ({ type: 'static', value: v }) as Expression;
const cmp = (left: Expression, op: 'eq' | 'gte', right: Expression): Expression =>
  ({ type: 'compare', op, left, right }) as Expression;

/** A fixed cursor before every seeded note, so the poll has something to
 *  deliver and never reads the clock. */
const POLL_CURSOR = { updatedAfter: '2026-06-01T00:00:00.000Z' };
const EDGE = 'Meetings';

function json(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function stepper(transcript: TranscriptEntry[]) {
  return async <T>(name: string, call: () => Promise<T>, shape: (answer: T) => unknown = (answer) => answer): Promise<T | undefined> => {
    try {
      const answer = await call();
      transcript.push({ step: name, answer: json(shape(answer)) });
      return answer;
    } catch (error) {
      transcript.push({ step: name, answer: { error: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  };
}

export async function runParityScript(subject: Pick<ParitySubject, 'adapter'>): Promise<TranscriptEntry[]> {
  const { adapter } = subject;
  const transcript: TranscriptEntry[] = [];
  const step = stepper(transcript);
  const meetings = (name: string, extra: Partial<{ where: Expression; orderBy: { fieldId: string; direction: 'asc' | 'desc' }; limit: number }> = {}) =>
    step(name, () => adapter.getRelated({ position: makeMetaPosition('granola'), fieldId: 'Meetings', direction: 'outgoing', ...extra }));

  await step('listEntryPoints', () => adapter.listEntryPoints());
  for (const type of ['granola:note', 'Meeting Note', 'granola:attendee', 'Attendee', 'granola:workspace', 'Nonexistent']) {
    await step(`describe ${type}`, () => adapter.describe(type));
  }
  await step('edgesFrom meta', async () => adapter.edgesFrom?.(makeMetaPosition('granola')) ?? null);

  // The back-catalogue: the whole archive, then a pushed-down lower bound, a
  // bound that cannot be pushed (an equality), and a LIMIT that travels.
  const all = await meetings('Meetings');
  await meetings('Meetings WHERE Meeting Start >= 2026-07-01', { where: cmp(prop('Meeting Start'), 'gte', value('2026-07-01T00:00:00.000Z')) });
  await meetings('Meetings WHERE Title ==', { where: cmp(prop('Title'), 'eq', value('Series A sync')) });
  await meetings('Meetings LIMIT 1', { limit: 1 });
  await meetings('Meetings ORDER BY Updated At LIMIT 1', { orderBy: { fieldId: 'Updated At', direction: 'asc' }, limit: 1 });

  // Every landed note, newest first: each field by its display name (and one
  // by its id, one that does not exist), then its attendees and theirs.
  const FIELDS = [
    'Title', 'Summary', 'Transcript', 'Meeting Start', 'Meeting End', 'Organizer Email', 'Folder Names',
    'Note Owner Email', 'Note Owner Name', 'Created At', 'Updated At', 'Granola Note ID', 'granola_note_id', 'Nonexistent',
  ];
  for (const [index, landed] of (all ?? []).entries()) {
    for (const field of FIELDS) {
      await step(`Note ${index}.${field}`, () => adapter.getFieldValue({ position: landed.position, fieldId: field }));
    }
    const attendees = await step(`Note ${index} Attendees`, () => adapter.getRelated({ position: landed.position, fieldId: 'Attendees', direction: 'outgoing' }));
    await step(`Note ${index} incoming`, () => adapter.getRelated({ position: landed.position, fieldId: 'Attendees', direction: 'incoming' }));
    for (const [at, attendee] of (attendees ?? []).entries()) {
      for (const field of ['Email', 'Name', 'Nonexistent']) {
        await step(`Note ${index} Attendee ${at}.${field}`, () => adapter.getFieldValue({ position: attendee.position, fieldId: field }));
      }
    }
  }

  return transcript;
}

export async function runPollScript(subject: ParitySubject): Promise<TranscriptEntry[]> {
  const { adapter } = subject;
  const transcript: TranscriptEntry[] = [];
  const step = stepper(transcript);

  // The first look sets a mark from the clock, so only its shape is kept;
  // every other poll starts from a fixed cursor.
  await step('poll first look', () => subject.poll({ edge: EDGE }), (answer) => ({
    arrivals: answer.arrivals,
    cursor: typeof (answer.cursor as { updatedAfter?: unknown } | undefined)?.updatedAfter,
  }));
  await step('poll from a cursor', () => subject.poll({ edge: EDGE, cursor: POLL_CURSOR }));
  await step('poll taking Title ==', () =>
    subject.poll({ edge: EDGE, filter: cmp(prop('Title'), 'eq', value('Series A sync')), cursor: POLL_CURSOR }),
  );
  await step('poll past the newest', () => subject.poll({ edge: EDGE, cursor: { updatedAfter: '2026-09-01T00:00:00.000Z' } }));
  await step('poll an edge that is not polled', () => subject.poll({ edge: 'Attendees', cursor: POLL_CURSOR }));

  // The actor, from the trigger event the platform starts each arrival's run
  // with (inbound/fire_event.ts).
  const delivered = await subject.poll({ edge: EDGE, cursor: POLL_CURSOR });
  for (const [index, arrival] of delivered.arrivals.flatMap((a) => ('gone' in a ? [] : [a])).entries()) {
    const event = arrivalTriggerOf({
      pipelineInputId: `parity-${index}`,
      adapterType: 'granola',
      arrival,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    await step(`extractActor ${index}`, async () => (await adapter.extractActor?.({ event })) ?? null);
    await step(`getActorCandidates ${index}`, async () => (await adapter.getActorCandidates?.({ event })) ?? null);
  }
  return transcript;
}
