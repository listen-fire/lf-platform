// Nothing is created without saying who may use it. Every route that creates
// a connection asks for its use list before anything is stored, refusing one
// that is missing by naming it, and deciding the list as the creator's to give
// (a write member, on it themselves or through the team, naming only people on
// the team). Every route that creates an automation hands its read and write
// lists to the save, which decides them (provision_access covers that).
//
// The decision is the real one, over statements and memberships held in memory;
// what would store a connection is stood in for, so a refusal is seen to store
// nothing.

import type { Access } from 'principal';
import type { Grantee, Target, Verb } from '../../services/access/statement';

const TEAM = '11111111-1111-4111-8111-111111111111';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const mockMembers = new Map<string, Access>();
const mockCtx = { user: { id: ALICE, teamId: TEAM }, principal: { teamId: TEAM, userId: ALICE, access: 'write' as Access, scopes: ['*'], pinnedTeamId: null } };

jest.mock('../../services/context', () => ({
  ...jest.requireActual('../../services/context'),
  currentContext: () => mockCtx,
}));

jest.mock('../../services/access/statement', () => {
  const actual = jest.requireActual('../../services/access/statement');
  return {
    ...actual,
    StatementStore: {
      teamOf: async (_target: Target) => undefined,
      grantsOf: async (_target: Target, _options: { verb: Verb }) => [],
      hasAnyStatement: async () => false,
      membershipsOf: async (userId: string, teamIds: string[]) =>
        new Map(teamIds.flatMap((teamId) => (teamId === TEAM && mockMembers.has(userId) ? [[teamId, mockMembers.get(userId)] as const] : []))),
      membershipsAmong: async (teamId: string, userIds: string[]) =>
        new Map(teamId === TEAM ? userIds.flatMap((userId) => (mockMembers.has(userId) ? [[userId, mockMembers.get(userId)] as const] : [])) : []),
    },
  };
});

const mockCreated = {
  persist: jest.fn(async (_input: unknown) => 'new-connection'),
  ensureTelegram: jest.fn(async (_input: unknown) => ({ id: 'tg', name: 'Telegram', created: true })),
  install: jest.fn(async (_input: unknown) => ({ id: 'install', credentialsId: 'secret' })),
  staticCredential: jest.fn(async (_input: unknown) => ({ credentialsId: 'provider' })),
  signIn: jest.fn(async (_input: unknown) => ({ url: 'https://provider.example/authorize', state: 'state' })),
  save: jest.fn(async (_input: unknown) => ({ ok: false, errors: ['not saved'], catalogNotes: [] })),
};

jest.mock('../../services/credentials/persist_credential', () => ({
  ...jest.requireActual('../../services/credentials/persist_credential'),
  persistCredential: (input: unknown) => mockCreated.persist(input),
}));
jest.mock('../../lib/pendingCredentials', () => ({ claimPendingCredentials: async () => ({ accessToken: 'claimed' }) }));
jest.mock('../../services/translation_graph/adapters/telegram/handshake', () => ({
  ...jest.requireActual('../../services/translation_graph/adapters/telegram/handshake'),
  ensureSharedTelegramTeamCredential: (input: unknown) => mockCreated.ensureTelegram(input),
}));
jest.mock('../../services/translation_graph/adapters/remote/install', () => ({
  ...jest.requireActual('../../services/translation_graph/adapters/remote/install'),
  installRemoteAdapterFromManifest: (input: unknown) => mockCreated.install(input),
}));
jest.mock('../../services/credentials/remote_module_connect', () => ({
  ...jest.requireActual('../../services/credentials/remote_module_connect'),
  createStaticRemoteModuleCredential: (input: unknown) => mockCreated.staticCredential(input),
  beginRemoteModuleSignIn: (input: unknown) => mockCreated.signIn(input),
}));
jest.mock('../../services/translation_graph/movement/provision', () => ({
  ...jest.requireActual('../../services/translation_graph/movement/provision'),
  saveMovement: (input: unknown) => mockCreated.save(input),
}));
jest.mock('../../services/translation_graph/adapters/remote/store', () => ({
  ...jest.requireActual('../../services/translation_graph/adapters/remote/store'),
  getRemoteAdapter: async () => null,
}));

// No connection exists yet: every lookup of one finds nothing.
jest.mock('../../lib/kysely', () => {
  const chain: object = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'executeTakeFirst') return async () => undefined;
        if (prop === 'execute') return async () => [];
        return () => chain;
      },
    },
  );
  return { ...jest.requireActual('../../lib/kysely'), getAutomationsQb: () => chain, getCoreQb: () => chain, getQb: () => chain };
});

import { runWithPrincipal } from 'principal';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';

import { trpc } from '../trpc/trpc';
import { connectionsRouter } from '../trpc/views/connections';
import { credentialsRouter } from '../trpc/views/credentials';
import { movementRouter } from '../trpc/views/movement';
import { remoteAdapterRouter } from '../trpc/views/remoteAdapter';
import { automationConnectorOptions } from '../mcp/connectors/automation';

