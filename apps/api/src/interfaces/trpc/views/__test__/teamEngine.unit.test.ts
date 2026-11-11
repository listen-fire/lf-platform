// Switching the team's engine takes admin access on the team: a write member
// is refused as a read member is, and nothing is switched.

import { runWithPrincipal, type Principal } from 'principal';

const switchTeamEngine = jest.fn(async () => ({ engine: 'lf' as const, changed: true, notes: [] }));
jest.mock('../../../../services/lf_engine/switch', () => ({
  switchTeamEngine: (...args: unknown[]) => (switchTeamEngine as (...rest: unknown[]) => unknown)(...args),
}));
jest.mock('../../../../services/lf_engine/team_engine', () => ({
  ...jest.requireActual('../../../../services/lf_engine/team_engine'),
  readTeamEngine: jest.fn(),
}));

import { trpc } from '../../trpc';
import { teamEngineRouter } from '../teamEngine';

function principalWith(access: Principal['access']): Principal {
  return { teamId: 'team-1', userId: 'user-1', access, scopes: ['*'], pinnedTeamId: null };
}

function switchAs(access: Principal['access']) {
  const caller = teamEngineRouter(trpc.procedure).createCaller({ authorise: async () => {} });
  return runWithPrincipal(principalWith(access), () => caller.set({ engine: 'lf' }));
}

beforeEach(() => jest.clearAllMocks());

describe("switching the team's engine", () => {
  it.each(['read', 'write'] as const)('refuses a %s member, and switches nothing', async (access) => {
    await expect(switchAs(access)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: "Only a team admin can switch the team's engine.",
    });
    expect(switchTeamEngine).not.toHaveBeenCalled();
  });

  it('switches for a team admin, recorded as them', async () => {
    await expect(switchAs('admin')).resolves.toEqual({ engine: 'lf', changed: true, notes: [] });
    expect(switchTeamEngine).toHaveBeenCalledWith('team-1', { engine: 'lf', changedBy: 'user-1' });
  });
});
