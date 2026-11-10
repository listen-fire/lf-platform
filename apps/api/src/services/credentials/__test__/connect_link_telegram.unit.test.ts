// The Telegram connect link names and reuses the team's one shared Telegram
// connection, so it asks the same question connecting the team from the app
// asks: may the asker use it. A link is minted only after that answer.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';

const mockState: { existing: { id: string; name: string } | undefined; usable: boolean; inserted: unknown[] } = {
  existing: undefined,
  usable: false,
  inserted: [],
};

jest.mock('../../../lib/kysely', () => {
  const chain: object = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'executeTakeFirst') return async () => mockState.existing;
        if (prop === 'values') {
          return (values: unknown) => {
            mockState.inserted.push(values);
            return chain;
          };
        }
        if (prop === 'execute') return async () => [];
        return () => chain;
      },
    },
  );
  return { ...jest.requireActual('../../../lib/kysely'), getAutomationsQb: () => chain, getCoreQb: () => chain };
});

const mockCreationChecked: unknown[] = [];
jest.mock('../../access/decide', () => ({
  ...jest.requireActual('../../access/decide'),
  accessTo: async () => mockState.usable,
  checkConnectionCreation: async (_principal: unknown, asked: unknown) => {
    mockCreationChecked.push(asked);
  },
}));

jest.mock('../../translation_graph/adapters/telegram/handshake', () => ({
  ...jest.requireActual('../../translation_graph/adapters/telegram/handshake'),
  builtInBotUsername: () => 'ListenFireBot',
}));

import { runWithPrincipal } from 'principal';

import { mintConnectLink } from '../connect_link';

const TEAM = '11111111-1111-4111-8111-111111111111' as TeamId;
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as UserId;

const mint = (use?: { kind: 'team' }[]) =>
  runWithPrincipal({ teamId: TEAM, userId: ALICE, access: 'write', scopes: ['*'], pinnedTeamId: null }, () =>
    mintConnectLink({ teamId: TEAM, userId: ALICE, adapterSlug: 'telegram', ...(use !== undefined ? { use } : {}) }),
  );

beforeEach(() => {
  mockState.existing = { id: 'c0000000-0000-4000-8000-000000000001', name: 'Team Telegram' };
  mockState.usable = false;
  mockState.inserted = [];
  mockCreationChecked.length = 0;
});

describe('mintConnectLink for Telegram, with a team Telegram connection already there', () => {
  it('refuses, naming neither the connection nor its id, when the asker may not use it', async () => {
    const answer = await mint();
    expect(answer).toEqual({ error: "The team's Telegram connection is one you may not use." });
    expect(JSON.stringify(answer)).not.toContain('Team Telegram');
    expect(mockState.inserted).toEqual([]);
  });

  it('promises the connection by its name, when the asker may use it', async () => {
    mockState.usable = true;
    const answer = await mint();
    expect(answer).toMatchObject({ connectKind: 'handshake', credentialName: 'Team Telegram' });
    expect(mockState.inserted).toHaveLength(1);
  });

  it('carries no statement when it reuses the connection, and refuses one given, pointing at setAccess', async () => {
    mockState.usable = true;
    await mint();
    expect(mockState.inserted).toEqual([expect.objectContaining({ use_statement: null })]);
    mockState.inserted = [];
    expect(await mint([{ kind: 'team' }])).toEqual({ error: expect.stringContaining('setAccess') });
    expect(mockState.inserted).toEqual([]);
  });

  it('mints under the default name when the team has none, carrying who may use what it creates', async () => {
    mockState.existing = undefined;
    expect(await mint([{ kind: 'team' }])).toMatchObject({ connectKind: 'handshake' });
    expect(mockCreationChecked).toEqual([{ teamId: TEAM, use: [{ kind: 'team' }] }]);
    expect(mockState.inserted).toEqual([expect.objectContaining({ use_statement: JSON.stringify([{ kind: 'team' }]) })]);
  });

  it('refuses a link that would create the connection with no statement of who may use it', async () => {
    mockState.existing = undefined;
    expect(await mint()).toEqual({ error: expect.stringContaining('needs a statement of who may use it') });
    expect(mockState.inserted).toEqual([]);
  });
});
