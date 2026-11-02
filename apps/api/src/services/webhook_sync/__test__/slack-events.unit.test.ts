// The Listen-Fire Slack app's Events door routes each delivery by the envelope
// team_id → the app_id='listen-fire' install for that workspace → its Listen-Fire team +
// credential, reads the delivery's arrivals with that credential, and keeps
// them as one delivery of that connection (its listens judge it, and it is
// their send identity). A workspace with no install is dropped. Plus the route's signature auth, and
// the durable hand-off: the route answers only once the delivery is a
// `slack_event` row, and the routing above runs when that row drains.

import crypto from "node:crypto";

// external_service_credentials lookup — keyed by the `identifier` (teamId:<id>).
const installByIdentifier = new Map<string, { id: string; team_id: string }>();
jest.mock('../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: () => {
      const conds: Record<string, unknown> = {};
      const chain = {
        where(col: string, _op: string, val: unknown) {
          conds[col] = val;
          return chain;
        },
        select() {
          return chain;
        },
        async executeTakeFirst() {
          return installByIdentifier.get(String(conds.identifier));
        },
      };
      return chain;
    },
  });
  return { getQb: qb, getCoreQb: qb, getAutomationsQb: qb };
});

const ARRIVAL = { edge: 'Messages', key: 'C1', identity: 'C1:1.0', landing: { recordId: 'C1:1.0', recordType: 'Slack Message', fields: { Text: 'hi' } } };
const dispatchCalls: Array<{ team: string; cred: string | null; adapter: string; externalId: string | null; arrivals: unknown[] }> = [];
let dispatchFails = false;
jest.mock('../../inbound/listen_door', () => ({
  deliverArrivals: jest.fn(async (input: any) => {
    if (dispatchFails) throw new Error('store unreachable');
    dispatchCalls.push({
      team: input.teamId,
      cred: input.delivered.credentialsId,
      adapter: input.delivered.adapterType,
      externalId: input.externalId,
      arrivals: input.arrivals,
    });
    return { kept: { kept: true, arrivalMark: 1 }, deliveryId: 'd1', fires: [{ runId: 'r1' }] };
  }),
}));

const preprocessInbound = jest.fn(async (_input: { raw: unknown }) => ({ events: [], arrivals: [ARRIVAL] }));
jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(async () => ({ adapterType: 'slack', preprocessInbound })),
}));

/** The rows the route queued, in order: what the drain would run. */
const queued: Array<{ kind: string; key: string; payload: unknown }> = [];
let holdEnqueue: Promise<void> | undefined;
jest.mock('../../work/store', () => ({
  enqueueWork: async (row: { kind: string; key: string; payload: unknown }) => {
    await holdEnqueue;
    queued.push(row);
  },
}));
jest.mock('../../work/drain', () => ({
  ...jest.requireActual('../../work/drain'),
  notifyWork: () => {},
}));

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { handleSlackEventsInbound, slackEventHandler } from '../slack_events';
import { slackEventsRouter, verifySlackEventsRequest } from '../../../interfaces/rest/slackEvents';

const nowSeconds = (): string => String(Math.floor(Date.now() / 1000));

const TEAM = '00000000-0000-4000-8000-000000000001';

function eventCallback(teamId: string) {
  return {
    type: 'event_callback',
    team_id: teamId,
    event: { type: 'message', user: 'U1', channel: 'C1', ts: '1.0', text: 'hi' },
  };
}

beforeEach(() => {
  installByIdentifier.clear();
  dispatchCalls.length = 0;
  dispatchFails = false;
  queued.length = 0;
  holdEnqueue = undefined;
  preprocessInbound.mockClear();
});

describe('handleSlackEventsInbound — team_id routing', () => {
  it("keeps the module's arrivals as a delivery of the workspace install (its Listen-Fire team + credential)", async () => {
    installByIdentifier.set('teamId:T_SLACK', { id: 'cred-slack', team_id: TEAM });
    const raw = { ...eventCallback('T_SLACK'), event_id: 'Ev1' };
    const result = await handleSlackEventsInbound(raw);
    expect(result).toEqual({ ok: true, classification: 'dispatched', teamId: 'T_SLACK', eventsProcessed: 1 });
    expect(preprocessInbound).toHaveBeenCalledWith({ raw });
    expect(dispatchCalls).toEqual([{ team: TEAM, cred: 'cred-slack', adapter: 'slack', externalId: 'slack:Ev1', arrivals: [ARRIVAL] }]);
  });

  it('keeps nothing for a delivery that brought no arrivals', async () => {
    installByIdentifier.set('teamId:T_SLACK', { id: 'cred-slack', team_id: TEAM });
    preprocessInbound.mockResolvedValueOnce({ events: [], arrivals: [] });
    const result = await handleSlackEventsInbound(eventCallback('T_SLACK'));
    expect(result.classification).toBe('no_events');
    expect(dispatchCalls).toHaveLength(0);
  });

  it('drops a workspace with no Listen-Fire install', async () => {
    const result = await handleSlackEventsInbound(eventCallback('T_UNKNOWN'));
    expect(result.classification).toBe('unknown_workspace');
    expect(dispatchCalls).toHaveLength(0);
  });

  it('drops a delivery with no team_id', async () => {
    const result = await handleSlackEventsInbound({ type: 'event_callback', event: { type: 'message' } });
    expect(result.classification).toBe('no_team');
    expect(dispatchCalls).toHaveLength(0);
  });
});

