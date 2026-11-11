// Reading a delivery's kept request takes admin access on the team: a write
// member is refused with the same answer a read member gets, before any
// delivery is looked at, and a team admin reaches the read.

import { runWithPrincipal, type Principal } from 'principal';

const showDeliveryRequest = jest.fn(async () => ({ outcome: 'shown' }));
jest.mock('../../../../services/inbound/show_request', () => ({
  ...jest.requireActual('../../../../services/inbound/show_request'),
  showDeliveryRequest: (...args: unknown[]) => (showDeliveryRequest as (...rest: unknown[]) => unknown)(...args),
}));
jest.mock('../../../../services/access/whose', () => ({
  Whose: { automationsReachedBy: jest.fn(async () => ({ untraced: false, automationIds: [] })) },
}));

import { Context } from '../../../../services/context';
import { trpc } from '../../trpc';
import { triggersRouter } from '../triggers';

function principalWith(access: Principal['access']): Principal {
  return { teamId: 'team-1', userId: 'user-1', access, scopes: ['*'], pinnedTeamId: null };
}

function showAs(access: Principal['access']) {
  const caller = triggersRouter(trpc.procedure).createCaller({ authorise: async () => {} });
  const principal = principalWith(access);
  const ctx = new Context();
  ctx.bindPrincipal(principal);
  return ctx.runAsync(() => runWithPrincipal(principal, () => caller.showDeliveryRequest({ deliveryId: 'delivery-1' })));
}

beforeEach(() => jest.clearAllMocks());

describe("showing a delivery's kept request", () => {
  it.each(['read', 'write'] as const)('refuses a %s member, and reads nothing', async (access) => {
    await expect(showAs(access)).resolves.toEqual({
      outcome: 'refused',
      reason: "only the team's admins may read a delivery's request",
    });
    expect(showDeliveryRequest).not.toHaveBeenCalled();
  });

  it('shows it to a team admin', async () => {
    await expect(showAs('admin')).resolves.toEqual({ outcome: 'shown' });
    expect(showDeliveryRequest).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1', deliveryId: 'delivery-1', reader: expect.objectContaining({ access: 'admin' }) }),
    );
  });
});
