// Reading a delivery's kept request takes use on the connection the delivery
// came for: a member who may use it is shown the event whatever their level on
// the team, one who may not is told the delivery is not there, and a delivery
// of no connection is the team's. The read is recorded either way it is shown.

import { runWithPrincipal, type Principal } from 'principal';

const showDeliveryRequest = jest.fn(async () => ({ outcome: 'shown' }));
jest.mock('../../../../services/inbound/show_request', () => ({
  ...jest.requireActual('../../../../services/inbound/show_request'),
  showDeliveryRequest: (...args: unknown[]) => (showDeliveryRequest as (...rest: unknown[]) => unknown)(...args),
}));

const deliveryOriginOf = jest.fn(async (): Promise<{ adapterType: string; credentialsId: string | null } | null> => ({
  adapterType: 'attio',
  credentialsId: 'connection-1',
}));
jest.mock('../../../../services/inbound/delivery_origin', () => ({
  deliveryOriginOf: (...args: unknown[]) => (deliveryOriginOf as (...rest: unknown[]) => unknown)(...args),
}));

const mayUse = jest.fn(async (_connectionId: string) => true);
jest.mock('../../../../services/access/decide', () => ({
  ...jest.requireActual('../../../../services/access/decide'),
  accessTo: async (_principal: unknown, asked: { target: { thing: string; id: string } }) =>
    asked.target.thing === 'connection' ? mayUse(asked.target.id) : true,
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

beforeEach(() => {
  jest.clearAllMocks();
  mayUse.mockResolvedValue(true);
});

describe("showing a delivery's kept request", () => {
  it.each(['read', 'write', 'admin'] as const)('use_on_the_connection_shows_the_event: shows it to a %s member who may use the connection', async (access) => {
    await expect(showAs(access)).resolves.toEqual({ outcome: 'shown' });
    expect(mayUse).toHaveBeenCalledWith('connection-1');
    expect(showDeliveryRequest).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1', deliveryId: 'delivery-1', reader: expect.objectContaining({ userId: 'user-1' }) }),
    );
  });

  it.each(['write', 'admin'] as const)('says there is no such delivery to a %s member who may not use the connection, and reads nothing', async (access) => {
    mayUse.mockResolvedValue(false);
    await expect(showAs(access)).resolves.toEqual({
      outcome: 'refused',
      reason: expect.stringMatching(/^no delivery delivery-1 is kept for this team/),
    });
    expect(showDeliveryRequest).not.toHaveBeenCalled();
  });

  it('shows a delivery of no connection to a member of the team', async () => {
    deliveryOriginOf.mockResolvedValueOnce({ adapterType: 'manual', credentialsId: null });
    await expect(showAs('read')).resolves.toEqual({ outcome: 'shown' });
    expect(mayUse).not.toHaveBeenCalled();
  });
});
