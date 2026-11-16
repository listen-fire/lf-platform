// "Why didn't this fire?" takes the same standing as reading the delivery's
// request: use on the connection it came for. A delivery the asker may not see
// answers as one that is not there, and nothing is judged.

import { runWithPrincipal, type Principal } from 'principal';

const explainDeliveryArrival = jest.fn(async () => ({ ok: true, deliveryId: 'delivery-1', arrivalIndex: 0, edge: 'Things', listens: [] }));
jest.mock('../../../../services/inbound/explain_arrival', () => ({
  explainDeliveryArrival: (...args: unknown[]) => (explainDeliveryArrival as (...rest: unknown[]) => unknown)(...args),
}));

jest.mock('../../../../services/inbound/delivery_origin', () => ({
  deliveryOriginOf: async () => ({ adapterType: 'attio', credentialsId: 'connection-1' }),
}));

const mayUse = jest.fn(async (_connectionId: string) => true);
jest.mock('../../../../services/access/decide', () => ({
  ...jest.requireActual('../../../../services/access/decide'),
  accessTo: async (_principal: unknown, asked: { target: { id: string } }) => mayUse(asked.target.id),
}));

import { Context } from '../../../../services/context';
import { trpc } from '../../trpc';
import { triggersRouter } from '../triggers';

function explainAs(access: Principal['access']) {
  const caller = triggersRouter(trpc.procedure).createCaller({ authorise: async () => {} });
  const principal: Principal = { teamId: 'team-1', userId: 'user-1', access, scopes: ['*'], pinnedTeamId: null };
  const ctx = new Context();
  ctx.bindPrincipal(principal);
  return ctx.runAsync(() => runWithPrincipal(principal, () => caller.explainArrival({ deliveryId: 'delivery-1', arrivalIndex: 0 })));
}

beforeEach(() => {
  jest.clearAllMocks();
  mayUse.mockResolvedValue(true);
});

describe("explaining why a delivery's event did not fire", () => {
  it.each(['read', 'write', 'admin'] as const)('explains it to a %s member who may use the connection', async (access) => {
    await expect(explainAs(access)).resolves.toMatchObject({ ok: true, edge: 'Things' });
    expect(explainDeliveryArrival).toHaveBeenCalledWith({ teamId: 'team-1', deliveryId: 'delivery-1', arrivalIndex: 0 });
  });

  it.each(['read', 'write', 'admin'] as const)('says there is no such delivery to a %s member who may not see it, and judges nothing', async (access) => {
    mayUse.mockResolvedValue(false);
    await expect(explainAs(access)).resolves.toEqual({
      ok: false,
      errors: [expect.stringMatching(/^no delivery delivery-1 is kept for this team/)],
    });
    expect(explainDeliveryArrival).not.toHaveBeenCalled();
  });
});
