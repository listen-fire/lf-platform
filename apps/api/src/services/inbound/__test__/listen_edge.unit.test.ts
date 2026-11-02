// What a listen shares a poll or a subscription by: one key per edge it is
// delivered on. A listen over a union is watched by each member's traversal,
// each delivered as its member's last edge declares, and is still one listen:
// two members on one key share it once.

import type { ListenPlan, PlanHop } from 'engine-contracts';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { SavedListen } from '../listen_door';
import { listenEdgeKeysOf } from '../listen_edge';

const hop = (edge: string, from: string, to: string, more: Partial<PlanHop> = {}): PlanHop => ({ edge, from, to, judged: 'none', ...more });

function saved(listen: Pick<SavedListen, 'plan'> & Partial<SavedListen>): SavedListen {
  return {
    pipeline: 'listen:f:advised:00',
    awaits: { own: [], carried: {} },
    fieldIds: {},
    triggerId: 'trigger-1' as TriggerId,
    teamId: 'team-1' as TeamId,
    file: 'f',
    credentialsId: 'cred-1',
    ...listen,
  };
}

/** `crm-[:Funds]->-[:Advisors]->-[c:Changes]->`, where Advisors is a Company or a Person. */
const UNION: ListenPlan = {
  movement: 'advised',
  connection: 'crm',
  adapter: 'attio',
  hops: [],
  members: [
    { hops: [hop('Funds', '', 'Funds'), hop('Advisors', 'Funds', 'Companies', { memberOf: 'Companies | People' }), hop('Changes', 'Companies', 'CompanyChange', { judged: 'arrival' })] },
    { hops: [hop('Funds', '', 'Funds'), hop('Advisors', 'Funds', 'People', { memberOf: 'Companies | People' }), hop('Changes', 'People', 'PersonChange', { judged: 'arrival' })] },
  ],
};

describe('the keys a listen is delivered under', () => {
  it('gives a listen over no union the key of its last edge', () => {
    const plan: ListenPlan = { ...UNION, hops: [hop('Companies', '', 'Companies'), hop('Changes', 'Companies', 'CompanyChange', { judged: 'arrival' })] };
    delete plan.members;
    const keys = listenEdgeKeysOf(saved({ plan, delivery: { kind: 'connection' } }), ['connection', 'scope']);
    expect(keys.map(({ key }) => key.edge)).toEqual(['Changes']);
  });

  it("subscribes a union listen once when its members' last edges share a key", () => {
    const listen = saved({ plan: UNION, members: [{ delivery: { kind: 'connection' } }, { delivery: { kind: 'connection' } }] });
    const keys = listenEdgeKeysOf(listen, ['connection', 'scope']);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.key).toMatchObject({ adapterType: 'attio', edge: 'Changes', credentialsId: 'cred-1' });
    expect(listenEdgeKeysOf(listen, ['polled'])).toEqual([]);
  });

  it("watches each member as its own last edge is delivered, polled at the sooner of two members' intervals", () => {
    const polled = saved({ plan: UNION, members: [{ delivery: { kind: 'polled', pollEverySeconds: 300 } }, { delivery: { kind: 'polled', pollEverySeconds: 60 } }] });
    expect(listenEdgeKeysOf(polled, ['polled']).map(({ delivery }) => delivery.pollEverySeconds)).toEqual([60]);
    const mixed = saved({ plan: UNION, members: [{ delivery: { kind: 'polled' } }, { delivery: { kind: 'connection' } }] });
    expect(listenEdgeKeysOf(mixed, ['polled'])).toHaveLength(1);
    expect(listenEdgeKeysOf(mixed, ['connection'])).toHaveLength(1);
  });

  it('gives a member whose module declares no delivery no key', () => {
    expect(listenEdgeKeysOf(saved({ plan: UNION, members: [{}, {}] }), ['connection', 'polled', 'scope'])).toEqual([]);
  });
});
