// The remote adapter push doors' REST contract (emit / wake / models). Drives
// the real router and the real door service over an in-process HTTP server; the
// install store, secret decryption, the listen door and the work queue are
// mocked, so what's under test is authentication (the credential picks the
// install, and the install is the team), body validation, and what each door
// keeps.

import { createServer, type Server } from 'node:http';

import express, { type Router } from 'express';

import type { AddressInfo } from 'node:net';

const listRemoteAdaptersOfType = jest.fn();
const loadRemoteAdapterSecret = jest.fn();
const deliverArrivals = jest.fn(async (_input: unknown) => ({ deliveryId: 'kept-1' }));
const judgeCarriedPage = jest.fn(async (_input: unknown) => 0);
const notifyWork = jest.fn();

jest.mock('node:crypto', () => {
  const actual = jest.requireActual('node:crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});
jest.mock('../../../services/translation_graph/adapters/remote/store', () => ({
  listRemoteAdaptersOfType: (input: unknown) => listRemoteAdaptersOfType(input),
}));
jest.mock('../../../services/translation_graph/adapters/resolve', () => ({
  loadRemoteAdapterSecret: (...args: unknown[]) => loadRemoteAdapterSecret(...args),
}));
jest.mock('../../../services/inbound/listen_door', () => ({
  deliverArrivals: (input: unknown) => deliverArrivals(input),
}));
jest.mock('../../../services/inbound/carried_delivery', () => ({
  judgeCarriedPage: (input: unknown) => judgeCarriedPage(input),
}));
jest.mock('../../../services/work/drain', () => ({ notifyWork: () => notifyWork() }));
// The platform's model client: answers, and reports what the call spent as a
// model call reports it (`recordLlmUsage` → `reportRunCost`).
const anthropicChat = jest.fn();
const anthropicChatStructured = jest.fn();
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: (input: unknown) => anthropicChat(input),
  anthropicChatStructured: (input: unknown) => anthropicChatStructured(input),
}));

import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';
import { reportRunCost } from 'movement-engine/public/models';

import { currentLlmUsageContext } from '../../../lib/llm_usage';
import { adapterDoorsRouter } from '../adapterDoors';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api/public/adapter', adapterDoorsRouter as Router);
  server = createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

const A_TEAM = '00000000-0000-4000-8000-0000000000a1';
const B_TEAM = '00000000-0000-4000-8000-0000000000b1';
const TEAM_A = { team_id: A_TEAM, adapter_type: 'acme_crm', credentials_id: 'cred-a', auth_strategy: { kind: 'bearer' } };
const TEAM_B = {
  team_id: B_TEAM,
  adapter_type: 'acme_crm',
  credentials_id: 'cred-b',
  auth_strategy: { kind: 'shared_secret', header: 'x-crm-key' },
};
const SECRETS: Record<string, string> = { 'cred-a': 'secret-a', 'cred-b': 'secret-b' };

