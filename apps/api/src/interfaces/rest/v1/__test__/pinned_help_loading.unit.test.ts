// Nothing of a carried version loads for a team with no automation on it. Its
// package is replaced by a flag: help and pictures of the current version never
// raise it, and a positive control shows the flag is the real way in.

const loaded = { lane: false };
jest.mock('@listen-fire/lang-0.12', () => {
  loaded.lane = true;
  return { LANGUAGE_VERSION: '0.12.13', handbookOf: () => ({ release: '0.12.8', frontPage: 'front', chapters: [], intentIndex: [] }), handbookFrontSection: () => ({ ok: false, error: '' }) };
});
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
    expect(loaded.lane).toBe(false);
  });

  it("a list's facets for a 0.12 text load nothing of 0.12 either", () => {
    movementFileFacets('listen to manual fire echo\n', '0.12.13');
    expect(loaded.lane).toBe(false);
  });

  it('asking under a 0.12 automation is what loads it', async () => {
    jest.mocked(getMovementRow).mockResolvedValue({ id: 'm', teamId: 'team-a', name: 'e', source: '', languageVersion: '0.12.13' } as MovementRow);
    await call(readBookHandler, { handbook: 'automations', automation: 'm' });
    expect(loaded.lane).toBe(true);
  });
});
