// "Run with this event" is a write on the automation: someone who may only
// read it is refused with the read-only message, someone who cannot see it is
// told it is not there, and a writer starts it, vouched for by name. The event's
// delivery must also be one the writer may reach: use on the connection it was
// kept for, or, for a delivery that recorded none, the admin's read of what it
// reached.

import { TRPCError } from '@trpc/server';
import { runWithPrincipal, type Principal } from 'principal';

const runWithEvent = jest.fn(async () => ({ ok: true, runIds: ['run-1'], movementName: 'Deals' }));
jest.mock('../../../../services/translation_graph/movement/run_now', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/run_now'),
  runWithEvent: (...args: unknown[]) => (runWithEvent as (...rest: unknown[]) => unknown)(...args),
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

const cannotChange = jest.fn(async (_automationId: string | null): Promise<boolean> => false);
jest.mock('../../access', () => ({
  ...jest.requireActual('../../access'),
  cannotChange: (automationId: string | null) => cannotChange(automationId),
}));

import { Context } from '../../../../services/context';
import { trpc } from '../../trpc';
import { movementRouter } from '../movement';

const AUTOMATION = 'd0000000-0000-4000-8000-000000000001';
const principal: Principal = { teamId: 'team-1', userId: 'user-1', access: 'write', scopes: ['*'], pinnedTeamId: null };

function runWith() {
  const caller = movementRouter(trpc.procedure).createCaller({ authorise: async () => {} });
  const ctx = new Context();
  ctx.bindPrincipal(principal);
  return ctx.runAsync(() => runWithPrincipal(principal, () => caller.runWithEvent({ id: AUTOMATION, deliveryId: 'delivery-1', arrivalIndex: 2 })));
}

beforeEach(() => {
  jest.clearAllMocks();
  cannotChange.mockResolvedValue(false);
  deliveryOriginOf.mockResolvedValue({ adapterType: 'attio', credentialsId: 'connection-1' });
  mayUse.mockResolvedValue(true);
});

describe('run_with_this_event_needs_write_and_skips_the_filter (the route needs write)', () => {
  it('starts it for someone who may write the automation', async () => {
    await expect(runWith()).resolves.toEqual({ ok: true, runIds: ['run-1'], movementName: 'Deals' });
    expect(cannotChange).toHaveBeenCalledWith(AUTOMATION);
    expect(runWithEvent).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1', automationId: AUTOMATION, deliveryId: 'delivery-1', arrivalIndex: 2, by: expect.objectContaining({ userId: 'user-1' }) }),
    );
  });

  it('refuses someone who may only read it, and starts nothing', async () => {
    cannotChange.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN', message: 'You may read this automation but not change it.' }));
    await expect(runWith()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(runWithEvent).not.toHaveBeenCalled();
  });

  it('answers as for an automation that is not there to someone who cannot see it', async () => {
    cannotChange.mockResolvedValue(true);
    await expect(runWith()).resolves.toEqual({ ok: false, errors: [`movement ${AUTOMATION} not found`] });
    expect(runWithEvent).not.toHaveBeenCalled();
  });

  it('refuses a writer who may not use the connection the delivery was kept for, and starts nothing', async () => {
    mayUse.mockResolvedValue(false);
    await expect(runWith()).resolves.toEqual({ ok: false, errors: [expect.stringMatching(/^no delivery delivery-1 is kept for this team/)] });
    expect(mayUse).toHaveBeenCalledWith('connection-1');
    expect(runWithEvent).not.toHaveBeenCalled();
  });

  it('refuses a writer who is no admin a delivery that recorded no connection', async () => {
    deliveryOriginOf.mockResolvedValue({ adapterType: 'attio', credentialsId: null });
    await expect(runWith()).resolves.toEqual({ ok: false, errors: [expect.stringMatching(/^no delivery delivery-1 is kept for this team/)] });
    expect(runWithEvent).not.toHaveBeenCalled();
  });

  it('refuses a delivery the team does not keep', async () => {
    deliveryOriginOf.mockResolvedValue(null);
    await expect(runWith()).resolves.toMatchObject({ ok: false });
    expect(runWithEvent).not.toHaveBeenCalled();
  });
});
