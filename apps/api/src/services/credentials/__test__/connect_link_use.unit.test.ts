// A link that would create a connection is minted only with a well formed list
// of who may use it, decided as the asker at mint: the landing is reached by the
// token alone and never asks. Key entry and OAuth links are the two that create.

const mockState: { inserted: Record<string, unknown>[] } = { inserted: [] };

jest.mock('../../../lib/kysely', () => {
  const chain: object = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'executeTakeFirst') return async () => undefined;
        if (prop === 'execute') return async () => [];
        if (prop === 'values') {
          return (values: Record<string, unknown>) => {
            mockState.inserted.push(values);
            return chain;
          };
        }
        return () => chain;
      },
    },
  );
  return { ...jest.requireActual('../../../lib/kysely'), getAutomationsQb: () => chain, getCoreQb: () => chain };
});

import { runWithPrincipal } from 'principal';

import type { Grantee } from '../../access/statement';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';

import { services } from '../../../adapters/registry';
import { MISSING_USE_REFUSAL } from '../../access/stated_input';
import { mintConnectLink } from '../connect_link';

const TEAM = '11111111-1111-4111-8111-111111111111' as TeamId;
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as UserId;

const mint = (adapterSlug: string, use?: readonly Grantee[]) =>
  runWithPrincipal({ teamId: TEAM, access: 'write', scopes: ['*'], pinnedTeamId: null }, () =>
    mintConnectLink({ teamId: TEAM, userId: ALICE, adapterSlug, credentialName: 'Mine', ...(use !== undefined ? { use } : {}) }),
  );

beforeEach(() => {
  mockState.inserted = [];
  services.attio = {
    generateInstallUrl: async () => 'https://attio.example/authorize',
    handleCallback: async () => {},
  } as unknown as NonNullable<typeof services.attio>;
});

afterEach(() => {
  services.attio = undefined;
});

describe.each([
  ['a key entry link', 'granola', 'key-entry'],
  ['an OAuth link', 'attio', 'oauth'],
])('minting %s', (_, adapterSlug, connectKind) => {
  it('is refused with no use list, and stores no link', async () => {
    expect(await mint(adapterSlug)).toEqual({ error: MISSING_USE_REFUSAL });
    expect(mockState.inserted).toEqual([]);
  });

  it('is refused with a malformed use list, naming the bad value, and stores no link', async () => {
    const answer = await mint(adapterSlug, [{ kind: 'user', userId: '  ' }]);
    expect(answer).toEqual({ error: expect.stringContaining('"  "') });
    expect(mockState.inserted).toEqual([]);
  });

  it('is refused with an empty use list, and stores no link', async () => {
    expect(await mint(adapterSlug, [])).toEqual({ error: expect.stringContaining("can't be emptied") });
    expect(mockState.inserted).toEqual([]);
  });

  it('carries the use list it was given on the link', async () => {
    expect(await mint(adapterSlug, [{ kind: 'team' }])).toMatchObject({ connectKind });
    expect(mockState.inserted).toEqual([expect.objectContaining({ use_statement: JSON.stringify([{ kind: 'team' }]) })]);
  });
});