beforeEach(() => {
  jest.clearAllMocks();
  listRemoteAdaptersOfType.mockImplementation(
    async ({ adapterType, teamId }: { adapterType: string; teamId?: string }) =>
      (adapterType === 'acme_crm' ? [TEAM_A, TEAM_B] : []).filter((row) => teamId === undefined || row.team_id === teamId),
  );
  loadRemoteAdapterSecret.mockImplementation(async (credentialsId: string) => SECRETS[credentialsId]);
  deliverArrivals.mockResolvedValue({ deliveryId: 'kept-1' });
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/api/public/adapter${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const BEARER_A = { authorization: 'Bearer secret-a' };
const EVENT = { payload: { id: 'co-1', Name: 'Acme' }, eventType: 'company.created' };
const ARRIVAL = { edge: 'Replies', key: 'thread:1', identity: 'msg-1', landing: { recordId: 'msg-1', fields: { Text: 'hi' } } };
const WAKE = { arrivals: [ARRIVAL] };

describe('authentication — the credential picks the install, the install is the team', () => {
  it('a bearer credential authenticates as the install it belongs to', async () => {
    const res = await post('/acme_crm/wake', WAKE, BEARER_A);

    expect(res).toEqual({ status: 202, body: { accepted: 1 } });
    expect(deliverArrivals).toHaveBeenCalledWith(expect.objectContaining({ teamId: A_TEAM }));
    expect(timingSafeEqual).toHaveBeenCalled();
  });

  it("a shared-secret credential is read from the install's own header", async () => {
    const res = await post('/acme_crm/wake', WAKE, { 'x-crm-key': 'secret-b' });

    expect(res.status).toBe(202);
    expect(deliverArrivals).toHaveBeenCalledWith(expect.objectContaining({ teamId: B_TEAM }));
  });

  it("another install's secret in the wrong carrier does not authenticate", async () => {
    const res = await post('/acme_crm/wake', WAKE, { authorization: 'Bearer secret-b' });

    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(deliverArrivals).not.toHaveBeenCalled();
  });

  it('a wrong secret is 401 with no detail, and nothing is queued', async () => {
    const wake = await post('/acme_crm/wake', WAKE, { authorization: 'Bearer nope' });
    const emit = await post('/acme_crm/emit', { events: [EVENT] }, { authorization: 'Bearer nope' });

    expect(wake).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(emit).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(deliverArrivals).not.toHaveBeenCalled();
  });

  it('no credential at all is 401', async () => {
    expect((await post('/acme_crm/wake', WAKE)).status).toBe(401);
  });

  it("one team's credential at another adapter type it never installed is refused", async () => {
    listRemoteAdaptersOfType.mockImplementation(async ({ adapterType }: { adapterType: string }) =>
      adapterType === 'other_crm'
        ? [{ team_id: B_TEAM, adapter_type: 'other_crm', credentials_id: 'cred-b', auth_strategy: { kind: 'bearer' } }]
        : [TEAM_A],
    );

    const res = await post('/other_crm/wake', WAKE, BEARER_A);

    expect(res.status).toBe(401);
    expect(deliverArrivals).not.toHaveBeenCalled();
  });

  it('an adapter type no team installed is the same 401, so the door reveals nothing', async () => {
    const res = await post('/nobody_crm/emit', { events: [EVENT] }, BEARER_A);

    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } });
  });

  it('every install is checked, even after a match', async () => {
    await post('/acme_crm/wake', WAKE, BEARER_A);

    expect(loadRemoteAdapterSecret).toHaveBeenCalledTimes(2);
  });

  it.each(['slack', 'manual', 'ask', 'KG_MUTATION'])(
    'a slug a built-in or the engine answers to (%s) is 401 even with a valid secret, and no install is looked up',
    async (slug) => {
      listRemoteAdaptersOfType.mockResolvedValue([{ ...TEAM_A, adapter_type: slug }]);

      const wake = await post(`/${slug}/wake`, WAKE, BEARER_A);
      const emit = await post(`/${slug}/emit`, { events: [EVENT] }, BEARER_A);

      expect(wake).toEqual({ status: 401, body: { error: 'unauthorized' } });
      expect(emit).toEqual({ status: 401, body: { error: 'unauthorized' } });
      expect(listRemoteAdaptersOfType).not.toHaveBeenCalled();
      expect(deliverArrivals).not.toHaveBeenCalled();
    },
  );

  describe('a credential shared by several teams', () => {
    const TEAM_A_ID = '00000000-0000-4000-8000-00000000000a';
    const TEAM_C_ID = '00000000-0000-4000-8000-00000000000c';
    beforeEach(() => {
      const rows = [
        { ...TEAM_A, team_id: TEAM_A_ID },
        { ...TEAM_A, team_id: TEAM_C_ID, credentials_id: 'cred-c' },
      ];
      SECRETS['cred-c'] = 'secret-a';
      listRemoteAdaptersOfType.mockImplementation(async ({ teamId }: { teamId?: string }) =>
        rows.filter((row) => teamId === undefined || row.team_id === teamId),
      );
    });

    it('is 409 without a team named, and nothing is queued', async () => {
      const res = await post('/acme_crm/wake', WAKE, BEARER_A);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ambiguous_credential');
      expect(res.body.message).toMatch(/x-listen-fire-team/);
      expect(deliverArrivals).not.toHaveBeenCalled();
    });

    it("reaches only the team named in x-listen-fire-team, decrypting only that team's install", async () => {
      const res = await post('/acme_crm/wake', WAKE, { ...BEARER_A, 'x-listen-fire-team': TEAM_C_ID });

      expect(res.status).toBe(202);
      expect(listRemoteAdaptersOfType).toHaveBeenCalledWith({ adapterType: 'acme_crm', teamId: TEAM_C_ID });
      expect(loadRemoteAdapterSecret).toHaveBeenCalledTimes(1);
      expect(deliverArrivals).toHaveBeenCalledWith(expect.objectContaining({ teamId: TEAM_C_ID }));
    });

    it('a named team with no install of the type is 401', async () => {
      const res = await post(
        '/acme_crm/wake',
        WAKE,
        { ...BEARER_A, 'x-listen-fire-team': '00000000-0000-4000-8000-0000000000ff' },
      );

      expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } });
    });

    it('a team header that is not a team id is 401, and nothing is looked up', async () => {
      const res = await post('/acme_crm/wake', WAKE, { ...BEARER_A, 'x-listen-fire-team': 'nope' });

      expect(res.status).toBe(401);
      expect(listRemoteAdaptersOfType).not.toHaveBeenCalled();
    });
  });

  it('an install with no credential, or an unreadable secret, is skipped rather than fatal', async () => {
    listRemoteAdaptersOfType.mockResolvedValue([
      { ...TEAM_B, credentials_id: null },
      { ...TEAM_B, credentials_id: 'cred-broken' },
      TEAM_A,
    ]);
    loadRemoteAdapterSecret.mockImplementation(async (credentialsId: string) => {
      if (credentialsId === 'cred-broken') throw new Error('cannot decrypt');
      return SECRETS[credentialsId];
    });

    const res = await post('/acme_crm/wake', WAKE, BEARER_A);

    expect(res.status).toBe(202);
    expect(deliverArrivals).toHaveBeenCalledWith(expect.objectContaining({ teamId: A_TEAM }));
  });
});

