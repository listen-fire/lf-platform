// "Run with this event" is a write on the automation: someone who may only
// read it is refused with the read-only message, someone who cannot see it is
// told it is not there, and a writer starts it, vouched for by name.

import { TRPCError } from '@trpc/server';
import { runWithPrincipal, type Principal } from 'principal';

const runWithEvent = jest.fn(async () => ({ ok: true, runIds: ['run-1'], movementName: 'Deals' }));
jest.mock('../../../../services/translation_graph/movement/run_now', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/run_now'),
  runWithEvent: (...args: unknown[]) => (runWithEvent as (...rest: unknown[]) => unknown)(...args),
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
});
