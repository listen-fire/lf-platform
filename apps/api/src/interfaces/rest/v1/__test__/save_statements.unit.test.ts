// The statements an agent gives a new automation reach the save as they were
// given: over REST, and through the MCP tool that is that route. The save
// decides them (provision_access covers that); this route only hands them on.

import { Router } from 'express';
import { runWithPrincipal } from 'principal';
import { z } from 'zod';

import type { RequestHandler } from 'express';

import { automationConnectorOptions } from '../../../mcp/connectors/automation';

const TEAM = '11111111-1111-4111-8111-111111111111';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mockSave = jest.fn(async (_input: unknown) => ({ ok: false as const, errors: ['not saved'], catalogNotes: [] }));

jest.mock('../../../../services/translation_graph/movement/provision', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/provision'),
  saveMovement: (input: unknown) => mockSave(input),
}));

jest.mock('../team_scope', () => ({
  ...jest.requireActual('../team_scope'),
  resolveToolTeam: async () => TEAM,
}));

import { mountAutomationToolRoutes } from '../knowledge_agent_tools';

const saveRoute: RequestHandler = (() => {
  const router = Router();
  mountAutomationToolRoutes(router);
  const layer = router.stack.find((l) => l.route?.path === '/automations/save' && l.route.stack.some((s) => s.method === 'post'));
  const handler = layer?.route?.stack[layer.route.stack.length - 1]?.handle;
  if (handler === undefined) throw new Error('POST /automations/save is not mounted');
  return handler;
})();

async function save(body: Record<string, unknown>): Promise<void> {
  const res = { status: () => res, json: () => res };
  await runWithPrincipal({ teamId: TEAM, userId: ALICE, access: 'write', scopes: ['*'], pinnedTeamId: null }, () =>
    Promise.resolve(saveRoute({ body } as never, res as never, () => undefined)),
  );
}

const statements = {
  read: [{ kind: 'team' }],
  write: [{ kind: 'user', userId: ALICE }],
  fire: [{ kind: 'anyone' }],
};

beforeEach(() => mockSave.mockClear());

describe('saving over REST', () => {
  it('hands the statements it was given to the save', async () => {
    await save({ source: 'x', acknowledgeErrors: true, statements });
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ teamId: TEAM, statements }));
  });

  it('hands on none when it was given none, leaving the save to refuse a new automation', async () => {
    await save({ source: 'x', acknowledgeErrors: true });
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0]?.[0]).not.toHaveProperty('statements');
  });

  it('refuses a list of the wrong shape before the save', async () => {
    await save({ source: 'x', acknowledgeErrors: true, statements: { ...statements, fire: [{ kind: 'everyone' }] } });
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('saving through the MCP tool', () => {
  const tool = automationConnectorOptions().tools?.saveAutomation;

  it('is the same route', () => {
    expect(tool?.endpoint).toEqual({ method: 'POST', path: '/v1/automation/automations/save' });
  });

  it('keeps the statements it is given for the route', () => {
    if (tool === undefined) throw new Error('no saveAutomation tool');
    const given = z.object(tool.inputSchema).parse({ source: 'x', statements });
    expect(given.statements).toEqual(statements);
  });
});