describe('bodies', () => {
  it.each([
    ['no arrivals', {}],
    ['an empty list', { arrivals: [] }],
    ['an arrival with no edge', { arrivals: [{ ...ARRIVAL, edge: '' }] }],
    ['an arrival with no landing', { arrivals: [{ edge: 'Replies', key: 'thread:1', identity: 'msg-1' }] }],
    ['more than 1000 arrivals', { arrivals: Array.from({ length: 1001 }, (_, i) => ({ ...ARRIVAL, identity: `m${i}` })) }],
  ])('wake refuses %s with 400', async (_label, body) => {
    const res = await post('/acme_crm/wake', body, BEARER_A);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(deliverArrivals).not.toHaveBeenCalled();
  });

  it('a wake naming keys, as before adapter protocol 2.5, is refused naming arrivals', async () => {
    const res = await post('/acme_crm/wake', { keys: ['thread:1'], arrivals: [ARRIVAL] }, BEARER_A);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/arrivals/);
    expect(deliverArrivals).not.toHaveBeenCalled();
  });

  it('a body over 1 MB is refused 413 before anything is authenticated', async () => {
    const res = await fetch(`${baseUrl}/api/public/adapter/acme_crm/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...BEARER_A },
      body: JSON.stringify({ arrivals: [{ ...ARRIVAL, landing: { fields: { Text: 'x'.repeat(1024 * 1024) } } }] }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(listRemoteAdaptersOfType).not.toHaveBeenCalled();
    expect(deliverArrivals).not.toHaveBeenCalled();
  });

  it('a body just under 1 MB is read', async () => {
    const res = await post('/acme_crm/wake', { arrivals: [{ ...ARRIVAL, landing: { fields: { Text: 'x'.repeat(1024 * 1024 - 256) } } }] }, BEARER_A);

    expect(res.status).toBe(202);
  });

  it('a malformed body from an unauthenticated caller is 401, not 400', async () => {
    expect((await post('/acme_crm/wake', { arrivals: [] })).status).toBe(401);
  });
});

describe('emit', () => {
  it('is refused by name once authenticated: from 0.13 an event fires no listen, so nothing is kept', async () => {
    const res = await post('/acme_crm/emit', { events: [EVENT] }, BEARER_A);

    expect(res.status).toBe(410);
    expect(res.body.error).toBe('emit_retired');
    expect(res.body.message).toMatch(/wake/);
    expect(deliverArrivals).not.toHaveBeenCalled();
    expect(notifyWork).not.toHaveBeenCalled();
  });
});

describe('wake', () => {
  it("keeps the arrivals as one delivery of the caller's install, and pokes the drain", async () => {
    const second = { ...ARRIVAL, key: 'thread:2', identity: 'msg-2' };
    const res = await post('/acme_crm/wake', { arrivals: [ARRIVAL, second] }, BEARER_A);

    expect(res).toEqual({ status: 202, body: { accepted: 2 } });
    expect(deliverArrivals).toHaveBeenCalledTimes(1);
    expect(deliverArrivals).toHaveBeenCalledWith({
      teamId: A_TEAM,
      delivered: { adapterType: 'acme_crm', credentialsId: null },
      subscriptionId: expect.any(String),
      externalId: null,
      source: 'emit',
      arrivals: [ARRIVAL, second],
      // A push is kept as the arrivals it pushed, which a replay judges again.
      request: { adapter: 'acme_crm', arrivals: [ARRIVAL, second] },
    });
    // A carried version's listens on the module judge the same page, named by its delivery.
    expect(judgeCarriedPage).toHaveBeenCalledWith({ teamId: A_TEAM, adapterType: 'acme_crm', credentialsId: null, page: [ARRIVAL, second], stableKey: 'push:kept-1' });
    expect(notifyWork).toHaveBeenCalled();
  });

  it('a delivery that cannot be kept answers 500, so the caller retries', async () => {
    deliverArrivals.mockRejectedValue(new Error('db down'));

    const res = await post('/acme_crm/wake', WAKE, BEARER_A);

    expect(res).toEqual({ status: 500, body: { error: 'internal' } });
    expect(notifyWork).not.toHaveBeenCalled();
  });
});

describe('the models door — a module served as a process asks for a model call', () => {
  const ASK = { label: 'acme.summarise', system: 'Be brief.', userMessage: 'Summarise Acme.' };

  it("answers the text and what it cost, billed to the install's team", async () => {
    let billedTo: string | undefined;
    anthropicChat.mockImplementation(async () => {
      billedTo = currentLlmUsageContext()?.data.teamId;
      reportRunCost({ source: { kind: 'model', name: 'claude-haiku-4-5' }, microdollars: 830 });
      return 'Acme makes anvils.';
    });

    const res = await post('/acme_crm/models', { ...ASK, model: 'claude-haiku-4-5', effort: 'low' }, BEARER_A);

    expect(res).toEqual({ status: 200, body: { text: 'Acme makes anvils.', cost: [{ label: 'anthropic/claude-haiku-4-5', microdollars: 830 }] } });
    expect(anthropicChat).toHaveBeenCalledWith({ ...ASK, model: 'claude-haiku-4-5', effort: 'low' });
    expect(billedTo).toBe(A_TEAM);
  });

  it("asks a schema request as a forced tool call carrying the module's JSON schema, and answers the data", async () => {
    const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
    anthropicChatStructured.mockImplementation(async (input: { schema: z.ZodType; toolName: string }) => {
      expect(z.toJSONSchema(input.schema)).toMatchObject(schema);
      expect(input.toolName).toBe('location');
      return { city: 'Leeds' };
    });

    const res = await post('/acme_crm/models', { ...ASK, schema, toolName: 'location', toolDescription: 'Where it is.' }, BEARER_A);

    expect(res).toEqual({ status: 200, body: { text: '{"city":"Leeds"}', data: { city: 'Leeds' }, cost: [] } });
  });

  it('refuses an unauthenticated caller before reading the request, and a request the models cannot take', async () => {
    expect(await post('/acme_crm/models', ASK, { authorization: 'Bearer nope' })).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect((await post('/acme_crm/models', { label: 'x' }, BEARER_A)).status).toBe(400);
    const unknownModel = await post('/acme_crm/models', { ...ASK, model: 'gpt-9' }, BEARER_A);
    expect(unknownModel.status).toBe(400);
    expect(unknownModel.body.message).toMatch(/gpt-9/);
    expect((await post('/acme_crm/models', { ...ASK, schema: { type: 'array' } }, BEARER_A)).status).toBe(400);
    expect(anthropicChat).not.toHaveBeenCalled();
    expect(anthropicChatStructured).not.toHaveBeenCalled();
  });

  it('answers 502 when the model call fails', async () => {
    anthropicChat.mockRejectedValue(new Error('overloaded'));
    expect(await post('/acme_crm/models', ASK, BEARER_A)).toEqual({ status: 502, body: { error: 'model_call_failed', message: 'overloaded' } });
  });
});

