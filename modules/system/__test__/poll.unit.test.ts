// The system poll over a host's facts, held in memory: what a first poll
// arms, what each later poll emits, and what it leaves for the next.

import { DEFAULT_POLL_SETTINGS, pollSystemEvents, type SystemCursor } from '../poll';
import type { Release, SettledRun, StrandedWait, SystemRecords, UnjudgedArrival } from '../records';

const T0 = Date.parse('2026-10-31T10:00:00.000Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
const SETTINGS = { settleSeconds: 10, pageSize: 100 };

function failed(runId: string, seconds: number, listen: string | null = null): SettledRun {
  return { runId, automation: { id: `ops:${runId}`, name: runId }, listen, rehearsal: false, reason: `${runId} broke`, at: at(seconds) };
}

/** A host's facts, each list kept oldest first, read as a store reads them. */
function records(facts: { failed?: SettledRun[]; stranded?: StrandedWait[]; releases?: Release[]; unjudged?: UnjudgedArrival[] }): SystemRecords {
  const after = <T extends { at: string }>(rows: T[] = [], mark: { at: string }, id: (row: T) => string, markId: string) =>
    rows.filter((row) => row.at > mark.at || (row.at === mark.at && id(row) > markId));
  return {
    failedRuns: async ({ after: mark, until, limit }) => after(facts.failed, mark, (r) => r.runId, mark.runId).filter((r) => r.at <= until).slice(0, limit),
    pausedRuns: async () => [],
    strandedWaits: async ({ after: mark, limit }) => after(facts.stranded, mark, (w) => w.waitId, mark.waitId).slice(0, limit),
    releases: async ({ after: mark, limit }) => after(facts.releases, mark, (r) => r.version, mark.version).slice(0, limit),
    unjudgedArrivals: async ({ after: mark, limit }) =>
      after(facts.unjudged, mark, (u) => `${u.listen} ${u.arrival} ${u.attempt}`, `${mark.listen} ${mark.arrival} ${mark.attempt ?? 0}`).slice(0, limit),
    webBaseUrl: async () => null,
  };
}

const RUN_FAILED_ONLY = { type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'Kind' }, right: { type: 'static', value: 'Run Failed' } };
const field = (arrival: object, name: string): unknown => Reflect.get(Object(Reflect.get(Object(Reflect.get(arrival, 'landing')), 'fields')), name);

