// Every route that reaches an automation or a connection asks the access
// decision, or is registered as exempt with its reason. The walk covers the
// REST tree under /v1/automation, every MCP automation tool's endpoint, and
// every tRPC procedure, so a route added without a decision fails here.
//
// Then each route that decides is called as a write member of the team, on an
// automation whose statements name only someone else. It must refuse exactly
// as it refuses a name that does not exist, or leave the automation out of its
// list, and it must have asked the decision to get there.

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
type Refs = { automationId: string; automationName: string; runId: string; listenId: string; askId: string };

const mockSeeded: Refs = {
  automationId: 'd0000000-0000-4000-8000-000000000001',
  automationName: 'Deals',
  runId: 'e0000000-0000-4000-8000-000000000001',
  listenId: 'f0000000-0000-4000-8000-000000000001',
  askId: 'a0000000-0000-4000-8000-000000000001',
};

const SEEDED = mockSeeded;

const MISSING: Refs = {
  automationId: 'd0000000-0000-4000-8000-00000000dead',
  automationName: 'Nowhere',
  runId: 'e0000000-0000-4000-8000-00000000dead',
  listenId: 'f0000000-0000-4000-8000-00000000dead',
  askId: 'a0000000-0000-4000-8000-00000000dead',
};

/** The same name in a second team, which the caller may read: a lookup must find it. */
const SECOND_DEALS = 'd0000000-0000-4000-8000-000000000002';
const FINANCE: Target<'connection'> = { thing: 'connection', id: 'c0000000-0000-4000-8000-000000000001' };

type Row = { teamId: string; target: Target; verb: Verb; grantee: Grantee };

const mockState: {
  things: Map<string, string>;
  members: Map<string, Access>;
  rows: Row[];
  asked: number;
  teams: string[];
  automations: { id: string; teamId: string; name: string }[];
  activity: EventEmitter;
} = {
  things: new Map(),
  members: new Map(),
  rows: [],
  asked: 0,
  teams: [TEAM],
  automations: [],
  activity: new EventEmitter(),
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
      hasAnyStatement: async (target: Target) => mockState.rows.some((r) => same(r.target, target)),
      membershipsOf: async (userId: string, teamIds: string[]) =>
        new Map(
          teamIds.flatMap((teamId) => {
            const access = mockState.members.get(`${teamId}:${userId}`);
            return access === undefined ? [] : [[teamId, access] as const];
          }),
        ),
    },
  };
});

