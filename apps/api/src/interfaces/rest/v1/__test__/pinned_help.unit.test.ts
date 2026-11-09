// An agent working on an automation is taught that automation's language
// version, through the real handlers: the 0.12 package answers a 0.12 pin, and
// the current book answers everything else, a new automation included.

jest.mock('../../../../services/access/decide', () => jest.requireActual('../../../../test/access_defaults').teamDefaults());
jest.mock('../../../../services/translation_graph/movement/store', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/store'),
  getMovementRow: jest.fn(),
  getMovementRowByName: jest.fn(),
  listMovementRows: jest.fn(async () => []),
}));
jest.mock('../../../../services/translation_graph/movement/catalog', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/catalog'),
  loadCredentialRows: jest.fn(async () => []),
}));
jest.mock('../../../../services/translation_graph/adapters/remote/store', () => ({
  ...jest.requireActual('../../../../services/translation_graph/adapters/remote/store'),
  listRemoteAdapters: jest.fn(async () => []),
}));
jest.mock('../../../../services/credentials/secrets_postgres', () => ({
  ...jest.requireActual('../../../../services/credentials/secrets_postgres'),
  postgresSecrets: () => {
    throw new Error('no stored credential in this test');
  },
}));
jest.mock('../team_scope', () => {
  class ToolTeamError extends Error {}
  return {
    ToolTeamError,
    resolveToolTeam: async (team?: string) => team ?? 'team-a',
    listAccessibleTeams: async () => [{ teamId: 'team-a', name: 'A', access: 'write', isPersonal: false }],
    teamSetForReads: async () => ['team-a'],
    teamNames: jest.fn(),
  };
});

import { LANGUAGE_VERSION } from 'movement-lang';
import { runWithPrincipal, type Principal } from 'principal';

import type { RequestHandler } from 'express';

import { getMovementRow, getMovementRowByName, type MovementRow } from '../../../../services/translation_graph/movement/store';
import {
  describeInstanceHandler,
  getStartedHandler,
  listCatalogHandler,
  readBookHandler,
  searchLanguageHandler,
  showExampleHandler,
} from '../knowledge_agent_tools';

const ACTING: Principal = { teamId: 'team-a', userId: 'u1', access: 'write', scopes: ['*'], pinnedTeamId: null };

async function call(handler: RequestHandler, request: { body?: unknown; query?: unknown }): Promise<{ status: number | undefined; body: unknown }> {
  let status: number | undefined;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
    type() {
      return res;
    },
    send(value: unknown) {
      body = value;
      return res;
    },
  };
  await runWithPrincipal(ACTING, async () => {
    await handler(request as never, res as never, (() => {}) as never);
  });
  return { status, body };
}

function row(languageVersion: string, id = 'movement-1'): MovementRow {
  return { id, teamId: 'team-a', name: 'Echo', source: '', languageVersion } as MovementRow;
}

/** An object's field, read through unknown. */
function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined;
}

beforeEach(() => {
  jest.mocked(getMovementRow).mockReset();
  jest.mocked(getMovementRowByName).mockReset();
});

function onPin(pin: string): void {
  jest.mocked(getMovementRow).mockResolvedValue(row(pin));
}

