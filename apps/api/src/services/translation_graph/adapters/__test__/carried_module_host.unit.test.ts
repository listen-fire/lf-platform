// A carried version's module is hosted as this release's is: the same line's
// stored credential, read through the platform's secrets store, refreshed
// under the store's one lock. Two versions holding the same connection and
// finding its token expired refresh it once between them.

const vault: { current?: ReturnType<typeof import('movement-engine/public/secrets').createMemoryVault> } = {};
jest.mock('../../../credentials/secrets_postgres', () => ({
  ...jest.requireActual('../../../credentials/secrets_postgres'),
  postgresSecrets: () => {
    if (vault.current === undefined) throw new Error('no vault seeded');
    return vault.current;
  },
}));

import { createMemoryVault } from 'movement-engine/public/secrets';
import { airtableModule } from '@listen-fire/airtable';

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { moduleHostFor } from '../builtin_modules';

const TEAM = '00000000-0000-4000-8000-0000000000a1' as TeamId;
const CREDENTIAL = 'cred-airtable';

describe("a carried version's module, hosted by the platform", () => {
  const env = { ...process.env };
  let tokenCalls = 0;
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.AIRTABLE_CLIENT_ID = 'client';
    process.env.AIRTABLE_CLIENT_SECRET = 'secret';
    tokenCalls = 0;
    // The provider's token endpoint: each refresh is one call.
    global.fetch = (async () => {
      tokenCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ access_token: `fresh-${tokenCalls}`, refresh_token: 'r2', expires_in: 3600, token_type: 'bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    vault.current = createMemoryVault({
      [CREDENTIAL]: { access_token: 'stale', refresh_token: 'r1', expires_at: new Date(Date.now() - 60_000).toISOString() },
    });
  });
  afterEach(() => {
    process.env = { ...env };
    global.fetch = realFetch;
  });

  /** The credential each version's module is handed for the same install. */
  const credentialOf = () =>
    moduleHostFor({
      adapterType: 'airtable',
      install: { teamId: TEAM, credentialsId: CREDENTIAL },
      declaration: { name: airtableModule.name, displayName: airtableModule.manifest.displayName, credentials: airtableModule.credentials },
    }).credential;

  it('refreshes an expired token once, however many versions ask at once', async () => {
    const [a, b] = await Promise.all([credentialOf().fields(), credentialOf().fields()]);
    expect(tokenCalls).toBe(1);
    // The memory vault keeps the fields as stored (the shape is the Postgres
    // store's); both versions read the one refreshed token.
    expect(a).toMatchObject({ access_token: 'fresh-1' });
    expect(b).toMatchObject({ access_token: 'fresh-1' });
  });

  it("refuses a declaration this platform cannot read, by the module's name", () => {
    expect(() =>
      moduleHostFor({
        adapterType: 'airtable',
        install: { teamId: TEAM, credentialsId: CREDENTIAL },
        declaration: { name: '@lf/airtable', displayName: 'Airtable', credentials: [{ name: 'x', kind: 'telepathy' }] },
      }),
    ).toThrow(/module @lf\/airtable declares a credential "x" this platform cannot read/);
  });

  it('hosts no adapter type it has no line for', () => {
    expect(() =>
      moduleHostFor({ adapterType: 'nope', install: { teamId: TEAM }, declaration: { name: 'nope', displayName: 'Nope', credentials: [] } }),
    ).toThrow(/no module line/);
  });
});
