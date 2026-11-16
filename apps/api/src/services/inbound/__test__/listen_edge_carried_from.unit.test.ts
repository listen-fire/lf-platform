// A re-save keeps the mark of the upgrade that moved a listen, whatever shape
// its version plans the row in: losing it would change the key the listen
// polls under (it polls alone) and orphan its cursor, with no word said.

import { keepingCarriedFrom } from '../listen_edge';

const MARK = { at: '2026-11-04T10:00:00.000Z', pollsAlone: true };
const WHAT = 'deals: the gmail listen that fires triage';

/** A row planned in a carried version's own shape: this release's listen
 *  schema does not read it (its plan is not this release's). */
const carriedShaped = { listen: { pipeline: 'listen:deals:triage', plan: { movement: 'triage', steps: ['0.15 only'] } } };

describe('a re-save of a listen an upgrade moved', () => {
  it("keeps the mark on a row planned in a carried version's shape, and the row as it was planned", () => {
    const kept = { listen: { pipeline: 'listen:deals:triage', plan: { movement: 'triage' }, carriedFrom: MARK } };
    expect(keepingCarriedFrom({ config: carriedShaped, kept, what: WHAT })).toEqual({ listen: { ...carriedShaped.listen, carriedFrom: MARK } });
  });

  it('leaves a row with no mark before it as it was planned', () => {
    expect(keepingCarriedFrom({ config: carriedShaped, kept: { listen: { pipeline: 'listen:deals:triage' } }, what: WHAT })).toBe(carriedShaped);
    expect(keepingCarriedFrom({ config: carriedShaped, kept: { cron: '* * * * *' }, what: WHAT })).toBe(carriedShaped);
  });

  it('refuses the save, naming the listen, when the mark cannot be read', () => {
    expect(() => keepingCarriedFrom({ config: carriedShaped, kept: { listen: { carriedFrom: { pollsAlone: 'yes' } } }, what: WHAT })).toThrow(
      /^deals: the gmail listen that fires triage: the mark of the upgrade that moved it cannot be read/,
    );
  });

  it('refuses the save, naming the listen, when the planned row has no listen to keep the mark on', () => {
    expect(() => keepingCarriedFrom({ config: { cron: '* * * * *' }, kept: { listen: { carriedFrom: MARK } }, what: WHAT })).toThrow(
      /^deals: the gmail listen that fires triage: its planned row has no listen/,
    );
  });
});