describe('readHandbook', () => {
  it("a 0.12 automation reads handbook 0.12.8's own chapters, labelled", async () => {
    onPin('0.12.13');
    const { body } = await call(readBookHandler, { body: { handbook: 'automations', chapter: 'system:manual', automation: 'movement-1' } });
    expect(field(body, 'content')).toContain('to manual fire');
    expect(field(body, 'content')).not.toContain('-[:Invocations]->');
    expect(field(body, 'language')).toMatchObject({ version: '0.12.13', current: false, handbook: '0.12.8' });
  });

  it('the same chapter for a current automation teaches the current spelling', async () => {
    onPin(LANGUAGE_VERSION);
    const { body } = await call(readBookHandler, { body: { handbook: 'automations', chapter: 'system:manual', automation: 'movement-1' } });
    expect(field(body, 'content')).toContain('-[:Invocations]->');
    expect(field(body, 'language')).toMatchObject({ version: LANGUAGE_VERSION, current: true });
  });

  it('a new automation gets the current book, and no label it did not ask for', async () => {
    const { body } = await call(readBookHandler, { body: { handbook: 'automations', chapter: 'system:manual' } });
    expect(field(body, 'content')).toContain('-[:Invocations]->');
    expect(field(body, 'language')).toBeUndefined();
    expect(getMovementRow).not.toHaveBeenCalled();
  });

  it('the front page and its anchors are 0.12\'s', async () => {
    onPin('0.12.8');
    const front = await call(readBookHandler, { body: { handbook: 'automations', automation: 'movement-1' } });
    expect(field(front.body, 'content')).toContain('connect attio using acme');
    const anchor = await call(readBookHandler, { body: { handbook: 'automations', chapter: 'front#build-loop', automation: 'movement-1' } });
    expect(field(anchor.body, 'content')).toContain('getStarted');
  });

  it('a legacy id is taught from the release it ran beside', async () => {
    onPin('4');
    const { body } = await call(readBookHandler, { body: { handbook: 'automations', chapter: 'system:manual', automation: 'movement-1' } });
    expect(field(body, 'language')).toMatchObject({ version: '4', handbook: '0.12.8' });
  });

  it('finds an automation by its exact name', async () => {
    jest.mocked(getMovementRow).mockResolvedValue(null);
    jest.mocked(getMovementRowByName).mockResolvedValue(row('0.12.13'));
    const { body } = await call(readBookHandler, { body: { handbook: 'automations', automation: 'Echo' } });
    expect(field(body, 'language')).toMatchObject({ version: '0.12.13' });
  });

  it('names an automation that is not there', async () => {
    jest.mocked(getMovementRow).mockResolvedValue(null);
    jest.mocked(getMovementRowByName).mockResolvedValue(null);
    const { body } = await call(readBookHandler, { body: { handbook: 'automations', automation: 'Nope' } });
    expect(field(body, 'error')).toContain("No automation 'Nope'");
  });

  it('a version named outright wins, and one nothing teaches is refused rather than answered', async () => {
    const named = await call(readBookHandler, { body: { handbook: 'automations', languageVersion: '0.12.0' } });
    expect(field(named.body, 'language')).toMatchObject({ version: '0.12.0', handbook: '0.12.8' });
    const refused = await call(readBookHandler, { body: { handbook: 'automations', languageVersion: '0.9.0' } });
    expect(String(field(refused.body, 'error'))).toContain('0.9.0');
    expect(field(refused.body, 'content')).toBeUndefined();
  });

  it('another handbook is the same book under any version', async () => {
    onPin('0.12.13');
    const { body } = await call(readBookHandler, { body: { handbook: 'knowledge-model', automation: 'movement-1' } });
    expect(field(body, 'bookId')).toBe('knowledge-model');
  });
});

describe('searchLanguage', () => {
  it("a 0.12 automation searches 0.12's book", async () => {
    onPin('0.12.13');
    const { body } = await call(searchLanguageHandler, { body: { query: 'run on demand manual', automation: 'movement-1' } });
    expect(field(body, 'language')).toMatchObject({ version: '0.12.13' });
    expect(JSON.stringify(field(body, 'results'))).not.toContain('-[:Invocations]->');
  });

  it('a new automation searches the current book', async () => {
    const { body } = await call(searchLanguageHandler, { body: { query: 'COALESCE' } });
    expect(field(body, 'language')).toBeUndefined();
    expect(field(body, 'results')).toEqual(expect.any(Array));
  });
});

describe('showExample', () => {
  it('says plainly 0.12 has none, and answers from its own search', async () => {
    onPin('0.12.13');
    const { body } = await call(showExampleHandler, { body: { query: 'run on demand', automation: 'movement-1' } });
    expect(body).toEqual(expect.stringContaining('has no micro examples'));
    expect(body).not.toEqual(expect.stringContaining('-[:Invocations]->'));
  });

  it('a new automation gets the micro examples', async () => {
    const { body } = await call(showExampleHandler, { body: {} });
    expect(body).toEqual(expect.stringContaining('Every example'));
  });
});

describe('the systems', () => {
  it("listConnections is 0.12's catalog, labelled, with no current spelling", async () => {
    onPin('0.12.13');
    const { body } = await call(listCatalogHandler, { query: { automation: 'movement-1' } });
    expect(field(body, 'language')).toMatchObject({ version: '0.12.13' });
    expect(Object.keys(field(body, 'adapters') as object)).toEqual(expect.arrayContaining(['manual', 'attio']));
    expect(JSON.stringify(body)).not.toContain('writtenAs');
  });

  it("describeConnection answers in 0.12's words, and says what it does not read", async () => {
    onPin('0.12.13');
    const { body } = await call(describeInstanceHandler, { body: { system: 'manual', position: 'x', automation: 'movement-1' } });
    expect(body).toEqual(expect.stringContaining('### manual'));
    expect(body).toEqual(expect.stringContaining('Invocation'));
    expect(body).toEqual(expect.stringContaining('position: not read under 0.12.13'));
  });

  it("getStarted is 0.12's front page and systems", async () => {
    onPin('0.12.13');
    const { body } = await call(getStartedHandler, { query: { automation: 'movement-1' } });
    expect(body).toEqual(expect.stringContaining('written in language 0.12.13'));
    expect(body).toEqual(expect.stringContaining('connect attio using acme'));
    expect(body).toEqual(expect.stringContaining('### manual'));
  });
});