describe('verifySlackEventsRequest — signature auth (fail-closed)', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  // Slack's replay window is five minutes (enforced by the core's verifier),
  // so a delivery is signed on the test's own clock.
  function signed(body: Buffer, secret: string, ts = nowSeconds()): Record<string, string> {
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
    return { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig };
  }

  it('authorizes a correctly-signed request', () => {
    process.env.SLACK_MOVEMENTS_SIGNING_SECRET = 'shh';
    const body = Buffer.from(JSON.stringify(eventCallback('T')));
    expect(verifySlackEventsRequest(body, signed(body, 'shh'))).toEqual({ authorized: true });
  });

  it('refuses a delivery signed more than five minutes ago as a replay', () => {
    process.env.SLACK_MOVEMENTS_SIGNING_SECRET = 'shh';
    const body = Buffer.from(JSON.stringify(eventCallback('T')));
    const stale = String(Number(nowSeconds()) - 6 * 60);
    expect(verifySlackEventsRequest(body, signed(body, 'shh', stale))).toEqual({
      authorized: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects a bad signature', () => {
    process.env.SLACK_MOVEMENTS_SIGNING_SECRET = 'shh';
    const body = Buffer.from('{}');
    expect(verifySlackEventsRequest(body, signed(body, 'wrong'))).toEqual({
      authorized: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects everything when no secret is set in production', () => {
    delete process.env.SLACK_MOVEMENTS_SIGNING_SECRET;
    process.env.NODE_ENV = 'production';
    expect(verifySlackEventsRequest(Buffer.from('{}'), {})).toEqual({
      authorized: false,
      reason: 'no_secret',
    });
  });

  it('rejects an unsigned delivery OUTSIDE production too, unless it was opted into', () => {
    delete process.env.SLACK_MOVEMENTS_SIGNING_SECRET;
    delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
    process.env.NODE_ENV = 'development';
    expect(verifySlackEventsRequest(Buffer.from('{}'), {})).toEqual({
      authorized: false,
      reason: 'no_secret',
    });

    process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';
    expect(verifySlackEventsRequest(Buffer.from('{}'), {})).toEqual({ authorized: true });
  });
});

describe('the route: durable, then answered; the drain does the work', () => {
  const OLD_ENV = { ...process.env };
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    const app = express();
    app.use('/api/public/slack', express.raw({ type: 'application/json' }), slackEventsRouter);
    server = createServer(app);
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });
  afterAll((done) => {
    server.close(() => done());
  });
  beforeEach(() => {
    process.env.SLACK_MOVEMENTS_SIGNING_SECRET = 'shh';
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  function deliver(envelope: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const body = JSON.stringify(envelope);
    const ts = nowSeconds();
    const sig = 'v0=' + crypto.createHmac('sha256', 'shh').update(`v0:${ts}:${body}`).digest('hex');
    return fetch(`${baseUrl}/api/public/slack/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig, ...extraHeaders },
      body,
    });
  }

  const ctx = (attempts: number) => ({ now: new Date(), owner: 'test', attempts, heartbeat: async () => {} });

  it('answers only after the slack_event row is written, and dispatches nothing in the request', async () => {
    installByIdentifier.set('teamId:T_SLACK', { id: 'cred-slack', team_id: TEAM });
    let release: () => void = () => {};
    holdEnqueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    let answered = false;
    const response = deliver({ ...eventCallback('T_SLACK'), event_id: 'Ev1' }).then((res) => {
      answered = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);

    release();
    expect((await response).status).toBe(200);
    expect(queued.map((row) => [row.kind, row.key])).toEqual([['slack_event', 'slack_event:Ev1']]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatchCalls).toHaveLength(0);
  });

  it('runs the delivery when the row drains', async () => {
    installByIdentifier.set('teamId:T_SLACK', { id: 'cred-slack', team_id: TEAM });
    await deliver({ ...eventCallback('T_SLACK'), event_id: 'Ev2' });

    await slackEventHandler.run(queued[0]?.payload, ctx(1));

    expect(dispatchCalls).toEqual([{ team: TEAM, cred: 'cred-slack', adapter: 'slack', externalId: 'slack:Ev2', arrivals: [ARRIVAL] }]);
  });

  it("keys Slack's retry onto the same row as the first delivery", async () => {
    const envelope = { ...eventCallback('T_SLACK'), event_id: 'Ev3' };
    await deliver(envelope);
    await deliver(envelope, { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' });

    expect(queued.map((row) => row.key)).toEqual(['slack_event:Ev3', 'slack_event:Ev3']);
  });

  it('answers 500 when the row cannot be written, so Slack redelivers', async () => {
    holdEnqueue = Promise.reject(new Error('work table unreachable'));
    holdEnqueue.catch(() => {});

    const res = await deliver({ ...eventCallback('T_SLACK'), event_id: 'Ev4' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'enqueue_failed' });
  });

  it('a delivery that cannot be kept fails the row so it retries, and is given up on only after many attempts', async () => {
    installByIdentifier.set('teamId:T_SLACK', { id: 'cred-slack', team_id: TEAM });
    dispatchFails = true;
    const payload = { envelope: { ...eventCallback('T_SLACK'), event_id: 'Ev5' } };

    await expect(slackEventHandler.run(payload, ctx(1))).rejects.toThrow(/store unreachable/);
    await expect(slackEventHandler.run(payload, ctx(10))).resolves.toBeUndefined();
  });
});
