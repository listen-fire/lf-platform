// A replay judges by the current version's listen plan. A listen on another
// version has none, and replaying through it says why it cannot, never that the
// listen does not exist.

const replayMock = jest.fn(async () => ({ outcome: 'refused', reason: 'no listen' }));
jest.mock('../../../../services/inbound/listen_replay', () => ({
  replayThroughListen: (...args: unknown[]) => replayMock(...(args as [])),
}));
jest.mock('../../../../services/translation_graph/movement/store', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/store'),
  getMovementRow: jest.fn(),
}));
jest.mock('../../../../services/access/whose', () => ({
  Whose: { automationOfListen: async () => ({ teamId: '11111111-2222-3333-4444-555555555555', automationId: 'movement-1' }) },
}));
jest.mock('../../../../services/access/decide', () => jest.requireActual('../../../../test/access_defaults').teamDefaults());
jest.mock('../team_scope', () => {
  class ToolTeamError extends Error {}
  return {
    ToolTeamError,
    resolveToolTeam: async (team?: string) => team ?? '11111111-2222-3333-4444-555555555555',
    listAccessibleTeams: async () => [],
    teamSetForReads: async () => ['11111111-2222-3333-4444-555555555555'],
    teamNames: jest.fn(),
  };
});

import { LANGUAGE_VERSION } from 'movement-lang';
import { runWithPrincipal, type Principal } from 'principal';

import { getMovementRow, type MovementRow } from '../../../../services/translation_graph/movement/store';
import { replayDeliveryHandler } from '../knowledge_agent_tools';

const ACTING: Principal = { teamId: '11111111-2222-3333-4444-555555555555', userId: 'u1', access: 'write', scopes: ['*'], pinnedTeamId: null };

async function replay(): Promise<unknown> {
  let body: unknown;
  const res = {
    status: () => res,
    json: (value: unknown) => {
      body = value;
      return res;
    },
  };
  await runWithPrincipal(ACTING, async () => {
    await replayDeliveryHandler({ body: { listen: 'trigger-1', deliveryId: 'delivery-1' } } as never, res as never, (() => {}) as never);
  });
  return body;
}

const onPin = (languageVersion: string) =>
  jest.mocked(getMovementRow).mockResolvedValue({ id: 'movement-1', name: 'Echo', languageVersion } as MovementRow);

beforeEach(() => replayMock.mockClear());

describe('replayDelivery through a listen', () => {
  it('on 0.12 says why it cannot, and judges nothing', async () => {
    onPin('0.12.13');
    expect(await replay()).toEqual({ error: expect.stringContaining("'Echo' is written in language 0.12.13") });
    expect(replayMock).not.toHaveBeenCalled();
  });

  it('on the current version goes ahead', async () => {
    onPin(LANGUAGE_VERSION);
    await replay();
    expect(replayMock).toHaveBeenCalledTimes(1);
  });
});
