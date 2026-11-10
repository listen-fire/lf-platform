// The `connectTelegram` mint mutation — thin wrapper that gates on
// `TELEGRAM_BOT_USERNAME`, pulls the (user, team) off the request context, mints
// a one-time token (the building-block `mintTelegramToken`, covered by its own
// tests) and assembles the `t.me/<bot>?start=<token>` link. Here we lock the
// wrapper's contract: the unset-username guard, and that a configured bot yields
// a well-formed url minted for the context user/team.

const mintMock = jest.fn();

jest.mock('../../../../services/access/decide', () => jest.requireActual('../../../../test/access_defaults').teamDefaults());
jest.mock('../../../../services/translation_graph/adapters/telegram/handshake', () => {
  const actual = jest.requireActual(
    '../../../../services/translation_graph/adapters/telegram/handshake',
  );
  return {
    ...actual,
    // Keep the real env-reader + url-builder; stub only the DB-bound mint.
    mintTelegramToken: (input: unknown) => mintMock(input),
  };
});

const ctxUser = { id: 'user-1', teamId: 'team-1' };
// The Context projects identity from the Principal now (C-10); a fake Context
// has to carry the Principal too, because that is what the shared procedure
// reads when nothing installed an ambient one.
const ctxPrincipal = {
  userId: ctxUser.id,
  teamId: ctxUser.teamId,
  access: 'write' as const,
  scopes: ['*'],
  pinnedTeamId: null,
};
jest.mock('../../../../services/context', () => ({
  currentContext: () => ({ user: ctxUser, principal: ctxPrincipal }),
}));

jest.mock('../../../../services/user', () => ({
  UserService: { getById: async () => ({ id: 'user-1' }) },
}));

jest.mock('../../../../services/context/one_transaction', () => ({ inOneTransaction: async <T>(fn: () => Promise<T>): Promise<T> => fn() }));

jest.mock('../../../../lib/credentials', () => ({
  encryptToken: async (plaintext: string) => `enc:${plaintext}`,
}));

// `getQb` mock — the connectTelegramTeam mutation does a SELECT (existing
// TELEGRAM credential?) then, when none, an INSERT. The holder lets a test set
// whether a row already exists and capture what got inserted.
const existingCredential = { row: undefined as { id: string } | undefined };
const insertCapture = { values: undefined as Record<string, unknown> | undefined };
jest.mock('../../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: () => ({
      where: () => ({
        where: () => ({
          select: () => ({
            executeTakeFirst: async () => existingCredential.row,
          }),
        }),
      }),
    }),
    insertInto: () => ({
      values: (values: Record<string, unknown>) => {
        insertCapture.values = values;
        return { executeTakeFirst: async () => undefined };
      },
    }),
  });
  return {
    getQb: qb,
    getCoreQb: qb,
    getAutomationsQb: qb,
    getKnowledgeQb: () => ({
      selectFrom: () => ({ where: () => ({ select: () => ({ execute: async () => [] }) }) }),
    }),
  };
});

import { connectionsRouter } from '../connections';
import { trpc } from '../../trpc';

function caller() {
  const router = connectionsRouter(trpc.procedure);
  return router.createCaller({ authorise: async () => {} });
}

beforeEach(() => {
  mintMock.mockReset();
  delete process.env.TELEGRAM_BOT_USERNAME;
  existingCredential.row = undefined;
  insertCapture.values = undefined;
});

describe('connectTelegram', () => {
  it('errors clearly when TELEGRAM_BOT_USERNAME is unset', async () => {
    await expect(caller().connectTelegram()).rejects.toThrow(/not configured/i);
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('mints for the context user/team and returns a well-formed t.me url', async () => {
    process.env.TELEGRAM_BOT_USERNAME = '@ListenFireBot';
    const expiresAt = new Date(Date.now() + 600_000);
    mintMock.mockResolvedValue({ token: 'TOK123', expiresAt });

    const res = await caller().connectTelegram();

    expect(mintMock).toHaveBeenCalledWith({ nativeUserId: 'user-1', teamId: 'team-1' });
    expect(res).toEqual({
      url: 'https://t.me/ListenFireBot?start=TOK123',
      token: 'TOK123',
      expiresAt,
    });
  });
});

describe('connectTelegramTeam (Chunk 7 — connect the shared bot via an empty credential)', () => {
  it('inserts one empty TELEGRAM credential for the team when none exists', async () => {
    const res = await caller().connectTelegramTeam({ use: [{ kind: 'team' }] });

    expect(res.created).toBe(true);
    expect(typeof res.id).toBe('string');
    expect(insertCapture.values).toBeDefined();
    expect(insertCapture.values?.type).toBe('TELEGRAM');
    expect(insertCapture.values?.team_id).toBe('team-1');
    expect(insertCapture.values?.user_id).toBe('user-1');
    expect(insertCapture.values?.identifier).toBeNull();
    // The encrypted payload is the empty object — no bot token (secret-less).
    expect(insertCapture.values?.credentials).toBe(`enc:${JSON.stringify({})}`);
  });

  it('refuses to create it with no statement of who may use it, inserting nothing', async () => {
    await expect(caller().connectTelegramTeam()).rejects.toThrow(/needs a statement of who may use it/);
    expect(insertCapture.values).toBeUndefined();
  });

  it('is idempotent — returns the existing credential without inserting a duplicate', async () => {
    existingCredential.row = { id: 'existing-cred' };

    const res = await caller().connectTelegramTeam();

    expect(res).toEqual({ id: 'existing-cred', created: false });
    expect(insertCapture.values).toBeUndefined();
  });
});