jest.mock('../../services/access/whose', () => {
  type Owner = { teamId: string; automationId: string | null };
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
  const tables: Record<string, unknown[]> = {
    trigger: [
      {
        id: mockSeeded.listenId,
        team_id: mockTeam,
        movement_id: mockSeeded.automationId,
        name: 'Deals',
        kind: 'manual',
        config: {},
        credentials_id: null,
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
  };
  const stub = (): unknown => {
    let rows: unknown[] = [];
    const chain: object = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') return undefined;
          if (prop === 'selectFrom' || prop === 'updateTable' || prop === 'deleteFrom' || prop === 'insertInto') {
            return (table: string) => {
              rows = tables[table] ?? [];
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
  const row = (a: { id: string; teamId: string; name: string }) => ({
    id: a.id,
    teamId: a.teamId,
    name: a.name,
    source: 'listen to manual-[:Invocations]-> fire deals\n',
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
    deleteMovement: async () => true,
  };
});

jest.mock('../../services/translation_graph/movement/story_token', () => ({
  ...jest.requireActual('../../services/translation_graph/movement/story_token'),
  storyTokenForMovement: async () => 'token',
  storyTokensForMovements: async (rows: { movementId: string }[]) => new Map(rows.map((r) => [r.movementId, 'token'])),
}));

jest.mock('../../services/translation_graph/movement/run_now', () => ({
  ...jest.requireActual('../../services/translation_graph/movement/run_now'),
  runMovementAsync: async () => ({ ok: true, runId: mockSeeded.runId, status: 'running', movementName: 'Deals' }),
  getMovementRunStatus: async () => ({ runId: mockSeeded.runId, status: 'success' }),
  listMovementRuns: async () => [{ runId: mockSeeded.runId }],
  inspectMovementRun: async () => ({ runId: mockSeeded.runId }),
}));

jest.mock('../../services/interaction/operator', () => ({
  ...jest.requireActual('../../services/interaction/operator'),
  abortRun: async () => ({ runId: mockSeeded.runId }),
  resumeRun: async () => ({ runId: mockSeeded.runId, resumed: 1 }),
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
  replayThroughListen: async () => ({ outcome: 'replayed', runIds: [mockSeeded.runId] }),
}));

jest.mock('../../services/inbound/listen_pause', () => ({
  ...jest.requireActual('../../services/inbound/listen_pause'),
  resumeListen: async () => ({ resumed: true, held: 0 }),
}));

jest.mock('../../services/user', () => ({
  UserService: { getById: async (id: string) => ({ id, email: 'alice@example.com', username: 'alice' }) },
}));

jest.mock('../../lib/message_queue', () => {
  const actual = jest.requireActual('../../lib/message_queue');
  const exchange = { node: () => ({ attachTo: () => mockState.activity }), activityByTeamId: {}, recordedByTriggerId: {} };
  return { ...actual, mq: { ...actual.mq, triggerRunActivity: exchange, triggerRuns: exchange } };
});

import { automationConnectorOptions } from '../mcp/connectors/automation';
import { automationRouter } from '../rest/v1/automation';
import { viewsRouter } from '../trpc/views';
import { registeredDecisions, restRoute, type Decision } from '../access_route';

const AUTOMATION_BASE = '/v1/automation';

function statesOnly(automationId: string, teamId: string, grantee: Grantee): void {
  const target: Target = { thing: 'automation', id: automationId };
  mockState.things.set(`automation:${automationId}`, teamId);
  for (const verb of ['read', 'write', 'fire'] as const) mockState.rows.push({ teamId, target, verb, grantee });
}

beforeEach(() => {
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
  mockState.asked = 0;
});

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

type ExpressLayer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } };

function mountedRestRoutes(): { key: string; handler: RequestHandler }[] {
  const stack = (automationRouter as unknown as { stack: ExpressLayer[] }).stack;
  return stack.flatMap((layer) => {
    const route = layer.route;
    if (route === undefined) return [];
    const handler = route.stack[route.stack.length - 1]?.handle;
    if (handler === undefined) return [];
    return Object.keys(route.methods).map((method) => ({ key: restRoute(method, `${AUTOMATION_BASE}${route.path}`), handler }));
  });
}

const procedureNames = Object.keys(viewsRouter._def.procedures).map((name) => `views.${name}`);
const restRoutes = mountedRestRoutes();
const decided = (decision: Decision | undefined): boolean => decision !== undefined && !('exempt' in decision);

describe('the registry', () => {
  it('has a decision or an exemption for every REST route under /v1/automation', () => {
    expect(restRoutes.length).toBeGreaterThan(20);
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
  'POST /v1/automation/automations/run': { call: (r) => ({ body: { automation: r.automationName } }) },
  'POST /v1/automation/automations/run-status': { call: (r) => ({ body: { runId: r.runId } }) },
  'POST /v1/automation/automations/inspect-run': { call: (r) => ({ body: { runId: r.runId } }) },
  'POST /v1/automation/automations/cancel-run': { call: (r) => ({ body: { runId: r.runId } }) },
  'POST /v1/automation/automations/resume-run': { call: (r) => ({ body: { runId: r.runId } }) },
  'POST /v1/automation/automations/replay-delivery': { call: (r) => ({ body: { listen: r.listenId, deliveryId: 'delivery-1' } }) },
  'POST /v1/automation/automations/resume-listen': { call: (r) => ({ body: { listen: r.listenId } }) },
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
  'views.triggers.replayDelivery': { input: (r) => ({ triggerId: r.listenId, deliveryId: 'delivery-1' }) },
  'views.controlTower.listParkedRuns': { input: () => undefined, list: true },
  'views.controlTower.listAskRecords': { input: () => undefined, list: true },
  'views.controlTower.answerAskRecord': { input: (r) => ({ askId: r.askId, answer: true }) },
  'views.controlTower.abortRun': { input: (r) => ({ runId: r.runId }) },
  'views.controlTower.resumeRun': { input: (r) => ({ runId: r.runId }) },
  'views.controlTower.listRuns': { input: () => undefined, list: true },
  'views.home.getDashboard': { input: () => undefined, list: true },
  'views.credentials.getTgRun': { input: (r) => ({ runId: r.runId }) },
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
function asIfSeeded(outcome: Outcome): Outcome {
  let text = JSON.stringify(outcome);
  for (const key of Object.keys(MISSING) as (keyof Refs)[]) text = text.split(MISSING[key]).join(SEEDED[key]);
  return JSON.parse(text);
}

function mentionsSeeded(outcome: Outcome): boolean {
  const text = JSON.stringify(outcome.body ?? null);
  return [SEEDED.automationId, SEEDED.automationName, SEEDED.runId, SEEDED.listenId, SEEDED.askId].some((ref) => text.includes(ref));
}

const restDecided = restRoutes.filter((route) => decided(registeredDecisions().get(route.key)));
const trpcDecided = procedureNames.filter((name) => decided(registeredDecisions().get(name)));

describe('as a write member, on an automation whose statements name only someone else', () => {
  it('knows how to call every route that decides', () => {
    expect(restDecided.map((r) => r.key).filter((key) => REST_CALLS[key] === undefined)).toEqual([]);
    expect(trpcDecided.filter((name) => TRPC_CALLS[name] === undefined)).toEqual([]);
  });

  it.each(restDecided.map((r) => [r.key, r.handler] as const))('%s refuses it as it refuses a missing name, or leaves it out', async (key, handler) => {
    const how = REST_CALLS[key];
    if (how === undefined) throw new Error(`no call for ${key}`);
    const seen = await callRest(handler, how.call(SEEDED));
    expect(mockState.asked).toBeGreaterThan(0);
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
  });

  it.each(trpcDecided)('%s refuses it as it refuses a missing name, or leaves it out', async (name) => {
    const how = TRPC_CALLS[name];
    if (how === undefined) throw new Error(`no call for ${name}`);
    const seen = await callTrpc(name, how.input(SEEDED));
    expect(mockState.asked).toBeGreaterThan(0);
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
