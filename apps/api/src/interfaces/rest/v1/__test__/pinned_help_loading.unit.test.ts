// Nothing of a carried version loads for a team with no automation on it. The
// registry's own entry is the only way into a version's package (the boundary
// script holds that), so its doors are watched: help and pictures of the current
// version never open one, and a positive control shows they are the way in.

jest.mock('../../../../services/access/decide', () => jest.requireActual('../../../../test/access_defaults').teamDefaults());
jest.mock('../../../../services/translation_graph/movement/store', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/store'),
  getMovementRow: jest.fn(),
  listDerivedTriggerRows: jest.fn(async () => []),
}));
jest.mock('../../../../services/translation_graph/movement/catalog', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/catalog'),
  movementCatalogForTeam: jest.fn(),
}));
jest.mock('../team_scope', () => {
  class ToolTeamError extends Error {}
  return {
    ToolTeamError,
    resolveToolTeam: async (team?: string) => team ?? 'team-a',
    listAccessibleTeams: async () => [],
    teamSetForReads: async () => ['team-a'],
    teamNames: jest.fn(),
  };
});

import { carriedVersions, currentVersion } from '@listen-fire/language-versions';
import { LANGUAGE_VERSION, mockCatalogSnapshot } from 'movement-lang';
import { runWithPrincipal, type Principal } from 'principal';

import type { RequestHandler } from 'express';

import { movementCatalogForTeam } from '../../../../services/translation_graph/movement/catalog';
import { getMovementRow, type MovementRow } from '../../../../services/translation_graph/movement/store';
import { movementFileFacets } from '../../../../services/translation_graph/movement/files';
import { projectStoryView } from '../../../../services/translation_graph/movement/story_view';
import { readBookHandler, searchLanguageHandler, showExampleHandler } from '../knowledge_agent_tools';

const ACTING: Principal = { teamId: 'team-a', userId: 'u1', access: 'write', scopes: ['*'], pinnedTeamId: null };

async function call(handler: RequestHandler, body: unknown): Promise<void> {
  const res = { status: () => res, json: () => res, type: () => res, send: () => res };
  await runWithPrincipal(ACTING, async () => {
    await handler({ body } as never, res as never, (() => {}) as never);
  });
}

const [carried] = carriedVersions().filter((version) => version !== currentVersion());
if (carried === undefined) throw new Error('this test watches a carried version');
const doors = [
  jest.spyOn(carried, 'load'),
  ...[carried.provides.check, carried.provides.help, carried.provides.run, carried.provides.resume].flatMap((capability) =>
    capability.kind === 'carried' ? [jest.spyOn(capability, 'lane')] : [],
  ),
];
const opened = (): number => doors.reduce((count, door) => count + door.mock.calls.length, 0);

describe('a team with no 0.12 automation', () => {
  it("help, a current automation's help and its picture load nothing of 0.12", async () => {
    jest.mocked(getMovementRow).mockResolvedValue({ id: 'm', teamId: 'team-a', name: 'e', source: '', languageVersion: LANGUAGE_VERSION } as MovementRow);
    const snapshot = mockCatalogSnapshot({ adapters: {} });
    jest.mocked(movementCatalogForTeam).mockResolvedValue({ runSnapshot: () => snapshot, instanceSchemas: [] } as never);

    await call(readBookHandler, { handbook: 'automations' });
    await call(readBookHandler, { handbook: 'automations', automation: 'm' });
    await call(searchLanguageHandler, { query: 'join text', automation: 'm' });
    await call(showExampleHandler, { query: 'a loop' });
    await projectStoryView({ id: 'm', teamId: 'team-a', name: 'e', source: 'listen to manual-[:Invocations]-> fire e\n', validityStatus: null, languageVersion: LANGUAGE_VERSION });
    expect(opened()).toBe(0);
  });

  it("a list's facets for a 0.12 text load nothing of 0.12 either", () => {
    movementFileFacets('listen to manual fire echo\n', '0.12.13');
    expect(opened()).toBe(0);
  });

  it('asking under a 0.12 automation is what loads it', async () => {
    jest.mocked(getMovementRow).mockResolvedValue({ id: 'm', teamId: 'team-a', name: 'e', source: '', languageVersion: '0.12.13' } as MovementRow);
    await call(readBookHandler, { handbook: 'automations', automation: 'm' });
    expect(opened()).toBeGreaterThan(0);
  });
});
