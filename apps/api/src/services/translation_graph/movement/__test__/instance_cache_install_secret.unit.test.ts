// A remote module is read with its install's own secret. A person reading it
// at author time does so only if they may use that secret; otherwise the module
// answers as one with no secret, as the catalog reports it. A run reads it
// whoever started it.

import type { TeamId } from '../../../../generated/kysely/core/Team';

const mockState: { installSecret: string | null; usable: boolean } = { installSecret: 'secret-1', usable: false };
const mockAsked = jest.fn();

jest.mock('../../adapters/resolve', () => ({ resolveAdapter: jest.fn() }));

jest.mock('../../adapters/remote/store', () => ({
  getRemoteAdapter: async () => ({ adapter_type: 'acme_crm', credentials_id: mockState.installSecret }),
  rowToManifest: () => ({ methods: [] }),
}));

jest.mock('../../../access/decide', () => ({
  accessTo: async (...args: unknown[]) => {
    mockAsked(...args);
    return mockState.usable;
  },
}));

import { clearIntrospectionCache, cachedAdapterInstance } from '../instance_cache';
import { resolveAdapter } from '../../adapters/resolve';

const resolveAdapterMock = resolveAdapter as jest.Mock;
const TEAM = 'team-1' as TeamId;
const person = { for: { userId: 'u1', teamId: 'team-1', access: 'write', scopes: ['*'], pinnedTeamId: null } } as const;
const READ = { teamId: TEAM, types: [] as string[] };

const fakeAdapter = {
  listEntryPoints: async () => [],
  describe: async () => null,
};

beforeEach(() => {
  clearIntrospectionCache();
  mockAsked.mockClear();
  resolveAdapterMock.mockReset();
  resolveAdapterMock.mockResolvedValue(fakeAdapter);
  mockState.installSecret = 'secret-1';
  mockState.usable = false;
});

describe('reading a remote module with its install secret', () => {
  it('is refused as a module with no secret is, for a person who may not use the secret', async () => {
    await expect(cachedAdapterInstance({ ...READ, adapterType: 'acme_crm', audience: person })).rejects.toThrow(
      'Remote adapter "acme_crm" has no credential configured (credentials_id is null).',
    );
    expect(resolveAdapterMock).not.toHaveBeenCalled();
    expect(mockAsked).toHaveBeenCalledWith(person.for, { target: { thing: 'connection', id: 'secret-1' }, verb: 'use' });
  });

  it('goes through for a person who may use the secret', async () => {
    mockState.usable = true;
    await cachedAdapterInstance({ ...READ, adapterType: 'acme_crm', audience: person });
    expect(resolveAdapterMock).toHaveBeenCalledTimes(1);
  });

  it('is not served from what someone who may use the secret read a moment before', async () => {
    mockState.usable = true;
    await cachedAdapterInstance({ ...READ, adapterType: 'acme_crm', audience: person });
    mockState.usable = false;
    await expect(cachedAdapterInstance({ ...READ, adapterType: 'acme_crm', audience: person })).rejects.toThrow(/no credential configured/);
  });

  it('goes through for a run, which asks no one', async () => {
    await cachedAdapterInstance({ ...READ, adapterType: 'acme_crm', audience: { for: 'run' } });
    expect(resolveAdapterMock).toHaveBeenCalledTimes(1);
    expect(mockAsked).not.toHaveBeenCalled();
  });

  it('is decided by the provider credential, not the secret, when a connection names one', async () => {
    await cachedAdapterInstance({ ...READ, adapterType: 'acme_crm', audience: person, credentialsId: 'alice_hubspot' });
    expect(resolveAdapterMock).toHaveBeenCalledTimes(1);
  });

  it('asks no one about a built-in adapter', async () => {
    await cachedAdapterInstance({ ...READ, adapterType: 'attio', audience: person, credentialsId: 'c1' });
    expect(mockAsked).not.toHaveBeenCalled();
  });
});
