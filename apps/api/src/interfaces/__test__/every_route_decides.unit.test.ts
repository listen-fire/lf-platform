// Every route that reaches an automation or a connection asks the access
// decision, or is registered as exempt with its reason. The walk covers the
// REST trees under /v1/automation and /v1/asks (every layer of them, nested
// routers included), every MCP automation tool's endpoint, and every tRPC
// procedure, so a route added without a decision fails here.
//
// Then each route that decides is called as a write member of the team, on an
// automation whose statements name only someone else. It must refuse exactly
// as it refuses a name that does not exist, or leave the automation out of its
// list, and it must have asked the decision to get there. Again with read
// alone stated for the caller: a read route answers as it does for the
// automation, a list shows it, and a write route gives the read-only refusal.
// Neither pass may reach what a write route changes.

import { EventEmitter } from 'node:events';

import { runWithPrincipal, type Access, type Principal } from 'principal';

import type { RequestHandler } from 'express';
import type { Grantee, Target, Verb } from '../../services/access/statement';

const mockTeam = '11111111-1111-4111-8111-111111111111';
const TEAM = mockTeam;
const OTHER_TEAM = '22222222-2222-4222-8222-222222222222';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** What a route is asked about: the seeded automation's, or names that exist nowhere. */
type Refs = { automationId: string; automationName: string; runId: string; listenId: string; askId: string; deliveryId: string };

const mockSeeded: Refs = {
  automationId: 'd0000000-0000-4000-8000-000000000001',
  automationName: 'Deals',
  runId: 'e0000000-0000-4000-8000-000000000001',
  listenId: 'f0000000-0000-4000-8000-000000000001',
  askId: 'a0000000-0000-4000-8000-000000000001',
  deliveryId: 'b0000000-0000-4000-8000-000000000001',
};

const SEEDED = mockSeeded;

const MISSING: Refs = {
  automationId: 'd0000000-0000-4000-8000-00000000dead',
  automationName: 'Nowhere',
  runId: 'e0000000-0000-4000-8000-00000000dead',
  listenId: 'f0000000-0000-4000-8000-00000000dead',
  askId: 'a0000000-0000-4000-8000-00000000dead',
  deliveryId: 'b0000000-0000-4000-8000-00000000dead',
};

/** The same name in a second team, which the caller may read: a lookup must find it. */
const SECOND_DEALS = 'd0000000-0000-4000-8000-000000000002';

/** What a connection route is asked about: the seeded connection's, or names that exist nowhere. */
type ConnectionRefs = { connectionId: string; connectionName: string; subscriptionId: string };

const mockConnection: ConnectionRefs = {
  connectionId: 'c0000000-0000-4000-8000-000000000001',
  connectionName: 'Finance',
  subscriptionId: '90000000-0000-4000-8000-000000000001',
};

const CONNECTION = mockConnection;

const NO_CONNECTION: ConnectionRefs = {
  connectionId: 'c0000000-0000-4000-8000-00000000dead',
  connectionName: 'Nowhere',
  subscriptionId: '90000000-0000-4000-8000-00000000dead',
};

const FINANCE: Target<'connection'> = { thing: 'connection', id: CONNECTION.connectionId };

type Row = { teamId: string; target: Target; verb: Verb; grantee: Grantee };

/** What a write route changes: none of it may be reached by a caller who may not write. */
const mockEffects = {
  deleteMovement: jest.fn(async () => true),
  saveMovement: jest.fn(async () => ({ ok: false, errors: ['not saved'], catalogNotes: [] })),
  upgradeMovement: jest.fn(async () => ({ status: 'not_found' })),
  runMovementAsync: jest.fn(async () => ({ ok: true, runId: mockSeeded.runId, status: 'running', movementName: 'Deals' })),
  abortRun: jest.fn(async () => ({ runId: mockSeeded.runId })),
  resumeRun: jest.fn(async () => ({ runId: mockSeeded.runId, resumed: 1 })),
  replayThroughListen: jest.fn(async () => ({ outcome: 'replayed', runIds: [mockSeeded.runId] })),
  resumeListen: jest.fn(async () => ({ resumed: true, held: 0 })),
  cancelAskAndWake: jest.fn(async () => ({ ok: false, reason: 'not_found' })),
  deleteCredential: jest.fn(async () => undefined),
  grantSpreadsheet: jest.fn(async () => undefined),
  revokeSpreadsheet: jest.fn(async () => undefined),
  registerSubscription: jest.fn(async () => ({ externalId: 'hook', secret: 'secret' })),
};

/** A table's rows, as the stubbed query builder serves them to every query of it. */
type Table = Record<string, unknown>[];

const mockState: {
  things: Map<string, string>;
  members: Map<string, Access>;
  rows: Row[];
  asked: number;
  teams: string[];
  automations: { id: string; teamId: string; name: string; source?: string }[];
  activity: EventEmitter;
  connections: Table;
  subscriptions: Table;
  installs: Table;
  /** The connection the seeded listen is bound to, and the kind of source that needs one. */
  listenCredentialsId: string | null;
  /** Every table a route inserted into, updated or deleted from. */
  writes: string[];
  /** What each insert or update was given to store. */
  stored: { table: string; values: unknown }[];
} = {
  things: new Map(),
  members: new Map(),
  rows: [],
  asked: 0,
  teams: [TEAM],
  automations: [],
  activity: new EventEmitter(),
  connections: [],
  subscriptions: [],
  installs: [],
  listenCredentialsId: null,
  writes: [],
  stored: [],
};

jest.mock('../../services/access/statement', () => {
  const actual = jest.requireActual('../../services/access/statement');
  const same = (a: Target, b: Target) => a.thing === b.thing && a.id === b.id;
  const ask = () => {
    mockState.asked += 1;
  };
  return {
    ...actual,
    StatementStore: {
      teamOf: async (target: Target) => {
        ask();
        return mockState.things.get(`${target.thing}:${target.id}`);
      },
      grantsOf: async (target: Target, options: { teamId: string; verb: Verb }) => {
        ask();
        return mockState.rows
          .filter((r) => r.teamId === options.teamId && same(r.target, target) && r.verb === options.verb)
          .map((r) => r.grantee);
      },
      grantedIds: async (options: { thing: string; verb: Verb; teamIds: string[]; userId?: string }) => {
        ask();
        return new Set(
          mockState.rows
            .filter(
              (r) =>
                options.teamIds.includes(r.teamId) &&
                r.target.thing === options.thing &&
                r.verb === options.verb &&
                (r.grantee.kind === 'team' || (r.grantee.kind === 'user' && r.grantee.userId === options.userId)),
            )
            .map((r) => r.target.id),
        );
      },
      grantsAmong: async (options: { thing: string; teamId: string; ids: string[]; verbs: Verb[] }) => {
        ask();
        const lists = new Map<string, { verb: Verb; grantee: Grantee }[]>();
        for (const r of mockState.rows) {
          if (r.teamId !== options.teamId || r.target.thing !== options.thing) continue;
          if (!options.ids.includes(r.target.id) || !options.verbs.includes(r.verb)) continue;
          lists.set(r.target.id, [...(lists.get(r.target.id) ?? []), { verb: r.verb, grantee: r.grantee }]);
        }
        return lists;
      },
      hasAnyStatement: async (target: Target) => mockState.rows.some((r) => same(r.target, target)),
      membershipsOf: async (userId: string, teamIds: string[]) =>
        new Map(
          teamIds.flatMap((teamId) => {
            const access = mockState.members.get(`${teamId}:${userId}`);
            return access === undefined ? [] : [[teamId, access] as const];
          }),
        ),
      membershipsAmong: async (teamId: string, userIds: string[]) =>
        new Map(
          userIds.flatMap((userId) => {
            const access = mockState.members.get(`${teamId}:${userId}`);
            return access === undefined ? [] : [[userId, access] as const];
          }),
        ),
      replaceGrants: async (target: Target, options: { teamId: string; verb: Verb; grantees: Grantee[] }) => {
        mockState.writes.push('access_statement');
        mockState.rows = [
          ...mockState.rows.filter((r) => !(same(r.target, target) && r.verb === options.verb)),
          ...options.grantees.map((grantee) => ({ teamId: options.teamId, target, verb: options.verb, grantee })),
        ];
      },
    },
  };
});

