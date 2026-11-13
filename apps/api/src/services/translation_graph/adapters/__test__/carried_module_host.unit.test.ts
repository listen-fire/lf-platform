// A carried version's module is hosted as this release's is: the same line's
// stored credential, read through the platform's secrets store, refreshed
// under the store's one lock. Two versions holding the same connection and
// finding its token expired refresh it once between them. And every module a
// carried version reaches has a line here: a retired one would otherwise fail
// only at run time.

const vault: { current?: ReturnType<typeof import('movement-engine/public/secrets').createMemoryVault> } = {};
jest.mock('../../../credentials/secrets_postgres', () => ({
  ...jest.requireActual('../../../credentials/secrets_postgres'),
  postgresSecrets: () => {
    if (vault.current === undefined) throw new Error('no vault seeded');
    return vault.current;
  },
}));

import { createMemoryVault } from 'movement-engine/public/secrets';
import { makeMetaPosition } from 'movement-engine/public/catalog';
import { BASE_RUNTIME_CAPABILITIES } from 'movement-engine/public/adapter';
import { defineModule, type ModuleContext } from 'module-kit';
import { airtableModule } from '@listen-fire/airtable';
import { carriedVersions } from '@listen-fire/language-versions';

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { BUILTIN_MODULES, loadBuiltinModule, moduleHostFor } from '../builtin_modules';

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

  /** This release's path to the same connection: its own Airtable line, loaded
   *  as every 0.15 run loads it (`loadBuiltinModule`). The module answers the
   *  token it is handed, so nothing else of Airtable's API is needed. */
  const currentReleaseToken = () => {
    const entry = BUILTIN_MODULES.airtable;
    if (entry?.kind !== 'adapter' || entry.line !== 'module') throw new Error('test: airtable is no module line');
    const probe = defineModule({
      kind: 'adapter',
      name: airtableModule.name,
      manifest: airtableModule.manifest,
      credentials: airtableModule.credentials,
      create: (ctx: ModuleContext) => ({
        adapterType: 'airtable',
        supportedTriggers: [],
        runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
        listEntryPoints: async () => [],
        describe: async () => null,
        resolveEntity: async () => ({ candidates: [] }),
        getFieldValue: async () => (await ctx.credential.fields()).access_token ?? null,
        getRelated: async () => [],
        createRecord: async () => {
          throw new Error('read-only');
        },
        updateRecord: async () => {
          throw new Error('read-only');
        },
        deleteRecord: async () => {
          throw new Error('read-only');
        },
      }),
    });
    const loaded = loadBuiltinModule({ ...entry, load: () => probe }, { teamId: TEAM, credentialsId: CREDENTIAL });
    return loaded.adapter.getFieldValue({ position: makeMetaPosition('airtable'), fieldId: 'token' });
  };

  it("refreshes an expired token once when a carried version's module and this release's find it expired together", async () => {
    const [carried, current] = await Promise.all([credentialOf().fields(), currentReleaseToken()]);
    expect(tokenCalls).toBe(1);
    // The memory vault keeps the fields as stored (the shape is the Postgres
    // store's); both versions read the one refreshed token.
    expect(carried).toMatchObject({ access_token: 'fresh-1' });
    expect(current).toBe('fresh-1');
  });

  it('every module a carried version reaches has a line on this platform', async () => {
    for (const version of carriedVersions()) {
      const { run } = version.provides;
      if (run.kind !== 'carried') continue;
      const lineless = (await run.lane()).hostedModuleTypes().filter((adapterType) => {
        const entry = BUILTIN_MODULES[adapterType];
        return entry?.kind !== 'adapter' || entry.line !== 'module';
      });
      expect([version.key, lineless]).toEqual([version.key, []]);
    }
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
