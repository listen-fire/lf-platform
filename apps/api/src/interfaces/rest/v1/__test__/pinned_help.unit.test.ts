// An agent working on an automation is taught that automation's language
// version, through the real handlers: the current book answers the current
// version and a new automation; a version no entry carries (0.12, which this
// platform dropped, and a legacy id) is refused rather than answered from
// another version's book.

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
  it('a current automation is taught the current spelling, labelled', async () => {
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

  it('finds an automation by its exact name', async () => {
    jest.mocked(getMovementRow).mockResolvedValue(null);
    jest.mocked(getMovementRowByName).mockResolvedValue(row(LANGUAGE_VERSION));
    const { body } = await call(readBookHandler, { body: { handbook: 'automations', automation: 'Echo' } });
    expect(field(body, 'language')).toMatchObject({ version: LANGUAGE_VERSION });
  });

  it('names an automation that is not there', async () => {
    jest.mocked(getMovementRow).mockResolvedValue(null);
    jest.mocked(getMovementRowByName).mockResolvedValue(null);
    const { body } = await call(readBookHandler, { body: { handbook: 'automations', automation: 'Nope' } });
    expect(field(body, 'error')).toContain("No automation 'Nope'");
  });

  it('a version named outright wins, and one nothing teaches is refused rather than answered', async () => {
    const named = await call(readBookHandler, { body: { handbook: 'automations', languageVersion: LANGUAGE_VERSION } });
    expect(field(named.body, 'language')).toMatchObject({ version: LANGUAGE_VERSION });
    for (const pin of ['0.12.0', '0.9.0']) {
      const refused = await call(readBookHandler, { body: { handbook: 'automations', languageVersion: pin } });
      expect(String(field(refused.body, 'error'))).toContain(pin);
      expect(field(refused.body, 'content')).toBeUndefined();
    }
  });
});

describe('an automation on a version no entry carries', () => {
  it.each(['0.12.13', '4'])('on %s is refused by every help tool, never answered from another version', async (pin) => {
    onPin(pin);
    const answers = [
      await call(readBookHandler, { body: { handbook: 'automations', chapter: 'system:manual', automation: 'movement-1' } }),
      await call(searchLanguageHandler, { body: { query: 'run on demand manual', automation: 'movement-1' } }),
      await call(showExampleHandler, { body: { query: 'run on demand', automation: 'movement-1' } }),
      await call(listCatalogHandler, { query: { automation: 'movement-1' } }),
      await call(describeInstanceHandler, { body: { system: 'manual', automation: 'movement-1' } }),
      await call(getStartedHandler, { query: { automation: 'movement-1' } }),
    ];
    for (const { body } of answers) {
      expect(String(field(body, 'error'))).toContain(pin);
      expect(JSON.stringify(body)).not.toContain('-[:Invocations]->');
    }
  });
});

describe('searchLanguage', () => {
  it('a new automation searches the current book', async () => {
    const { body } = await call(searchLanguageHandler, { body: { query: 'COALESCE' } });
    expect(field(body, 'language')).toBeUndefined();
    expect(field(body, 'results')).toEqual(expect.any(Array));
  });
});

describe('showExample', () => {
  it('a new automation gets the micro examples', async () => {
    const { body } = await call(showExampleHandler, { body: {} });
    expect(body).toEqual(expect.stringContaining('Every example'));
  });
});
