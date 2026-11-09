// An install's own secret is a connection. `get` shows it as `list` does: a
// secret the caller may not use is not named. A form that saves the manifest
// back without it must leave the install connected, and must not let someone
// who may not use the secret point the install at another server.

const ctxUser = { id: 'user-1', teamId: 'team-1' };
const ctxPrincipal = {
  userId: ctxUser.id,
  teamId: ctxUser.teamId,
  access: 'write' as const,
  scopes: ['*'],
  pinnedTeamId: null,
};

const mockUsable = { secret: false };
jest.mock('../../../../services/access/decide', () => ({
  ...jest.requireActual('../../../../services/access/decide'),
  accessTo: async () => mockUsable.secret,
}));

jest.mock('../../../../services/context', () => ({
  currentContext: () => ({ user: ctxUser, principal: ctxPrincipal }),
}));

const getRemoteAdapterMock = jest.fn();
jest.mock('../../../../services/translation_graph/adapters/remote/store', () => ({
  ...jest.requireActual('../../../../services/translation_graph/adapters/remote/store'),
  getRemoteAdapter: (...args: unknown[]) => getRemoteAdapterMock(...args),
}));

const installMock = jest.fn();
jest.mock('../../../../services/translation_graph/adapters/remote/install', () => ({
  installRemoteAdapterFromManifest: (...args: unknown[]) => installMock(...args),
}));

import { remoteAdapterRouter } from '../remoteAdapter';
import { trpc } from '../../trpc';

const SECRET_ID = '00000000-0000-4000-8000-0000000000aa';

const MANIFEST = {
  protocolVersion: 2 as const,
  adapterType: 'acme_crm',
  baseUrl: 'https://adapter.example.com',
  authStrategy: { kind: 'bearer' as const },
  supportedTriggers: [],
  runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
  methods: [],
};

const INSTALL_ROW = {
  id: 'install-1',
  team_id: 'team-1',
  adapter_type: 'acme_crm',
  base_url: MANIFEST.baseUrl,
  auth_strategy: MANIFEST.authStrategy,
  credentials_id: SECRET_ID,
  manifest: { ...MANIFEST, credentialsId: SECRET_ID },
  created_at: new Date(0),
  updated_at: new Date(0),
};

const caller = () => remoteAdapterRouter(trpc.procedure).createCaller({ authorise: async () => {} });

beforeEach(() => {
  mockUsable.secret = false;
  getRemoteAdapterMock.mockReset().mockResolvedValue(INSTALL_ROW);
  installMock.mockReset().mockResolvedValue({ id: 'install-1', credentialsId: SECRET_ID });
});

describe('get', () => {
  it('leaves out an install secret the caller may not use', async () => {
    const manifest = await caller().get({ adapterType: 'acme_crm' });
    expect(manifest).not.toBeNull();
    expect(JSON.stringify(manifest)).not.toContain(SECRET_ID);
    expect(manifest?.credentialsId).toBeUndefined();
  });

  it('names an install secret the caller may use', async () => {
    mockUsable.secret = true;
    expect((await caller().get({ adapterType: 'acme_crm' }))?.credentialsId).toBe(SECRET_ID);
  });
});

describe('upsertFromManifest, saving the manifest back with no secret named', () => {
  it('keeps the secret the install holds, even for someone who may not use it', async () => {
    await caller().upsertFromManifest(MANIFEST);
    expect(installMock).toHaveBeenCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ credentialsId: SECRET_ID }) }));
  });

  it('refuses to point it at another server when the caller may not use the secret', async () => {
    await expect(caller().upsertFromManifest({ ...MANIFEST, baseUrl: 'https://elsewhere.example.com' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(installMock).not.toHaveBeenCalled();
  });

  it('lets someone who may use the secret point it at another server', async () => {
    mockUsable.secret = true;
    await caller().upsertFromManifest({ ...MANIFEST, baseUrl: 'https://elsewhere.example.com' });
    expect(installMock).toHaveBeenCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ credentialsId: SECRET_ID }) }));
  });

  it('installs with no secret when the install holds none', async () => {
    getRemoteAdapterMock.mockResolvedValue({ ...INSTALL_ROW, credentials_id: null });
    await caller().upsertFromManifest(MANIFEST);
    expect(installMock.mock.calls[0]?.[0].manifest.credentialsId).toBeUndefined();
  });

  it('installs with no secret when the module is new', async () => {
    getRemoteAdapterMock.mockResolvedValue(null);
    await caller().upsertFromManifest(MANIFEST);
    expect(installMock.mock.calls[0]?.[0].manifest.credentialsId).toBeUndefined();
  });
});