const team: Grantee = { kind: 'team' };
const user = (userId: string): Grantee => ({ kind: 'user', userId });

const asAlice = <T>(fn: () => Promise<T>): Promise<T> => runWithPrincipal(mockCtx.principal, fn);
const caller = <R extends { createCaller: (ctx: { authorise: () => Promise<void> }) => unknown }>(router: R) =>
  router.createCaller({ authorise: async () => {} }) as ReturnType<R['createCaller']>;

const MANIFEST = {
  protocolVersion: 2,
  adapterType: 'hubspot',
  baseUrl: 'https://module.example.com',
  authStrategy: { kind: 'bearer' },
  supportedTriggers: [],
  runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
  methods: ['describe'],
};

/** Each route that creates a connection, called with this use list (or none). */
const CONNECTION_CREATIONS: [string, (use: Grantee[] | undefined) => Promise<unknown>, keyof typeof mockCreated][] = [
  [
    'views.credentials.addCredential',
    (use) => caller(credentialsRouter(trpc.procedure)).addCredential({ name: 'Attio', type: ExternalServiceType.ATTIO, claimToken: 'claim', ...(use ? { use } : {}) }),
    'persist',
  ],
  ['views.connections.connectTelegramTeam', (use) => caller(connectionsRouter(trpc.procedure)).connectTelegramTeam(use ? { use } : undefined), 'ensureTelegram'],
  [
    'views.remoteAdapter.upsertFromManifest, with a secret',
    (use) => caller(remoteAdapterRouter(trpc.procedure)).upsertFromManifest({ ...MANIFEST, secret: 's', ...(use ? { use } : {}) } as never),
    'install',
  ],
  [
    'views.remoteAdapter.createStaticCredential',
    (use) =>
      caller(remoteAdapterRouter(trpc.procedure)).createStaticCredential({
        adapterType: 'hubspot',
        declaredCredential: 'api_key',
        name: 'team_key',
        fields: {},
        ...(use ? { use } : {}),
      }),
    'staticCredential',
  ],
  [
    'views.remoteAdapter.beginOAuthCredential',
    (use) =>
      caller(remoteAdapterRouter(trpc.procedure)).beginOAuthCredential({
        adapterType: 'hubspot',
        declaredCredential: 'oauth',
        name: 'alice_hubspot',
        ...(use ? { use } : {}),
      }),
    'signIn',
  ],
];

beforeEach(() => {
  mockMembers.clear();
  mockMembers.set(ALICE, 'write');
  mockMembers.set(BOB, 'write');
  mockCtx.principal.access = 'write';
  for (const created of Object.values(mockCreated)) created.mockClear();
});

describe.each(CONNECTION_CREATIONS)('%s', (_, create, effect) => {
  it('refuses a connection with no statement of who may use it, naming what is missing, and stores nothing', async () => {
    const refused = asAlice(() => create(undefined));
    // Connecting the team to Telegram answers its refusals as a result, for the page to name in its own words.
    if (effect === 'ensureTelegram') await expect(refused).resolves.toEqual({ ok: false, reason: 'needs_use' });
    else await expect(refused).rejects.toThrow('A new connection needs a statement of who may use it.');
    expect(mockCreated[effect]).not.toHaveBeenCalled();
  });

  it('refuses a use list its creator is not on, one naming a stranger to the team, and a read member creating', async () => {
    await expect(asAlice(() => create([user(BOB)]))).rejects.toThrow(/could not use: put yourself, or the team/);
    await expect(asAlice(() => create([user('cccccccc-cccc-4ccc-8ccc-cccccccccccc')]))).rejects.toThrow(/Only people on the team/);
    mockCtx.principal.access = 'read';
    await expect(asAlice(() => create([team]))).rejects.toThrow(/Only someone with write access/);
    expect(mockCreated[effect]).not.toHaveBeenCalled();
  });

  it('creates it with the list its creator gave', async () => {
    await asAlice(() => create([user(ALICE), user(BOB)]));
    expect(mockCreated[effect]).toHaveBeenCalledWith(expect.objectContaining({ use: [user(ALICE), user(BOB)] }));
  });
});

describe('views.movement.save', () => {
  it('hands the save the read and write lists it was given, for the save to decide', async () => {
    const statements = { read: [team], write: [user(ALICE)] };
    await asAlice(() => caller(movementRouter(trpc.procedure)).save({ source: 'x', statements }));
    expect(mockCreated.save).toHaveBeenCalledWith(expect.objectContaining({ statements }));
  });
});

describe('what an agent is told', () => {
  const tools = automationConnectorOptions().tools ?? {};

  it.each(['saveAutomation', 'connectSystem', 'setAccess'])('%s says the lists are its person’s to give, never its own choice', (name) => {
    const tool = tools[name];
    if (tool === undefined) throw new Error(`no tool ${name}`);
    const told = JSON.stringify([tool.description, Object.values(tool.inputSchema).map((field) => field.description)]);
    expect(told).toMatch(/Ask the person you are working for/);
    expect(told).toMatch(/never choose for them/);
  });
});