describe('pollSystemEvents', () => {
  it('a first poll arms and emits nothing; the next emits each failed run once, oldest first, marked not for its own listen', async () => {
    const facts: { failed: SettledRun[] } = { failed: [failed('run-old', -60)] };
    const host = records(facts);
    const first = await pollSystemEvents(host, { edge: 'Events', filter: RUN_FAILED_ONLY }, SETTINGS, T0);
    expect(first.arrivals).toEqual([]);
    expect((first.cursor as SystemCursor).failed).toEqual({ at: at(-10), runId: '00000000-0000-0000-0000-000000000000' });

    facts.failed.push(failed('run-b', 5, 'listen:ops:report:0a1b2c3d'), failed('run-a', 3));
    facts.failed.sort((x, y) => (x.at < y.at ? -1 : 1));
    const second = await pollSystemEvents(host, { edge: 'Events', filter: RUN_FAILED_ONLY, cursor: first.cursor }, SETTINGS, T0 + 30_000);
    expect(second.arrivals.map((a) => field(a, 'Run Id'))).toEqual(['run-a', 'run-b']);
    const [, b] = second.arrivals;
    expect(b).toMatchObject({ edge: 'Events', notFor: 'listen:ops:report:0a1b2c3d', about: { recordType: 'Run', externalId: 'run-b' }, takenApplied: true, occurredAt: at(5) });
    expect(field(b, 'Kind')).toBe('Run Failed');
    expect(field(b, 'Reason')).toBe('run-b broke');
    expect(field(b, 'Record Id')).toBe('');
    expect(second.arrivals[0]).not.toHaveProperty('notFor');

    const third = await pollSystemEvents(host, { edge: 'Events', filter: RUN_FAILED_ONLY, cursor: second.cursor }, SETTINGS, T0 + 90_000);
    expect(third.arrivals).toEqual([]);
  });

  it('a stranded wait becomes one Wait Lost Its Record, with Adapter, Edge and Record Id set', async () => {
    const stranded: StrandedWait[] = [];
    const host = records({ stranded });
    const kinds = { type: 'compare', op: 'in', left: { type: 'property', propertyTypeId: 'Kind' }, right: { type: 'static', value: ['Wait Lost Its Record', 'Run Paused'] } };
    const first = await pollSystemEvents(host, { edge: 'Events', filter: kinds }, SETTINGS, T0);
    expect(first.cursor).not.toHaveProperty('failed');
    stranded.push({ waitId: 'w-1', runId: 'run-1', automation: { id: 'chat:decide', name: 'decide' }, listen: 'listen:chat:decide:00ff00ff', adapter: 'slack', edge: 'Interactions', recordId: 'C1:1730.1', at: at(2) });
    const next = await pollSystemEvents(host, { edge: 'Events', filter: kinds, cursor: first.cursor }, SETTINGS, T0 + 60_000);
    expect(next.arrivals).toHaveLength(1);
    const [lost] = next.arrivals;
    expect([field(lost, 'Kind'), field(lost, 'Adapter'), field(lost, 'Edge'), field(lost, 'Record Id'), field(lost, 'Automation'), field(lost, 'Run Id')]).toEqual(['Wait Lost Its Record', 'slack', 'Interactions', 'C1:1730.1', 'decide', 'run-1']);
    expect(lost).toMatchObject({ notFor: 'listen:chat:decide:00ff00ff', about: { recordType: 'Run', externalId: 'run-1' } });
  });

  it('a listen that could not judge an arrival becomes one Arrival Not Judged, named by the listen and the arrival, never told to that listen', async () => {
    const unjudged: UnjudgedArrival[] = [];
    const host = records({ unjudged });
    const kind = { type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'Kind' }, right: { type: 'static', value: 'Arrival Not Judged' } };
    const first = await pollSystemEvents(host, { edge: 'Events', filter: kind }, SETTINGS, T0);
    expect((first.cursor as SystemCursor).unjudged).toEqual({ at: at(-10), listen: '', arrival: '', attempt: 0 });
    const heard: UnjudgedArrival = {
      listen: 'listen:chat:heard:0a1b2c3d',
      arrival: 'Messages:C1:C1:1700.1:',
      automation: { id: 'chat:heard', name: 'heard' },
      deliveryId: 'delivery-1',
      edge: 'Messages',
      recordId: 'C1:1700.1',
      reason: "slack could not read Name of the Channels record the arrival carries, which this listen's filter reads",
      cause: null,
      at: at(2),
      attempt: 0,
    };
    unjudged.push(heard, { ...heard, listen: 'listen:chat:other:00ff00ff', automation: { id: 'chat:other', name: 'other' }, cause: 'run-7', at: at(3) });
    const next = await pollSystemEvents(host, { edge: 'Events', filter: kind, cursor: first.cursor }, SETTINGS, T0 + 60_000);
    expect(next.arrivals).toHaveLength(2);
    const [one, two] = next.arrivals;
    expect(one).toMatchObject({ identity: 'arrival_not_judged:listen:chat:heard:0a1b2c3d:Messages:C1:C1:1700.1::0', notFor: 'listen:chat:heard:0a1b2c3d', takenApplied: true, occurredAt: at(2) });
    expect(one).not.toHaveProperty('about');
    expect(['Kind', 'Automation', 'Automation Id', 'Edge', 'Record Id', 'Listen', 'Delivery Id', 'Arrival Id', 'Attempt', 'Run Id'].map((name) => field(one, name))).toEqual([
      'Arrival Not Judged',
      'heard',
      'chat:heard',
      'Messages',
      'C1:1700.1',
      'listen:chat:heard:0a1b2c3d',
      'delivery-1',
      'Messages:C1:C1:1700.1:',
      0,
      '',
    ]);
    expect(field(one, 'Reason')).toBe(heard.reason);
    // A run's write that caused the arrival: the event is about that run, so its chain continues.
    expect(two).toMatchObject({ about: { recordType: 'Run', externalId: 'run-7' }, notFor: 'listen:chat:other:00ff00ff' });
    const again = await pollSystemEvents(host, { edge: 'Events', filter: kind, cursor: next.cursor }, SETTINGS, T0 + 120_000);
    expect(again.arrivals).toEqual([]);
    // A replay that still cannot judge it is an attempt of its own, reported once more.
    unjudged.push({ ...heard, at: at(70), attempt: 1 });
    const replayed = await pollSystemEvents(host, { edge: 'Events', filter: kind, cursor: again.cursor }, SETTINGS, T0 + 180_000);
    expect(replayed.arrivals.map((a) => Reflect.get(a, 'identity'))).toEqual(['arrival_not_judged:listen:chat:heard:0a1b2c3d:Messages:C1:C1:1700.1::1']);
    expect((replayed.cursor as SystemCursor).unjudged).toMatchObject({ at: at(70), attempt: 1 });
    expect(field(replayed.arrivals[0]!, 'Attempt')).toBe(1);

    // A listen on Events that cannot judge an Arrival Not Judged event is not
    // reported in turn: two such listens would report each other's without end.
    const report = 'arrival_not_judged:listen:chat:other:00ff00ff:Messages:C1:C1:1700.1::0';
    const warned = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      unjudged.push({ ...heard, edge: 'Events', recordId: report, arrival: `Events::${report}:`, at: at(130) });
      const looped = await pollSystemEvents(host, { edge: 'Events', filter: kind, cursor: replayed.cursor }, SETTINGS, T0 + 240_000);
      expect(looped.arrivals).toEqual([]);
      expect((looped.cursor as SystemCursor).unjudged).toMatchObject({ at: at(130) });
      expect(warned).toHaveBeenCalledWith(expect.stringContaining(`could not judge the Arrival Not Judged event ${report}`));
    } finally {
      warned.mockRestore();
    }
  });

  it('rows inside the settle window wait for the next poll', async () => {
    const stranded: StrandedWait[] = [];
    const facts = { failed: [] as SettledRun[], stranded };
    const host = records(facts);
    const first = await pollSystemEvents(host, { edge: 'Events' }, SETTINGS, T0);
    facts.failed.push(failed('run-settled', 15), failed('run-fresh', 25));
    stranded.push({ waitId: 'w-fresh', runId: 'run-x', automation: null, listen: null, adapter: 'acme', edge: 'Notes', recordId: null, at: at(26) });
    const early = await pollSystemEvents(host, { edge: 'Events', cursor: first.cursor }, SETTINGS, T0 + 30_000);
    expect(early.arrivals.map((a) => field(a, 'Run Id'))).toEqual(['run-settled']);
    expect(early.arrivals[0]).not.toHaveProperty('takenApplied');
    const later = await pollSystemEvents(host, { edge: 'Events', cursor: early.cursor }, SETTINGS, T0 + 40_000);
    expect(later.arrivals.map((a) => [field(a, 'Kind'), field(a, 'Run Id')])).toEqual([
      ['Run Failed', 'run-fresh'],
      ['Wait Lost Its Record', 'run-x'],
    ]);
  });

  it('a rehearsal failing, or a run no program owns, passes the mark and is not reported', async () => {
    const facts = { failed: [] as SettledRun[] };
    const host = records(facts);
    const first = await pollSystemEvents(host, { edge: 'Events', filter: RUN_FAILED_ONLY }, SETTINGS, T0);
    facts.failed.push({ ...failed('dry', 1), rehearsal: true }, { ...failed('orphan', 2), automation: null });
    const next = await pollSystemEvents(host, { edge: 'Events', filter: RUN_FAILED_ONLY, cursor: first.cursor }, SETTINGS, T0 + 60_000);
    expect(next.arrivals).toEqual([]);
    expect((next.cursor as SystemCursor).failed).toEqual({ at: at(2), runId: 'orphan' });
  });

  it('a kind the cursor has no mark for is armed where it is first asked for, and reports nothing from before', async () => {
    const facts = { failed: [failed('run-a', 3)], releases: [{ version: '0.13.0', at: at(-40) }] as Release[] };
    const host = records(facts);
    const onlyFailed = await pollSystemEvents(host, { edge: 'Events', filter: RUN_FAILED_ONLY }, SETTINGS, T0);
    expect(onlyFailed.cursor).not.toHaveProperty('releases');
    // The same poll key now asks every kind: the module learned one after the cursor was made.
    const widened = await pollSystemEvents(host, { edge: 'Events', cursor: onlyFailed.cursor }, SETTINGS, T0 + 60_000);
    expect(widened.arrivals.map((a) => field(a, 'Kind'))).toEqual(['Run Failed']);
    expect((widened.cursor as SystemCursor).releases).toEqual({ at: at(50), version: '' });
    expect((widened.cursor as SystemCursor).stranded).toEqual({ at: at(50), waitId: '00000000-0000-0000-0000-000000000000' });
    facts.releases.push({ version: '0.14.0', at: at(70) });
    const next = await pollSystemEvents(host, { edge: 'Events', cursor: widened.cursor }, SETTINGS, T0 + 120_000);
    expect(next.arrivals.map((a) => [field(a, 'Kind'), field(a, 'Version')])).toEqual([['Release Applied', '0.14.0']]);
  });

  it('with the default settle lag, a release noted just before the first poll is reported by the next, and an older one never is', async () => {
    const releases: Release[] = [{ version: '0.12.0', at: at(-3600) }, { version: '0.13.0', at: at(-2) }];
    const host = records({ releases });
    const first = await pollSystemEvents(host, { edge: 'Events' }, DEFAULT_POLL_SETTINGS, T0);
    expect(first.arrivals).toEqual([]);
    const next = await pollSystemEvents(host, { edge: 'Events', cursor: first.cursor }, DEFAULT_POLL_SETTINGS, T0 + 60_000);
    expect(next.arrivals.map((a) => [field(a, 'Kind'), field(a, 'Version')])).toEqual([['Release Applied', '0.13.0']]);
  });

  it('a Run Failed event links to the failed runs of its program; a run the host links itself keeps its link', async () => {
    const facts = { failed: [] as SettledRun[] };
    const base = { ...records(facts), webBaseUrl: async () => 'https://app.example/' };
    const first = await pollSystemEvents(base, { edge: 'Events', filter: RUN_FAILED_ONLY }, SETTINGS, T0);
    facts.failed.push(failed('run-a', 3), { ...failed('run-b', 4), url: 'https://elsewhere/run-b' });
    const next = await pollSystemEvents(base, { edge: 'Events', filter: RUN_FAILED_ONLY, cursor: first.cursor }, SETTINGS, T0 + 60_000);
    expect(next.arrivals.map((a) => field(a, 'Url'))).toEqual(['https://app.example/movements/ops%3Arun-a?view=activity&status=failed', 'https://elsewhere/run-b']);
  });
});