jest.mock('../../services/access/whose', () => {
  type Owner = { teamId: string; automationId: string };
  const owners = (seeded: string) => (ids: readonly string[]) =>
    new Map<string, Owner>(
      ids.flatMap((id) => (id === seeded ? [[id, { teamId: mockTeam, automationId: mockSeeded.automationId }] as const] : [])),
    );
  const runs = owners(mockSeeded.runId);
  const listens = owners(mockSeeded.listenId);
  const asks = owners(mockSeeded.askId);
  return {
    Whose: {
      automationOfTriggerId: async (asked: { triggerId: string }) => listens([asked.triggerId]).get(asked.triggerId),
      automationsOfRuns: async (asked: { runIds: string[] }) => runs(asked.runIds),
      automationsOfListens: async (asked: { triggerIds: string[] }) => listens(asked.triggerIds),
      automationsOfAsks: async (asked: { askIds: string[] }) => asks(asked.askIds),
      automationsReachedBy: async (asked: { deliveryId: string }) => ({
        automationIds: new Set(asked.deliveryId === mockSeeded.deliveryId ? [mockSeeded.automationId] : []),
        untraced: false,
      }),
      automationOfRun: async (asked: { runId: string }) => runs([asked.runId]).get(asked.runId),
      automationOfListen: async (asked: { triggerId: string }) => listens([asked.triggerId]).get(asked.triggerId),
      automationOfAsk: async (asked: { askId: string }) => asks([asked.askId]).get(asked.askId),
    },
  };
});

const mockPrincipal: Principal = { teamId: TEAM, userId: ALICE, access: 'write', scopes: ['*'], pinnedTeamId: null };

jest.mock('../../services/context', () => ({
  ...jest.requireActual('../../services/context'),
  currentContext: () => ({
    user: { id: mockPrincipal.userId, teamId: mockTeam, isTeamReadonly: false },
    principal: mockPrincipal,
  }),
}));

jest.mock('../rest/v1/team_scope', () => ({
  ...jest.requireActual('../rest/v1/team_scope'),
  teamSetForReads: async () => mockState.teams,
  resolveToolTeam: async (team?: string) => team ?? mockState.teams[0],
  listAccessibleTeams: async () => mockState.teams.map((teamId) => ({ teamId, name: teamId, access: 'write', isPersonal: false })),
  teamNames: async (teams: string[]) => new Map(teams.map((t) => [t, t])),
}));

/** Rows for the routes that read tables directly; each answers every query, so only a decision keeps the automation out. */
jest.mock('../../lib/kysely', () => {
  const tables = (): Record<string, unknown[]> => ({
    external_service_credentials: mockState.connections,
    webhook_subscription: mockState.subscriptions,
    remote_adapter: mockState.installs,
    trigger: [
      {
        id: mockSeeded.listenId,
        team_id: mockTeam,
        movement_id: mockSeeded.automationId,
        name: 'Deals',
        kind: mockState.listenCredentialsId === null ? 'manual' : 'attio',
        config: {},
        credentials_id: mockState.listenCredentialsId,
        run_mode: 'live',
        created_at: new Date(0),
        updated_at: new Date(0),
      },
    ],
    trigger_run: [
      {
        id: mockSeeded.runId,
        trigger_id: mockSeeded.listenId,
        team_id: mockTeam,
        status: 'success',
        nodes_written: 0,
        dry_run: false,
        steps: [],
        errors: [],
        started_at: new Date(0),
        completed_at: null,
        failed_at: null,
        failure_reason: null,
        created_at: new Date(0),
      },
    ],
    movement: [{ id: mockSeeded.automationId, name: 'Deals' }],
  });
  const stub = (): unknown => {
    let rows: unknown[] = [];
    let table = '';
    const chain: object = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') return undefined;
          if (prop === 'selectFrom' || prop === 'updateTable' || prop === 'deleteFrom' || prop === 'insertInto') {
            return (name: string) => {
              table = name;
              if (prop !== 'selectFrom') mockState.writes.push(name);
              rows = tables()[name] ?? [];
              return chain;
            };
          }
          if (prop === 'values' || prop === 'set') {
            return (values: unknown) => {
              mockState.stored.push({ table, values });
              return chain;
            };
          }
          if (prop === 'execute') return async () => rows;
          if (prop === 'executeTakeFirst') return async () => rows[0];
          if (prop === 'executeTakeFirstOrThrow') {
            return async () => {
              if (rows[0] === undefined) throw new Error('no result');
              return rows[0];
            };
          }
          return () => chain;
        },
      },
    );
    return chain;
  };
  return {
    ...jest.requireActual('../../lib/kysely'),
    getAutomationsQb: stub,
    getKnowledgeQb: stub,
    getAsksQb: stub,
    getCoreQb: stub,
    getQb: stub,
  };
});

jest.mock('../../services/translation_graph/movement/store', () => {
  const actual = jest.requireActual('../../services/translation_graph/movement/store');
  const row = (a: { id: string; teamId: string; name: string; source?: string }) => ({
    id: a.id,
    teamId: a.teamId,
    name: a.name,
    source: a.source ?? 'listen to manual-[:Invocations]-> fire deals\n',
    languageVersion: '0.15.0',
    validityStatus: null,
    validityCheckedAt: null,
    validityCheckedAgainst: null,
    triggerId: null,
  });
  return {
    ...actual,
    getMovementRow: async (input: { teamId: string; id: string }) => {
      const found = mockState.automations.find((a) => a.teamId === input.teamId && a.id === input.id);
      return found === undefined ? null : row(found);
    },
    getMovementRowByName: async (input: { teamId: string; name: string }) => {
      const found = mockState.automations.find((a) => a.teamId === input.teamId && a.name === input.name);
      return found === undefined ? null : row(found);
    },
    listMovementRows: async (teamId: string) => mockState.automations.filter((a) => a.teamId === teamId).map(row),
  };
});

jest.mock('../../services/translation_graph/movement/provision', () => {
  const actual = jest.requireActual('../../services/translation_graph/movement/provision');
  const item = (a: { id: string; teamId: string; name: string }) => ({
    id: a.id,
    teamId: a.teamId,
    name: a.name,
    source: 'listen to manual-[:Invocations]-> fire deals\n',
    revision: 'r1',
    languageVersion: '0.15.0',
    validityStatus: null,
    validityCheckedAt: null,
    validityCheckedAgainst: null,
    upgradeDiagnostics: null,
    kind: 'manual',
    listeners: [{ triggerId: mockSeeded.listenId, name: 'Deals', kind: 'manual' }],
  });
  return {
    ...actual,
    listMovements: async (teamId: string) => mockState.automations.filter((a) => a.teamId === teamId).map(item),
    getMovement: async (input: { teamId: string; id: string }) => {
      const found = mockState.automations.find((a) => a.teamId === input.teamId && a.id === input.id);
      return found === undefined ? null : item(found);
    },
    deleteMovement: () => mockEffects.deleteMovement(),
    saveMovement: () => mockEffects.saveMovement(),
  };
});

// A dependent's re-check after a save is the checker's; what is asked of it here is which importers it is handed.
jest.mock('../../services/translation_graph/movement/files', () => {
  const actual = jest.requireActual('../../services/translation_graph/movement/files');
  return {
    ...actual,
    checkMovementDependentsOf: (input: Record<string, unknown>) =>
      actual.checkMovementDependentsOf({ ...input, validate: async () => ({ ok: true, diagnostics: [] }) }),
  };
});

jest.mock('../../services/translation_graph/movement/language_upgrade', () => ({
  ...jest.requireActual('../../services/translation_graph/movement/language_upgrade'),
  upgradeMovement: () => mockEffects.upgradeMovement(),
}));

jest.mock('../../services/translation_graph/movement/story_token', () => ({
  ...jest.requireActual('../../services/translation_graph/movement/story_token'),
  storyTokenForMovement: async () => 'token',
  storyTokensForMovements: async (rows: { movementId: string }[]) => new Map(rows.map((r) => [r.movementId, 'token'])),
}));

jest.mock('../../services/translation_graph/movement/run_now', () => ({
  ...jest.requireActual('../../services/translation_graph/movement/run_now'),
  runMovementAsync: () => mockEffects.runMovementAsync(),
  getMovementRunStatus: async () => ({ runId: mockSeeded.runId, status: 'success' }),
  listMovementRuns: async () => [{ runId: mockSeeded.runId }],
  inspectMovementRun: async () => ({ runId: mockSeeded.runId }),
}));

jest.mock('../../services/interaction/operator', () => ({
  ...jest.requireActual('../../services/interaction/operator'),
  abortRun: () => mockEffects.abortRun(),
  resumeRun: () => mockEffects.resumeRun(),
}));

jest.mock('../../services/interaction/answer_surfaces', () => ({
  ...jest.requireActual('../../services/interaction/answer_surfaces'),
  listOpenAsksForTeam: async (teamId: string) =>
    teamId === mockTeam
      ? [{ requestId: mockSeeded.askId, interactionType: 'Check', resultType: {}, args: { title: 'Deals?' } }]
      : [],
  answerForTeam: async () => ({ ok: true, result: { requestId: mockSeeded.askId, runId: mockSeeded.runId, answer: true } }),
}));

jest.mock('../../services/interaction/observability', () => ({
  ...jest.requireActual('../../services/interaction/observability'),
  listParkedRuns: async () => [{ runId: mockSeeded.runId, automationName: 'Deals' }],
  listTeamRuns: async () => [{ runId: mockSeeded.runId, automationName: 'Deals' }],
}));

