// Which pause a new listen takes from the rows an upgrade retires.

import { carriedPauses, listenIdentityOf, type CarriedPause } from '../carried_pauses';

const off: CarriedPause = { off: true };
const guard: CarriedPause = { off: false, guard: { at: new Date(0), reason: 'a team budget breach', signal: 'team_budget' } };
const breaker: CarriedPause = { off: false, breaker: 'LISTEN_LOOP: it echoes itself' };
const id = (movement: string, kind = 'slack') => listenIdentityOf({ movementName: movement, kind, credentialsId: 'cred' })!;

describe('the pause each new listen takes', () => {
  it('a new listen takes the state of the one retired row that fired the same movement, and nothing is unsure', () => {
    expect(carriedPauses({ retired: [{ identity: id('a'), pause: null }, { identity: id('b'), pause: off }], fresh: [{ identity: id('a') }, { identity: id('b') }] })).toEqual([
      { pause: null, unsure: false },
      { pause: off, unsure: false },
    ]);
  });

  it('as many retired rows as new listens, all paused: each is paused and nothing is unsure', () => {
    expect(carriedPauses({ retired: [{ identity: id('a'), pause: guard }, { identity: id('a'), pause: guard }], fresh: [{ identity: id('a') }, { identity: id('a') }] })).toEqual([
      { pause: guard, unsure: false },
      { pause: guard, unsure: false },
    ]);
  });

  it('as many retired rows as new listens, only some paused: which cannot be said, so every one is paused and unsure', () => {
    expect(carriedPauses({ retired: [{ identity: id('a'), pause: null }, { identity: id('a'), pause: off }], fresh: [{ identity: id('a') }, { identity: id('a') }] })).toEqual([
      { pause: off, unsure: true },
      { pause: off, unsure: true },
    ]);
  });

  it('a different number of new listens than retired rows, one paused: all are paused and unsure', () => {
    expect(carriedPauses({ retired: [{ identity: id('a'), pause: off }], fresh: [{ identity: id('a') }, { identity: id('a') }] })).toEqual([
      { pause: off, unsure: true },
      { pause: off, unsure: true },
    ]);
  });

  it('nothing paused anywhere: nothing is paused or unsure', () => {
    expect(carriedPauses({ retired: [{ identity: id('a'), pause: null }], fresh: [{ identity: id('b') }] })).toEqual([{ pause: null, unsure: false }]);
  });

  it('a pause on a retired row no new listen resembles passes to every new listen, unsure', () => {
    expect(carriedPauses({ retired: [{ identity: id('gone'), pause: breaker }, { identity: null, pause: null }], fresh: [{ identity: id('a') }, { identity: id('b') }] })).toEqual([
      { pause: breaker, unsure: true },
      { pause: breaker, unsure: true },
    ]);
  });

  it('the run mode, the guard and the breaker are kept together from different rows', () => {
    const [carried] = carriedPauses({ retired: [{ identity: id('a'), pause: off }, { identity: id('a'), pause: guard }, { identity: id('a'), pause: breaker }], fresh: [{ identity: id('a') }] });
    expect(carried).toEqual({ pause: { off: true, guard: guard.guard, breaker: breaker.breaker }, unsure: true });
  });

  it('a row with no recorded movement has no identity', () => {
    expect(listenIdentityOf({ movementName: null, kind: 'slack', credentialsId: null })).toBeNull();
  });
});
