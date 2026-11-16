// Reading a delivery's kept request takes use on the connection the delivery
// was kept for: a member who may use it is shown the event whatever their level
// on the team, one who may not (a connection since deleted matches nobody) is
// told the delivery is not there. A delivery of no recorded connection is shown
// only to an admin who may read every automation it reached. The read is
// recorded either way it is shown.

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

const reached = jest.fn(async (): Promise<{ automationIds: Set<string>; untraced: boolean }> => ({ automationIds: new Set(), untraced: false }));
jest.mock('../../../../services/access/whose', () => ({
  Whose: { automationsReachedBy: () => reached() },
}));

const mayUse = jest.fn(async (_connectionId: string) => true);
const mayRead = jest.fn(async (_automationId: string) => true);
jest.mock('../../../../services/access/decide', () => ({
  ...jest.requireActual('../../../../services/access/decide'),
  accessTo: async (_principal: unknown, asked: { target: { thing: string; id: string } }) =>
    asked.target.thing === 'connection' ? mayUse(asked.target.id) : mayRead(asked.target.id),
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
  deliveryOriginOf.mockResolvedValue({ adapterType: 'attio', credentialsId: 'connection-1' });
  mayUse.mockResolvedValue(true);
  mayRead.mockResolvedValue(true);
  reached.mockResolvedValue({ automationIds: new Set(), untraced: false });
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

  describe('a delivery of no recorded connection', () => {
    const NO_SUCH = { outcome: 'refused', reason: expect.stringMatching(/^no delivery delivery-1 is kept for this team/) };

    beforeEach(() => {
      deliveryOriginOf.mockResolvedValue({ adapterType: 'manual', credentialsId: null });
    });

    it.each(['read', 'write'] as const)('is not shown to a %s member, who is no admin', async (access) => {
      await expect(showAs(access)).resolves.toEqual(NO_SUCH);
      expect(mayUse).not.toHaveBeenCalled();
      expect(showDeliveryRequest).not.toHaveBeenCalled();
    });

    it('is shown to an admin who reads every automation it reached', async () => {
      reached.mockResolvedValue({ automationIds: new Set(['automation-1']), untraced: false });
      await expect(showAs('admin')).resolves.toEqual({ outcome: 'shown' });
      expect(mayRead).toHaveBeenCalledWith('automation-1');
    });

    it('is not shown to an admin who may not read an automation it reached', async () => {
      reached.mockResolvedValue({ automationIds: new Set(['private-1']), untraced: false });
      mayRead.mockImplementation(async (id) => id !== 'private-1');
      await expect(showAs('admin')).resolves.toEqual(NO_SUCH);
      expect(showDeliveryRequest).not.toHaveBeenCalled();
    });

    it('is not shown to anyone when a run it reached cannot be traced to an automation', async () => {
      reached.mockResolvedValue({ automationIds: new Set(), untraced: true });
      await expect(showAs('admin')).resolves.toEqual(NO_SUCH);
    });
  });
});
