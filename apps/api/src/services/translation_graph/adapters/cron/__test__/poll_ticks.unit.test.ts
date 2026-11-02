// The cron unit's poll of `Ticks` (adapter protocol 2.6): the schedule and
// zone come in the taken filter, a first poll only arms, a backlog collapses
// to its latest occurrence, and each occurrence is one arrival, identified by
// itself. listen-fire's own unit answers the same (crates/lf/src/units.rs).

import { CRON_TICKS_EDGE, pollTicks, valuesOf } from '../index';

const MINUTE = 60_000;
const on = (field: string, value: string) => ({ type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: field }, right: { type: 'static', value } });
const and = (...operands: unknown[]) => ({ type: 'logical', op: 'and', operands });

describe('the schedule a poll names', () => {
  it('reads ==, IN and an OR of == on a field, by name or id', () => {
    expect(valuesOf(on('Schedule', '0 9 * * 1'), { name: 'Schedule', id: 'schedule' })).toEqual(['0 9 * * 1']);
    expect(valuesOf(on('schedule', '0 9 * * 1'), { name: 'Schedule', id: 'schedule' })).toEqual(['0 9 * * 1']);
    const listed = { type: 'compare', op: 'in', left: { type: 'property', propertyTypeId: 'Schedule' }, right: { type: 'static', value: ['0 9 * * 1', '0 17 * * 5'] } };
    expect(valuesOf(listed, { name: 'Schedule', id: 'schedule' })).toEqual(['0 9 * * 1', '0 17 * * 5']);
    const either = { type: 'logical', op: 'or', operands: [on('Schedule', 'a'), on('Schedule', 'b')] };
    expect(valuesOf(either, { name: 'Schedule', id: 'schedule' })).toEqual(['a', 'b']);
    expect(valuesOf(and(on('Schedule', 'a'), on('Zone', 'Europe/London')), { name: 'Zone', id: 'zone' })).toEqual(['Europe/London']);
    expect(valuesOf(on('Other', 'a'), { name: 'Zone', id: 'zone' })).toBeUndefined();
    // As a listen's plan has it: the edge's own field.
    const planned = { op: 'eq', left: { type: 'edge_property', fieldOnly: true, propertyTypeId: 'Schedule' }, type: 'compare', right: { type: 'static', value: '* * * * *' } };
    expect(valuesOf(planned, { name: 'Schedule', id: 'schedule' })).toEqual(['* * * * *']);
  });
});

describe('a poll of Ticks', () => {
  const filter = on('Schedule', '*/5 * * * *');
  const clock = (iso: string) => ({ now: new Date(iso), everyMs: MINUTE });

  it('first poll arms: no arrivals, the cursor is now', () => {
    expect(pollTicks({ edge: CRON_TICKS_EDGE, filter }, clock('2026-11-02T10:02:00.000Z'))).toEqual({
      answer: { arrivals: [], cursor: '2026-11-02T10:02:00.000Z' },
      unread: [],
    });
  });

  it('answers each occurrence since the cursor, one arrival each, filtered by the unit', () => {
    const { answer } = pollTicks({ edge: CRON_TICKS_EDGE, filter, cursor: '2026-11-02T10:04:30.000Z' }, clock('2026-11-02T10:05:10.000Z'));
    expect(answer).toEqual({
      arrivals: [
        {
          edge: CRON_TICKS_EDGE,
          identity: 'tick:*/5 * * * *:UTC:2026-11-02T10:05:00.000Z',
          landing: { recordType: 'Tick', fields: { firedAt: '2026-11-02T10:05:00.000Z', schedule: '*/5 * * * *', zone: 'UTC' } },
          occurredAt: '2026-11-02T10:05:00.000Z',
          takenApplied: true,
        },
      ],
      cursor: '2026-11-02T10:05:10.000Z',
    });
  });

  it('collapses a backlog missed while nothing polled into its latest occurrence', () => {
    const { answer } = pollTicks({ edge: CRON_TICKS_EDGE, filter, cursor: '2026-11-02T09:00:30.000Z' }, clock('2026-11-02T10:02:00.000Z'));
    expect(answer.arrivals.map((a) => ('identity' in a ? a.identity : ''))).toEqual(['tick:*/5 * * * *:UTC:2026-11-02T10:00:00.000Z']);
  });

  it('reads the schedule in the zone the filter names', () => {
    const london = and(on('Schedule', '0 9 * * *'), on('Zone', 'Europe/London'));
    const { answer } = pollTicks({ edge: CRON_TICKS_EDGE, filter: london, cursor: '2026-07-01T07:59:30.000Z' }, clock('2026-07-01T08:00:10.000Z'));
    expect(answer.arrivals).toHaveLength(1);
  });

  it('says which schedule it cannot read, and fires the rest', () => {
    const both = { type: 'logical', op: 'or', operands: [on('Schedule', '61 * * * *'), on('Schedule', '*/5 * * * *')] };
    const ticked = pollTicks({ edge: CRON_TICKS_EDGE, filter: both, cursor: '2026-11-02T10:04:30.000Z' }, clock('2026-11-02T10:05:10.000Z'));
    expect(ticked.answer.arrivals).toHaveLength(1);
    expect(ticked.unread).toEqual([expect.stringContaining('schedule "61 * * * *" in UTC fires nothing')]);
  });

  it('says when its next occurrence is due, looking one interval ahead, the arming poll too', () => {
    // 2026-10-19 is a Monday: armed at 08:29:45, the next tick is 15 seconds on.
    const weekdays = on('Schedule', '30 8 * * 1-5');
    const armed = pollTicks({ edge: CRON_TICKS_EDGE, filter: weekdays }, clock('2026-10-19T08:29:45.000Z'));
    expect(armed.answer.pollAgainAt).toBe('2026-10-19T08:30:00.000Z');
    const fired = pollTicks({ edge: CRON_TICKS_EDGE, filter: weekdays, cursor: '2026-10-19T08:29:45.000Z' }, clock('2026-10-19T08:30:00.500Z'));
    expect(fired.answer.arrivals).toHaveLength(1);
    expect(fired.answer).not.toHaveProperty('pollAgainAt');
    // Every minute: the next minute's start, whatever the second.
    expect(pollTicks({ edge: CRON_TICKS_EDGE, filter: on('Schedule', '* * * * *') }, clock('2026-10-19T08:30:00.000Z')).answer.pollAgainAt).toBe('2026-10-19T08:31:00.000Z');
    // The soonest of the schedules it names.
    const either = { type: 'logical', op: 'or', operands: [on('Schedule', '45 8 * * *'), on('Schedule', '30 8 * * *')] };
    expect(pollTicks({ edge: CRON_TICKS_EDGE, filter: either }, { now: new Date('2026-10-19T08:29:30.000Z'), everyMs: 30 * MINUTE }).answer.pollAgainAt).toBe('2026-10-19T08:30:00.000Z');
  });

  it('refuses a poll naming no schedule', () => {
    expect(() => pollTicks({ edge: CRON_TICKS_EDGE, cursor: '2026-11-02T10:00:00.000Z' }, clock('2026-11-02T10:05:00.000Z'))).toThrow(/names no schedule/);
  });
});