jest.mock('../../services/interaction/ask_records', () => ({
  ...jest.requireActual('../../services/interaction/ask_records'),
  listAskRecordsForTeam: async () => [{ askId: mockSeeded.askId, awaitingAutomationName: 'Deals' }],
  answerAskRecordForTeam: async () => ({ askId: mockSeeded.askId, state: 'answered' }),
}));

jest.mock('../../services/inbound/arrival_ledger', () => ({
  ...jest.requireActual('../../services/inbound/arrival_ledger'),
  movementEventsImpl: async () => [
    { triggerId: mockSeeded.listenId, id: mockSeeded.runId, status: 'success', failureReason: null },
  ],
}));

jest.mock('../../services/inbound/listen_replay', () => ({
  ...jest.requireActual('../../services/inbound/listen_replay'),
  replayThroughListen: () => mockEffects.replayThroughListen(),
}));

jest.mock('../../services/inbound/listen_pause', () => ({
  ...jest.requireActual('../../services/inbound/listen_pause'),
  resumeListen: () => mockEffects.resumeListen(),
}));

jest.mock('../../services/asks/store', () => {
  const ask = {
    id: mockSeeded.askId,
    teamId: mockTeam,
    family: 'Check',
    answerType: null,
    prompt: 'Close Deals?',
    detail: null,
    options: null,
    rows: null,
    state: 'open',
    answer: null,
    token: 'ask_token',
    url: 'https://example.test/api/asks/ask_token',
    tokenExpiresAt: new Date(0),
    provenance: { runId: mockSeeded.runId },
    callbackUrl: null,
    createdAt: new Date(0),
    answeredAt: null,
    expiredAt: null,
  };
  return {
    ...jest.requireActual('../../services/asks/store'),
    getAsk: async (id: string) => (id === mockSeeded.askId ? ask : null),
    listAsksForTeam: async (teamId: string) => (teamId === mockTeam ? [ask] : []),
  };
});

jest.mock('../../services/asks/doors', () => ({
  ...jest.requireActual('../../services/asks/doors'),
  cancelAskAndWake: () => mockEffects.cancelAskAndWake(),
}));

jest.mock('../../services/inbound/show_request', () => {
  const actual = jest.requireActual('../../services/inbound/show_request');
  return {
    ...actual,
    showDeliveryRequest: async (input: { deliveryId: string }) =>
      input.deliveryId === mockSeeded.deliveryId
        ? { outcome: 'shown', deliveryId: input.deliveryId, receivedAt: new Date(0), source: 'webhook', replayOf: null, kept: { kind: 'page', adapter: 'manual', credential: null, arrivals: [] } }
        : actual.noSuchDelivery(input.deliveryId),
  };
});

jest.mock('../../services/user', () => ({
  UserService: { getById: async (id: string) => ({ id, email: 'alice@example.com', username: 'alice' }) },
}));

jest.mock('../../lib/message_queue', () => {
  const actual = jest.requireActual('../../lib/message_queue');
  const exchange = { node: () => ({ attachTo: () => mockState.activity }), activityByTeamId: {}, recordedByTriggerId: {} };
  return { ...actual, mq: { ...actual.mq, triggerRunActivity: exchange, triggerRuns: exchange } };
});

// What the connection routes reach beyond the tables: nothing here talks to a
// provider, so describing a usable connection says its introspection failed,
// which is all a test needs to tell it from a missing one.
jest.mock('../../services/translation_graph/movement/instance_cache', () => ({
  ...jest.requireActual('../../services/translation_graph/movement/instance_cache'),
  cachedAdapterInstance: async () => {
    throw new Error('no network in this test');
  },
  introspectAdapterInstanceCached: async () => {
    throw new Error('no network in this test');
  },
  adapterInstanceIsWarm: () => false,
}));

jest.mock('../../lib/credentials', () => ({
  ...jest.requireActual('../../lib/credentials'),
  decryptToken: async () => JSON.stringify({ accessToken: 'token', refreshToken: 'refresh', expiresAt: 0, secret: 'module_secret' }),
  encryptToken: async () => 'sealed',
}));

jest.mock('../../adapters/attio/apiClient', () => ({
  ...jest.requireActual('../../adapters/attio/apiClient'),
  getAttioClient: () => ({ listObjects: async () => [{ api_slug: 'deals' }] }),
}));

jest.mock('../../adapters/registry', () => {
  const actual = jest.requireActual('../../adapters/registry');
  const google = { authClient: { getGoogleClient: () => ({ getAccessToken: async () => ({ token: 'google_token' }) }) } };
  return { ...actual, services: { ...actual.services, google } };
});

jest.mock('../../services/translation_graph/adapters/resolve', () => ({
  ...jest.requireActual('../../services/translation_graph/adapters/resolve'),
  resolveAdapter: async () => ({
    listEntryPoints: async () => [{ id: 'deals' }],
    runtimeCapabilities: () => null,
    supportedTriggers: () => [],
    describe: async (typeId: string) => ({ id: typeId }),
  }),
}));

jest.mock('../../services/credentials/delete_credential', () => ({
  ...jest.requireActual('../../services/credentials/delete_credential'),
  deleteCredential: () => mockEffects.deleteCredential(),
}));

jest.mock('../../services/translation_graph/adapters/google_sheets/grants', () => ({
  ...jest.requireActual('../../services/translation_graph/adapters/google_sheets/grants'),
  grantSpreadsheet: () => mockEffects.grantSpreadsheet(),
  revokeSpreadsheet: () => mockEffects.revokeSpreadsheet(),
  listGrantedSpreadsheets: async () => [{ spreadsheetId: 'sheet', name: 'Ledger' }],
}));

jest.mock('../../services/webhook_sync/providers', () => {
  const actual = jest.requireActual('../../services/webhook_sync/providers');
  const provider = {
    defaultEventTypes: ['record.created'],
    canRegisterViaApi: true,
    registerSubscription: () => mockEffects.registerSubscription(),
  };
  return { ...actual, getWebhookProvider: () => provider };
});

jest.mock('../../services/credentials/remote_module_connect', () => ({
  ...jest.requireActual('../../services/credentials/remote_module_connect'),
  listRemoteModuleCredentials: async () => ({
    declarations: [
      {
        name: 'api',
        fields: [],
        kind: 'static',
        credentials: mockState.connections.map((row) => ({ id: row.id, name: row.name })),
      },
    ],
  }),
}));

// The sign-in routes' key client is an ES module jest does not load; no route here signs anyone in.
jest.mock('jwks-rsa', () => ({ __esModule: true, default: () => ({}) }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// An install asks its server for the manifest with the secret it names.
jest.mock('movement-engine/public/modules', () => ({
  ...jest.requireActual('movement-engine/public/modules'),
  fetchRemoteManifest: async () => ({}),
}));

import { automationConnectorOptions } from '../mcp/connectors/automation';
import { publicRouter, privateRouter } from '../rest';
import { automationRouter } from '../rest/v1/automation';
import { asksRouter } from '../rest/v1/asks';
import { viewsRouter } from '../trpc/views';
import { EXEMPT, READ_ONLY_MESSAGE, decisionsOf, registeredDecisions, restRoute } from '../access_route';

/**
 * How the walk treats a surface mounted on a REST root: it walks a router that
 * reaches automations, runs, questions or connections, so each of its routes
 * must decide; it passes over one exempt with its reason.
 */
type Surface = { walk: unknown } | { exempt: string };

const SIGNED_DOOR = 'a door whose provider signature or sender is the authority, no caller to decide for';
const TOKEN_LINK = 'a link whose token in the URL is the authority';
const MIDDLEWARE = 'middleware, which answers no route of its own';

/** What is mounted on the two REST roots (`rest/index.ts`), by route or by mount path. */
const ROOTS: { base: string; router: unknown; surfaces: Record<string, Surface> }[] = [
  {
    base: '/api/public',
    router: publicRouter,
    surfaces: {
      'GET /document/:/data': { exempt: 'a team document, no automation or connection' },
      'GET /icon': { exempt: 'an icon, no automation or connection' },
      'GET /feature_flags/:': { exempt: 'feature flags, no automation or connection' },
      'GET /integrations': { exempt: 'the integrations the platform offers, no connection' },
      'POST /integrations/suggest': { exempt: 'a suggestion to the operator, no automation or connection' },
      'POST /save_click_event': { exempt: 'analytics that answers nothing' },
      'GET /page_view': { exempt: 'analytics that answers nothing' },
      '/whatsapp': { exempt: SIGNED_DOOR },
      '/auth': { exempt: "sign-in, and the OAuth callbacks that finish a connect, whose signed state is the authority" },
    },
  },
  {
    base: '/api',
    router: privateRouter,
    surfaces: {
      'GET /authenticated': { exempt: 'whether the caller is signed in' },
      'POST /mailgun/callback': { exempt: SIGNED_DOOR },
      'POST /email/callback': { exempt: SIGNED_DOOR },
      'POST /resend/callback': { exempt: SIGNED_DOOR },
      'POST /auth/impersonate': EXEMPT.platformAdmin,
      'POST /auth/stop-impersonate': EXEMPT.platformAdmin,
      '/webhook': { exempt: "the mail provider's delivery events, signed by the provider" },
      '/v1/automation': { walk: automationRouter },
      '/v1': { exempt: "the caller's own identity" },
      '/v1/system': { exempt: "the system scope: the platform's operators and lf's runtime slots, acting for a tenant as a run does" },
      '/v1/knowledge': { exempt: 'the knowledge graph, no automation or connection' },
      '/v1/valuations': { exempt: 'valuation data, no automation or connection' },
      '/v1/asks': { walk: asksRouter },
    },
  },
];

/**
 * What `server.ts` mounts on the app itself, by the first thing each mount
 * names. The app is built inside the server's boot, so the walk cannot reach
 * it; this list is held to the server's text instead.
 */
const APP_MOUNTS: Record<string, string> = {
  "'/'": 'the root page, no automation or connection',
  'express.static': 'static files',
  HEALTH_CHECK_ENDPOINT: 'a health probe',
  WORKERS_HEALTH_ENDPOINT: 'a health probe',
  expressLogger: MIDDLEWARE,
  cookieParser: MIDDLEWARE,
  customHeadersExtractor: MIDDLEWARE,
  jsonBodyParser: MIDDLEWARE,
  urlencodedBodyParser: MIDDLEWARE,
  cors: MIDDLEWARE,
  contextInjector: MIDDLEWARE,
  createAuthenticationHandler: MIDDLEWARE,
  authorisationHandler: MIDDLEWARE,
  sentryScopeHandler: MIDDLEWARE,
  contextTransactionHandler: MIDDLEWARE,
  'Sentry.setupExpressErrorHandler': MIDDLEWARE,
  'http.createServer': 'the server itself',
  "'/api/resend'": "the inbound mail door's body parser, no route",
  // Undecided: it reads every connection of the key's team. Deciding use there needs a new connection to carry a statement (Task 6) first.
  "'/api/public/lf-secrets'": "lf's secrets slot, which serves the key's owner only the connections they may use (lf_secrets_router.integration); and its OAuth relay, whose signed state is the authority",
  "'/api/public/webhook-sync'": SIGNED_DOOR,
  "'/api/public/adapter'": "a remote module's push doors: the credential it presents is the authority",
  "'/api/public/telegram'": SIGNED_DOOR,
  "'/api/public/slack'": SIGNED_DOOR,
  "'/api/public/slack-actions'": SIGNED_DOOR,
  "'/api/files'": TOKEN_LINK,
  "'/api/story'": `${TOKEN_LINK}; the picture is drawn with the connections the automation runs on`,
  "'/api/connect'": `${TOKEN_LINK}, minted only after the use decision`,
  "'/api/asks'": `${TOKEN_LINK}: the human answer door`,
  "'/api/cb'": TOKEN_LINK,
  createOAuthRouter: 'MCP sign-in: the authorization server, no automation or connection',
  createProtectedResourceRouter: 'MCP sign-in: its metadata, no automation or connection',
  MCP_BASE_PATH: "MCP sign-in: its challenge to a request with no credential",
  mountMcpConnectors: "each product's MCP connector: the automation tools call the REST routes walked here",
  "'/api/public'": 'walked: the public root, and ahead of it what this deployment runs, before sign-in',
  "'/api/trpc'": 'walked: every tRPC procedure',
  "'/api'": 'walked: the private root',
};

/** The first thing each of the server's mounts names: a path, or the middleware or router it mounts. */
function appMounts(): string[] {
  const text = readFileSync(join(__dirname, '..', '..', 'server.ts'), 'utf8');
  const onApp = [...text.matchAll(/\bapp\.(?:use|get|post|put|patch|delete|all)\(\s*('[^']*'|[A-Za-z_$][\w$.]*)/g)];
  const givenApp = [...text.matchAll(/([A-Za-z_$][\w$.]*)\(app\)/g)];
  return [...new Set([...onApp, ...givenApp].flatMap((match) => (match[1] === undefined ? [] : [match[1]])))];
}

function statesOnly(automationId: string, teamId: string, grantee: Grantee): void {
  const target: Target = { thing: 'automation', id: automationId };
  mockState.things.set(`automation:${automationId}`, teamId);
  for (const verb of ['read', 'write', 'fire'] as const) mockState.rows.push({ teamId, target, verb, grantee });
}

beforeEach(() => {
  for (const effect of Object.values(mockEffects)) effect.mockClear();
  mockState.things = new Map();
  mockState.members = new Map([
    [`${TEAM}:${ALICE}`, 'write'],
    [`${TEAM}:${BOB}`, 'write'],
    [`${OTHER_TEAM}:${ALICE}`, 'write'],
  ]);
  mockState.rows = [];
  mockState.teams = [TEAM];
  mockState.automations = [{ id: SEEDED.automationId, teamId: TEAM, name: SEEDED.automationName }];
  statesOnly(SEEDED.automationId, TEAM, { kind: 'user', userId: BOB });
  mockState.things.set(`connection:${FINANCE.id}`, TEAM);
  mockState.rows.push({ teamId: TEAM, target: FINANCE, verb: 'use', grantee: { kind: 'user', userId: BOB } });
  mockState.connections = [
    {
      id: CONNECTION.connectionId,
      team_id: TEAM,
      name: CONNECTION.connectionName,
      type: 'ATTIO',
      credentials: 'sealed',
      // The module it may serve as an install's secret.
      app_id: 'acme_crm',
      declared_credential: null,
      created_at: new Date(1),
      updated_at: new Date(1),
    },
  ];
  mockState.subscriptions = [
    {
      id: CONNECTION.subscriptionId,
      team_id: TEAM,
      provider: 'ATTIO',
      credentials_id: CONNECTION.connectionId,
      external_webhook_id: null,
      webhook_secret: 'secret',
      status: 'active',
      subscriptions: [],
      created_at: new Date(0),
    },
  ];
  // A module install whose own secret is the connection.
  mockState.installs = [
    {
      id: 'e1000000-0000-4000-8000-000000000001',
      team_id: TEAM,
      adapter_type: 'acme_crm',
      base_url: 'https://adapter.example.com',
      auth_strategy: { kind: 'bearer' },
      credentials_id: CONNECTION.connectionId,
      manifest: {
        protocolVersion: 2,
        adapterType: 'acme_crm',
        baseUrl: 'https://adapter.example.com',
        authStrategy: { kind: 'bearer' },
        supportedTriggers: [],
        runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
        methods: [],
      },
      created_at: new Date(0),
      updated_at: new Date(0),
    },
  ];
  mockState.listenCredentialsId = CONNECTION.connectionId;
  mockState.writes = [];
  mockState.stored = [];
  mockState.asked = 0;
});

/** The world with no such connection: nothing names it, and nothing it owns is left. */
function withoutConnection(): void {
  mockState.things.delete(`connection:${FINANCE.id}`);
  mockState.connections = [];
  mockState.subscriptions = [];
  // The install stays; it holds no secret.
  mockState.installs = mockState.installs.map((install) => ({ ...install, credentials_id: null }));
  mockState.listenCredentialsId = null;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

type ExpressLayer = {
  name: string;
  regexp: RegExp & { fast_slash?: boolean };
  handle: { stack?: ExpressLayer[] };
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] };
};

/** Middleware that answers no route of its own: it only lets a request on, or turns it away. */
const KNOWN_MIDDLEWARE = new Set(['scopeGate']);

/**
 * Every route mounted in `router`, into its nested routers, and every layer
 * the walk cannot read: unknown middleware, or a router nested at a path
 * (whose routes' paths the walk cannot know), either of which could answer a
 * request no decision was asked for.
 */
function walkRest(router: unknown, base: string): { routes: { key: string; handler: RequestHandler }[]; unread: string[] } {
  const stack = (router as { stack: ExpressLayer[] }).stack;
  const routes: { key: string; handler: RequestHandler }[] = [];
  const unread: string[] = [];
  for (const layer of stack) {
    const route = layer.route;
    if (route !== undefined) {
      const handler = route.stack[route.stack.length - 1]?.handle;
      if (handler === undefined) unread.push(`${base}${route.path} (no handler)`);
      else for (const method of Object.keys(route.methods)) routes.push({ key: restRoute(method, `${base}${route.path}`), handler });
    } else if (layer.handle.stack !== undefined) {
      if (layer.regexp.fast_slash !== true) unread.push(`${base}: a router nested at a path`);
      else {
        const nested = walkRest(layer.handle, base);
        routes.push(...nested.routes);
        unread.push(...nested.unread);
      }
    } else if (!KNOWN_MIDDLEWARE.has(layer.name)) unread.push(`${base}: middleware ${layer.name}`);
  }
  return { routes, unread };
}

/**
 * Every surface on a REST root, as the walk finds it: a route, or a router or
 * middleware mounted at a path. A mount is known by the shortest listed path
 * its pattern takes, since a mount at `/v1` also takes `/v1/automation`.
 */
function walkRoots(): { trees: { base: string; router: unknown }[]; unlisted: string[]; unread: string[] } {
  const trees: { base: string; router: unknown }[] = [];
  const unlisted: string[] = [];
  const unread: string[] = [];
  for (const root of ROOTS) {
    const listed = Object.entries(root.surfaces);
    for (const layer of (root.router as { stack: ExpressLayer[] }).stack) {
      const route = layer.route;
      if (route !== undefined) {
        for (const method of Object.keys(route.methods)) {
          const key = restRoute(method, route.path);
          if (root.surfaces[key] === undefined) unlisted.push(`${root.base} ${key}`);
        }
        continue;
      }
      const pattern = layer.regexp;
      const at = listed
        .map(([path]) => path)
        .filter((path) => path.startsWith('/') && pattern.test(path))
        .sort((a, b) => a.length - b.length)[0];
      const surface = at === undefined ? undefined : root.surfaces[at];
      if (at === undefined || surface === undefined) {
        unlisted.push(`${root.base}: ${layer.handle.stack === undefined ? `middleware ${layer.name}` : 'a router'} at ${pattern}`);
      } else if ('walk' in surface) {
        if (surface.walk === layer.handle) trees.push({ base: at, router: layer.handle });
        else unread.push(`${root.base}${at}: not the router listed to walk`);
      }
    }
  }
  return { trees, unlisted, unread };
}

const procedureNames = Object.keys(viewsRouter._def.procedures).map((name) => `views.${name}`);
const roots = walkRoots();
const restWalk = roots.trees.map((tree) => walkRest(tree.router, tree.base));
const restRoutes = restWalk.flatMap((walked) => walked.routes);

describe('the registry', () => {
  it('lists every surface mounted on the REST roots, walked or exempt with its reason', () => {
    expect(roots.unlisted).toEqual([]);
    expect(roots.trees.map((tree) => tree.base)).toEqual(['/v1/automation', '/v1/asks']);
  });

  it('lists every mount the server makes on the app itself', () => {
    const mounted = appMounts();
    expect(mounted).toEqual(expect.arrayContaining(["'/api'", "'/api/story'", "'/api/public/lf-secrets'"]));
    expect(mounted.filter((mount) => APP_MOUNTS[mount] === undefined)).toEqual([]);
    expect(Object.keys(APP_MOUNTS).filter((mount) => !mounted.includes(mount))).toEqual([]);
  });

  it('reads every layer of the REST trees', () => {
    expect([...roots.unread, ...restWalk.flatMap((walked) => walked.unread)]).toEqual([]);
  });

  it('has a decision or an exemption for every REST route under /v1/automation and /v1/asks', () => {
    expect(restRoutes.length).toBeGreaterThan(20);
    expect(restRoutes.some((r) => r.key.startsWith('POST /v1/asks/'))).toBe(true);
    expect(restRoutes.map((r) => r.key).filter((key) => !registeredDecisions().has(key))).toEqual([]);
  });

  it('has one for every endpoint an MCP automation tool calls', () => {
    const endpoints = Object.values(automationConnectorOptions().tools ?? {}).flatMap((tool) =>
      tool.endpoint === undefined ? [] : [restRoute(tool.endpoint.method, tool.endpoint.path)],
    );
    expect(endpoints.length).toBeGreaterThan(20);
    expect(endpoints.filter((key) => !registeredDecisions().has(key))).toEqual([]);
  });

  it('has one for every tRPC procedure', () => {
    expect(procedureNames.length).toBeGreaterThan(200);
    expect(procedureNames.filter((name) => !registeredDecisions().has(name))).toEqual([]);
  });

  it('names no route that is not mounted', () => {
    const mounted = new Set([...restRoutes.map((r) => r.key), ...procedureNames]);
    expect([...registeredDecisions().keys()].filter((route) => !mounted.has(route))).toEqual([]);
  });

  it('gives every exemption its reason', () => {
    const blank = [...registeredDecisions()].filter(([, d]) => 'exempt' in d && d.exempt.trim().length < 8);
    expect(blank).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

type RestCall = { params?: Record<string, string>; query?: Record<string, string>; body?: Record<string, unknown> };

/** How to ask each REST route about the refs. `list` routes take none and must leave the automation out. */
const REST_CALLS: Record<string, { call: (refs: Refs) => RestCall; list?: true }> = {
  'GET /v1/automation/reviews': { call: () => ({}), list: true },
  'POST /v1/automation/reviews/:/answer': { call: (r) => ({ params: { id: r.askId }, body: { answer: true } }) },
  'GET /v1/automation/get-started': { call: (r) => ({ query: { automation: r.automationName } }) },
  'POST /v1/automation/handbook': { call: (r) => ({ body: { automation: r.automationName } }) },
  'POST /v1/automation/language/search': { call: (r) => ({ body: { query: 'listen', automation: r.automationName } }) },
  'POST /v1/automation/language/example': { call: (r) => ({ body: { automation: r.automationName } }) },
  'GET /v1/automation/automations': { call: () => ({}), list: true },
  'GET /v1/automation/automations/grep': { call: () => ({ query: { pattern: 'listen' } }), list: true },
  'GET /v1/automation/automations/:/runs': { call: (r) => ({ params: { idOrName: r.automationName } }) },
  'GET /v1/automation/automations/:/source': { call: (r) => ({ params: { idOrName: r.automationName } }) },
  'GET /v1/automation/automations/:': { call: (r) => ({ params: { idOrName: r.automationName } }) },
  'GET /v1/automation/automations/:/arrivals': { call: (r) => ({ params: { idOrName: r.automationId } }) },
  'POST /v1/automation/automations/validate': { call: (r) => ({ body: { source: 'x', automation: r.automationId } }) },
  'POST /v1/automation/automations/completions': { call: (r) => ({ body: { source: 'x', automation: r.automationId } }) },
  'POST /v1/automation/automations/delete': { call: (r) => ({ body: { automation: r.automationId } }) },
  'POST /v1/automation/automations/:/edit': {
    call: (r) => ({ params: { idOrName: r.automationName }, body: { oldString: 'fire deals', newString: 'fire deals_too' } }),
  },
  'POST /v1/automation/automations/upgrade': { call: (r) => ({ body: { automation: r.automationName } }) },
  'POST /v1/automation/automations/run': { call: (r) => ({ body: { automation: r.automationName } }) },
  'POST /v1/automation/automations/run-status': { call: (r) => ({ body: { runId: r.runId } }) },
  'POST /v1/automation/automations/inspect-run': { call: (r) => ({ body: { runId: r.runId } }) },
  'POST /v1/automation/automations/cancel-run': { call: (r) => ({ body: { runId: r.runId } }) },
  'POST /v1/automation/automations/resume-run': { call: (r) => ({ body: { runId: r.runId } }) },
  'POST /v1/automation/automations/replay-delivery': { call: (r) => ({ body: { listen: r.listenId, deliveryId: r.deliveryId } }) },
  'POST /v1/automation/automations/resume-listen': { call: (r) => ({ body: { listen: r.listenId } }) },
  'POST /v1/automation/access': { call: (r) => ({ body: { automation: r.automationName, verb: 'read', grantees: [{ kind: 'team' }] } }) },
  'GET /v1/asks/': { call: () => ({}), list: true },
  'GET /v1/asks/:': { call: (r) => ({ params: { id: r.askId } }) },
  'POST /v1/asks/:/cancel': { call: (r) => ({ params: { id: r.askId } }) },
};

/** How to ask each tRPC procedure about the refs. */
const TRPC_CALLS: Record<string, { input: (refs: Refs) => unknown; list?: true }> = {
  'views.movement.check': { input: (r) => ({ source: 'x', id: r.automationId }) },
  'views.movement.complete': { input: (r) => ({ source: 'x', offset: 0, id: r.automationId }) },
  'views.movement.hover': { input: (r) => ({ source: 'x', offset: 0, id: r.automationId }) },
  'views.movement.definition': { input: (r) => ({ source: 'x', offset: 0, id: r.automationId }) },
  'views.movement.outline': { input: (r) => ({ source: 'x', id: r.automationId }) },
  'views.movement.get': { input: (r) => ({ id: r.automationId }) },
  'views.movement.story': { input: (r) => ({ id: r.automationId }) },
  'views.movement.list': { input: () => undefined, list: true },
  'views.movement.delete': { input: (r) => ({ id: r.automationId }) },
  'views.movement.runs': { input: (r) => ({ movementId: r.automationId }) },
  'views.movement.events': { input: (r) => ({ movementId: r.automationId }) },
  'views.movement.runNow': { input: (r) => ({ id: r.automationId }) },
  'views.movement.runStatus': { input: (r) => ({ runId: r.runId }) },
  'views.triggers.list': { input: () => undefined, list: true },
  'views.triggers.get': { input: (r) => ({ id: r.listenId }) },
  'views.triggers.getAutomationDetail': { input: (r) => ({ id: r.listenId }) },
  'views.triggers.onRunActivity': { input: () => undefined, list: true },
  'views.triggers.onRecentActivity': { input: (r) => ({ triggerId: r.listenId }) },
  'views.triggers.renameTrigger': { input: (r) => ({ triggerId: r.listenId, name: 'Renamed' }) },
  'views.triggers.deleteTrigger': { input: (r) => ({ triggerId: r.listenId }) },
  'views.triggers.dryRunTrigger': { input: (r) => ({ triggerId: r.listenId }) },
  'views.triggers.resumeGuardPaused': { input: (r) => ({ triggerId: r.listenId }) },
  'views.triggers.setTriggerCredential': { input: (r) => ({ triggerId: r.listenId, credentialsId: null }) },
  'views.triggers.submitWebEvent': { input: (r) => ({ triggerId: r.listenId, text: 'hello' }) },
  'views.triggers.replayDelivery': { input: (r) => ({ triggerId: r.listenId, deliveryId: r.deliveryId }) },
  'views.triggers.showDeliveryRequest': { input: (r) => ({ deliveryId: r.deliveryId }) },
  'views.controlTower.listParkedRuns': { input: () => undefined, list: true },
  'views.controlTower.listAskRecords': { input: () => undefined, list: true },
  'views.controlTower.answerAskRecord': { input: (r) => ({ askId: r.askId, answer: true }) },
  'views.controlTower.abortRun': { input: (r) => ({ runId: r.runId }) },
  'views.controlTower.resumeRun': { input: (r) => ({ runId: r.runId }) },
  'views.controlTower.listRuns': { input: () => undefined, list: true },
  'views.home.getDashboard': { input: () => undefined, list: true },
  'views.credentials.getTgRun': { input: (r) => ({ runId: r.runId }) },
  'views.access.get': { input: (r) => ({ thing: 'automation', id: r.automationId }) },
  'views.access.set': { input: (r) => ({ thing: 'automation', id: r.automationId, verb: 'read', grantees: [{ kind: 'team' }] }) },
};

/** What a granted call changes: an effect by name, or a table written. */
type Effect = keyof typeof mockEffects | `write:${string}`;

/**
 * How to ask a connection route about the refs. `list` routes take none and
 * must leave the connection out. `effect` is what the route changes, which a
 * caller who may use the connection reaches and one who may not never does.
 * `refusal` is for the one route whose refusal is its own answer rather than
 * the missing one's, by ruling: a connect link under a name a hidden
 * connection holds says the name is taken, which reveals only that it exists.
 */
type ConnectionCall<Ask> = { ask: (refs: ConnectionRefs) => Ask; list?: true; effect?: Effect; refusal?: RegExp };

const programOn = (refs: ConnectionRefs) => `import { ${refs.connectionName} } from credentials\n`;
const attioRef = { kind: 'adapter', adapterType: 'attio' };

const REST_CONNECTION_CALLS: Record<string, ConnectionCall<RestCall>> = {
  'GET /v1/automation/connections': { ask: () => ({}), list: true },
  'POST /v1/automation/connections/describe': {
    ask: (c) => ({ body: { system: 'attio', connection: c.connectionName, detail: 'full' } }),
  },
  'POST /v1/automation/connections/connect': {
    ask: (c) => ({ body: { system: 'affinity', connection: c.connectionName, use: [{ kind: 'team' }] } }),
    effect: 'write:connect_token',
    refusal: /taken by a connection you may not use/,
  },
  'POST /v1/automation/connections/grant-access': {
    ask: (c) => ({ body: { system: 'google_sheets', connection: c.connectionName } }),
    effect: 'write:connect_token',
  },
  'POST /v1/automation/access': {
    ask: (c) => ({ body: { connection: c.connectionName, verb: 'use', grantees: [{ kind: 'team' }] } }),
    effect: 'write:access_statement',
  },
};

const TRPC_CONNECTION_CALLS: Record<string, ConnectionCall<unknown>> = {
  'views.connections.getAll': { ask: () => undefined, list: true },
  'views.connections.credentialDependents': { ask: (c) => ({ id: c.connectionId }) },
  // One shared Telegram connection per team: a hidden one is refused, and no second is made.
  'views.connections.connectTelegramTeam': { ask: () => undefined, refusal: /Telegram connection is one you may not use/ },
  'views.credentials.getCredentials': { ask: () => undefined, list: true },
  'views.credentials.updateCredential': {
    ask: (c) => ({ id: c.connectionId, name: c.connectionName, type: 'ATTIO', credentials: { accessToken: 'rotated' } }),
    effect: 'write:external_service_credentials',
  },
  'views.credentials.deleteCredential': { ask: (c) => ({ id: c.connectionId }), effect: 'deleteCredential' },
  'views.credentials.attioListObjects': { ask: (c) => ({ credentialsId: c.connectionId }) },
  'views.credentials.listEntryPoints': { ask: (c) => ({ ref: attioRef, credentialsId: c.connectionId }) },
  'views.credentials.describeTypes': { ask: (c) => ({ ref: attioRef, credentialsId: c.connectionId, typeIds: ['deals'] }) },
  'views.googleSheets.pickerToken': { ask: (c) => ({ credentialsId: c.connectionId }) },
  'views.googleSheets.grant': { ask: (c) => ({ credentialsId: c.connectionId, spreadsheetId: 'sheet' }), effect: 'grantSpreadsheet' },
  'views.googleSheets.listGrants': { ask: (c) => ({ credentialsId: c.connectionId }) },
  'views.googleSheets.revoke': { ask: (c) => ({ credentialsId: c.connectionId, spreadsheetId: 'sheet' }), effect: 'revokeSpreadsheet' },
  'views.graphExplorer.listInstances': { ask: () => undefined, list: true },
  'views.graphExplorer.walk': { ask: (c) => ({ adapterType: 'attio', credentialsId: c.connectionId }) },
  'views.movement.catalog': { ask: () => undefined, list: true },
  'views.movement.catalogForSource': { ask: (c) => ({ source: programOn(c) }) },
  'views.movement.describeInstance': { ask: (c) => ({ adapter: 'attio', credentialName: c.connectionName }) },
  'views.remoteAdapter.list': { ask: () => undefined, list: true },
  'views.remoteAdapter.credentials': { ask: () => ({ adapterType: 'acme_crm' }), list: true },
  'views.remoteAdapter.upsertFromManifest': {
    ask: (c) => ({
      adapterType: 'acme_crm',
      baseUrl: 'https://adapter.example.com',
      authStrategy: { kind: 'bearer' },
      supportedTriggers: [],
      runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
      methods: [],
      credentialsId: c.connectionId,
    }),
    effect: 'write:remote_adapter',
  },
  'views.webhookSubscriptions.list': { ask: () => undefined, list: true },
  'views.webhookSubscriptions.create': { ask: (c) => ({ credentialsId: c.connectionId, provider: 'attio' }), effect: 'registerSubscription' },
  'views.webhookSubscriptions.delete': { ask: (c) => ({ id: c.subscriptionId }), effect: 'write:webhook_subscription' },
  'views.access.get': { ask: (c) => ({ thing: 'connection', id: c.connectionId }) },
  'views.access.set': {
    ask: (c) => ({ thing: 'connection', id: c.connectionId, verb: 'use', grantees: [{ kind: 'team' }] }),
    effect: 'write:access_statement',
  },
};

/** A route's answer, as something two calls can be compared by. */
type Outcome = { status: number | 'thrown'; body: unknown };

async function callRest(handler: RequestHandler, request: RestCall): Promise<Outcome> {
  const outcome: Outcome = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      outcome.status = code;
      return res;
    },
    type() {
      return res;
    },
    json(body: unknown) {
      outcome.body = body;
      return res;
    },
    send(body: unknown) {
      outcome.body = body;
      return res;
    },
  };
  const req = { params: request.params ?? {}, query: request.query ?? {}, body: request.body ?? {}, headers: {} };
  await runWithPrincipal(mockPrincipal, () => Promise.resolve(handler(req as never, res as never, () => undefined)));
  return outcome;
}

async function callTrpc(path: string, input: unknown): Promise<Outcome> {
  const caller = viewsRouter.createCaller({ authorise: async () => {} });
  const procedure = path
    .split('.')
    .slice(1)
    .reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], caller);
  if (typeof procedure !== 'function') throw new Error(`${path} is not callable`);
  return runWithPrincipal(mockPrincipal, async () => {
    try {
      const answer: unknown = await procedure(input);
      return { status: 200, body: await settled(answer) };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return { status: 'thrown', body: { code: 'code' in error ? error.code : undefined, message: error.message } };
    }
  });
}

/** A subscription answers with an observable: what it emits before it is let go. */
async function settled(answer: unknown): Promise<unknown> {
  if (answer === null || typeof answer !== 'object' || !('subscribe' in answer)) return answer;
  const subscribable = answer as { subscribe: (o: { next: (v: unknown) => void }) => { unsubscribe: () => void } };
  const emitted: unknown[] = [];
  const subscription = subscribable.subscribe({ next: (value) => emitted.push(value) });
  mockState.activity.emit('message', {
    teamId: TEAM,
    runId: SEEDED.runId,
    triggerId: SEEDED.listenId,
    phase: 'started',
    id: SEEDED.runId,
    status: 'running',
    startedAt: new Date(0).toISOString(),
    completedAt: null,
    failedAt: null,
    failureReason: null,
    nodesWritten: 0,
    dryRun: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  subscription.unsubscribe();
  return { emitted };
}

/** The answer about the missing names, written as if it were about the seeded ones. */
function asIf<R extends Record<string, string>>(outcome: Outcome, names: { from: R; to: R }): Outcome {
  let text = JSON.stringify(outcome);
  for (const key of Object.keys(names.from)) text = text.split(names.from[key] ?? '').join(names.to[key] ?? '');
  return JSON.parse(text);
}

const asIfSeeded = (outcome: Outcome): Outcome => asIf(outcome, { from: MISSING, to: SEEDED });

function mentionsSeeded(outcome: Outcome): boolean {
  const text = JSON.stringify(outcome.body ?? null);
  return [SEEDED.automationId, SEEDED.automationName, SEEDED.runId, SEEDED.listenId, SEEDED.askId].some((ref) => text.includes(ref));
}

function mentionsConnection(outcome: Outcome): boolean {
  const text = JSON.stringify(outcome.body ?? null);
  return [CONNECTION.connectionId, CONNECTION.connectionName].some((ref) => text.includes(ref));
}

/** The effects a call reached, by name, and the tables it wrote. */
function effectsReached(): Effect[] {
  const called = Object.entries(mockEffects).flatMap(([name, effect]) => (effect.mock.calls.length > 0 ? [name] : []));
  const written = mockState.writes.map((table) => `write:${table}`);
  return [...new Set([...called, ...written])].filter((name): name is Effect => name in mockEffects || name.startsWith('write:'));
}

/** The decisions a route asks, one per thing it may act on. */
function decidedOn(route: string): ReturnType<typeof decisionsOf> {
  const decision = registeredDecisions().get(route);
  return decision === undefined ? [] : decisionsOf(decision);
}

const decidesOn = (route: string, thing: 'automation' | 'connection') => decidedOn(route).some((d) => d.thing === thing);

const restDecided = restRoutes.filter((route) => decidesOn(route.key, 'automation'));
const trpcDecided = procedureNames.filter((name) => decidesOn(name, 'automation'));
const restUses = restRoutes.filter((route) => decidesOn(route.key, 'connection'));
const trpcUses = procedureNames.filter((name) => decidesOn(name, 'connection'));

/** The verb a route asks of an automation. */
function verbOf(route: string): 'read' | 'write' | undefined {
  const decision = decidedOn(route).find((d) => d.thing === 'automation');
  return decision?.thing === 'automation' ? decision.verb : undefined;
}

describe('as a write member, on an automation whose statements name only someone else', () => {
  it('knows how to call every route that decides', () => {
    const restCovered = new Set([...restDecided, ...restUses].map((r) => r.key));
    const trpcCovered = new Set([...trpcDecided, ...trpcUses]);
    expect(restRoutes.filter((route) => decidedOn(route.key).length > 0 && !restCovered.has(route.key))).toEqual([]);
    expect(procedureNames.filter((name) => decidedOn(name).length > 0 && !trpcCovered.has(name))).toEqual([]);
    expect(restDecided.map((r) => r.key).filter((key) => REST_CALLS[key] === undefined)).toEqual([]);
    expect(trpcDecided.filter((name) => TRPC_CALLS[name] === undefined)).toEqual([]);
    expect(restUses.map((r) => r.key).filter((key) => REST_CONNECTION_CALLS[key] === undefined)).toEqual([]);
    expect(trpcUses.filter((name) => TRPC_CONNECTION_CALLS[name] === undefined)).toEqual([]);
  });

  it.each(restDecided.map((r) => [r.key, r.handler] as const))('%s refuses it as it refuses a missing name, or leaves it out', async (key, handler) => {
    const how = REST_CALLS[key];
    if (how === undefined) throw new Error(`no call for ${key}`);
    const seen = await callRest(handler, how.call(SEEDED));
    expect(mockState.asked).toBeGreaterThan(0);
    expect(mentionsConnection(seen)).toBe(false);
    if (how.list) {
      expect(seen.status).toBe(200);
      expect(mentionsSeeded(seen)).toBe(false);
      return;
    }
    mockState.automations = [];
    mockState.things = new Map();
    const missing = await callRest(handler, how.call(MISSING));
    expect(seen.status).not.toBe(500);
    expect(seen).toEqual(asIfSeeded(missing));
    expect(effectsReached()).toEqual([]);
  });

  it.each(trpcDecided)('%s refuses it as it refuses a missing name, or leaves it out', async (name) => {
    const how = TRPC_CALLS[name];
    if (how === undefined) throw new Error(`no call for ${name}`);
    const seen = await callTrpc(name, how.input(SEEDED));
    expect(mockState.asked).toBeGreaterThan(0);
    expect(mentionsConnection(seen)).toBe(false);
    if (how.list) {
      expect(seen.status).toBe(200);
      expect(mentionsSeeded(seen)).toBe(false);
      return;
    }
    mockState.automations = [];
    mockState.things = new Map();
    const missing = await callTrpc(name, how.input(MISSING));
    expect(seen).toEqual(asIfSeeded(missing));
    if (seen.status === 'thrown') expect(JSON.stringify(seen.body)).toMatch(/not(\s+be)?[\s_]found/i);
    expect(effectsReached()).toEqual([]);
  });
});

describe('as a write member who may only read the automation', () => {
  beforeEach(() => {
    mockState.rows.push({ teamId: TEAM, target: { thing: 'automation', id: SEEDED.automationId }, verb: 'read', grantee: { kind: 'user', userId: ALICE } });
  });

  /** What the route answers for a name that does not exist, written as if it were about the seeded one. */
  async function missingAnswer(call: () => Promise<Outcome>): Promise<Outcome> {
    mockState.automations = [];
    mockState.things = new Map();
    return asIfSeeded(await call());
  }

  it.each(restDecided.map((r) => [r.key, r.handler] as const))('%s reads it, or gives the read-only refusal', async (key, handler) => {
    const how = REST_CALLS[key];
    if (how === undefined) throw new Error(`no call for ${key}`);
    const seen = await callRest(handler, how.call(SEEDED));
    expect(seen.status).not.toBe(500);
    // Reading the automation is not using the connections it is bound to.
    expect(mentionsConnection(seen)).toBe(false);
    if (verbOf(key) === 'write') {
      expect(seen.status).toBe(403);
      expect(JSON.stringify(seen.body)).toContain(READ_ONLY_MESSAGE);
      expect(effectsReached()).toEqual([]);
    } else if (how.list) {
      expect(mentionsSeeded(seen)).toBe(true);
    } else {
      expect(seen).not.toEqual(await missingAnswer(() => callRest(handler, how.call(MISSING))));
    }
  });

  it.each(trpcDecided)('%s reads it, or gives the read-only refusal', async (name) => {
    const how = TRPC_CALLS[name];
    if (how === undefined) throw new Error(`no call for ${name}`);
    const seen = await callTrpc(name, how.input(SEEDED));
    expect(mentionsConnection(seen)).toBe(false);
    if (verbOf(name) === 'write') {
      expect(seen).toEqual({ status: 'thrown', body: { code: 'FORBIDDEN', message: READ_ONLY_MESSAGE } });
      expect(effectsReached()).toEqual([]);
    } else if (how.list) {
      expect(mentionsSeeded(seen)).toBe(true);
    } else {
      expect(seen).not.toEqual(await missingAnswer(() => callTrpc(name, how.input(MISSING))));
    }
  });
});

describe('an automation bound to a connection the caller may not use', () => {
  beforeEach(() => {
    for (const verb of ['read', 'write'] as const) {
      mockState.rows.push({ teamId: TEAM, target: { thing: 'automation', id: SEEDED.automationId }, verb, grantee: { kind: 'user', userId: ALICE } });
    }
  });

  const detail = () => callTrpc('views.triggers.getAutomationDetail', { id: SEEDED.listenId });
  const connectionOf = (outcome: Outcome) => (outcome.body as { connection: Record<string, unknown> }).connection;

  it('shows its detail as bound, naming neither the connection nor its id, and offers no choice of it', async () => {
    const seen = await detail();
    expect(seen.status).toBe(200);
    expect(connectionOf(seen)).toMatchObject({ bound: true, credentialsId: null, credentialName: null, options: [] });
    expect(mentionsConnection(seen)).toBe(false);
    expect(mentionsConnection(await callTrpc('views.triggers.get', { id: SEEDED.listenId }))).toBe(false);
  });

  it('shows the connection to someone who may use it', async () => {
    mockState.rows.push({ teamId: TEAM, target: FINANCE, verb: 'use', grantee: { kind: 'user', userId: ALICE } });
    const seen = await detail();
    expect(connectionOf(seen)).toMatchObject({
      bound: true,
      credentialsId: CONNECTION.connectionId,
      credentialName: CONNECTION.connectionName,
      options: [{ id: CONNECTION.connectionId, name: CONNECTION.connectionName }],
    });
  });

  it('refuses to bind it, as it refuses a connection that is not there', async () => {
    const attach = (refs: ConnectionRefs) => callTrpc('views.triggers.setTriggerCredential', { triggerId: SEEDED.listenId, credentialsId: refs.connectionId });
    const refused = await attach(CONNECTION);
    expect(refused).toEqual({ status: 'thrown', body: { code: 'INTERNAL_SERVER_ERROR', message: 'That connection was not found.' } });
    expect(refused).toEqual(asIf(await attach(NO_CONNECTION), { from: NO_CONNECTION, to: CONNECTION }));
    expect(mockState.writes).toEqual([]);
  });

  it('binds it for someone who may use it', async () => {
    mockState.rows.push({ teamId: TEAM, target: FINANCE, verb: 'use', grantee: { kind: 'user', userId: ALICE } });
    await callTrpc('views.triggers.setTriggerCredential', { triggerId: SEEDED.listenId, credentialsId: CONNECTION.connectionId });
    expect(mockState.writes).toContain('trigger');
  });

  /** The connection a new automation of Attio's kind was given. */
  async function attachedToNew(): Promise<unknown> {
    await callTrpc('views.triggers.createAutomation', { name: 'New', sourceKind: 'attio' });
    const inserted = mockState.stored.find((entry) => entry.table === 'trigger');
    return (inserted?.values as { credentials_id?: unknown } | undefined)?.credentials_id;
  }

  it('is not attached to a new automation by the caller who may not use it', async () => {
    expect(await attachedToNew()).toBeNull();
  });

  it('is attached to a new automation by one who may use it', async () => {
    mockState.rows.push({ teamId: TEAM, target: FINANCE, verb: 'use', grantee: { kind: 'user', userId: ALICE } });
    expect(await attachedToNew()).toBe(CONNECTION.connectionId);
  });
});

describe('as a write member, on a connection whose statements name only someone else', () => {
  /** The route's answer about the seeded connection, then what it must equal: its answer about a missing one. */
  async function refused(call: (refs: ConnectionRefs) => Promise<Outcome>, how: ConnectionCall<unknown>): Promise<void> {
    const seen = await call(CONNECTION);
    expect(mockState.asked).toBeGreaterThan(0);
    expect(seen.status).not.toBe(500);
    expect(effectsReached()).toEqual([]);
    if (how.list) {
      expect(seen.status).toBe(200);
      expect(mentionsConnection(seen)).toBe(false);
    } else if (how.refusal !== undefined) {
      expect(JSON.stringify(seen.body)).toMatch(how.refusal);
    } else {
      withoutConnection();
      const missing = await call(NO_CONNECTION);
      expect(seen).toEqual(asIf(missing, { from: NO_CONNECTION, to: CONNECTION }));
      if (seen.status === 'thrown') expect(JSON.stringify(seen.body)).toMatch(/not[\s_]found/i);
    }
  }

  it.each(restUses.map((r) => [r.key, r.handler] as const))('%s refuses it as it refuses a missing one, or leaves it out', async (key, handler) => {
    const how = REST_CONNECTION_CALLS[key];
    if (how === undefined) throw new Error(`no call for ${key}`);
    await refused((refs) => callRest(handler, how.ask(refs)), how);
  });

  it.each(trpcUses)('%s refuses it as it refuses a missing one, or leaves it out', async (name) => {
    const how = TRPC_CONNECTION_CALLS[name];
    if (how === undefined) throw new Error(`no call for ${name}`);
    await refused((refs) => callTrpc(name, how.ask(refs)), how);
  });
});

describe('as a write member who may use the connection', () => {
  beforeEach(() => {
    mockState.rows.push({ teamId: TEAM, target: FINANCE, verb: 'use', grantee: { kind: 'user', userId: ALICE } });
  });

  /** The route works on the connection: it lists it, answers otherwise than for a missing one, and reaches what it changes. */
  async function granted(call: (refs: ConnectionRefs) => Promise<Outcome>, how: ConnectionCall<unknown>): Promise<void> {
    const seen = await call(CONNECTION);
    expect(seen.status).toBe(200);
    const reached = effectsReached();
    if (how.effect !== undefined) expect(reached).toContain(how.effect);
    if (how.list) {
      expect(mentionsConnection(seen)).toBe(true);
      return;
    }
    withoutConnection();
    expect(seen).not.toEqual(asIf(await call(NO_CONNECTION), { from: NO_CONNECTION, to: CONNECTION }));
  }

  it.each(restUses.map((r) => [r.key, r.handler] as const))('%s works on it', async (key, handler) => {
    const how = REST_CONNECTION_CALLS[key];
    if (how === undefined) throw new Error(`no call for ${key}`);
    await granted((refs) => callRest(handler, how.ask(refs)), how);
  });

  it.each(trpcUses)('%s works on it', async (name) => {
    const how = TRPC_CONNECTION_CALLS[name];
    if (how === undefined) throw new Error(`no call for ${name}`);
    await granted((refs) => callTrpc(name, how.ask(refs)), how);
  });
});

describe('a name lookup across the caller’s teams', () => {
  it('skips the first team’s automation the caller cannot read, and finds the second’s', async () => {
    mockState.teams = [TEAM, OTHER_TEAM];
    mockState.automations.push({ id: SECOND_DEALS, teamId: OTHER_TEAM, name: SEEDED.automationName });
    statesOnly(SECOND_DEALS, OTHER_TEAM, { kind: 'team' });
    const get = restRoutes.find((route) => route.key === 'GET /v1/automation/automations/:');
    if (get === undefined) throw new Error('getAutomation is not mounted');
    const answer = await callRest(get.handler, { params: { idOrName: SEEDED.automationName } });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ id: SECOND_DEALS });
  });
});

describe('who imports a file, told only as far as the caller may read', () => {
  const IMPORTER = 'd0000000-0000-4000-8000-0000000000aa';

  beforeEach(() => {
    statesOnly(SEEDED.automationId, TEAM, { kind: 'user', userId: ALICE });
    mockState.automations.push({ id: IMPORTER, teamId: TEAM, name: 'Importer', source: `import { shout } from "${SEEDED.automationName}"\n` });
    statesOnly(IMPORTER, TEAM, { kind: 'user', userId: BOB });
  });

  const mayReadImporter = () =>
    mockState.rows.push({ teamId: TEAM, target: { thing: 'automation', id: IMPORTER }, verb: 'read', grantee: { kind: 'user', userId: ALICE } });

  it('counts on the list only the importers the caller may read', async () => {
    const usedBy = async () => {
      const listed = (await callTrpc('views.movement.list', undefined)).body as { id: string; usedBy: number }[];
      return listed.find((item) => item.id === SEEDED.automationId)?.usedBy;
    };
    expect(await usedBy()).toBe(0);
    mayReadImporter();
    expect(await usedBy()).toBe(1);
  });

  it('re-checks after a save, and names, only the importers the saver may read', async () => {
    const shipped = { ok: true, movementId: SEEDED.automationId, movementName: SEEDED.automationName, listeners: [], infos: [], catalogNotes: [], warnings: [] };
    const saved = async () => {
      mockEffects.saveMovement.mockResolvedValueOnce(shipped as never);
      return (await callTrpc('views.movement.save', { source: 'x', id: SEEDED.automationId })).body as { dependentChecks: { id: string }[] };
    };
    expect((await saved()).dependentChecks).toEqual([]);
    mayReadImporter();
    expect((await saved()).dependentChecks).toEqual([expect.objectContaining({ id: IMPORTER, name: 'Importer' })]);
  });
});
