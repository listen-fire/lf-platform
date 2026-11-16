// A 0.15 listen as 0.15 plans, reads and judges it: its row is 0.15's own
// plan, a kept Slack delivery is read by 0.15's Slack module and judged by
// 0.15's judge, and the old ownership gate asks 0.15's module who sent it.

import { createServer, type Server } from 'node:http';

import { eventAt, gateFiring, isListenRow, judgeEvent, judgePage, planListens, readDelivery } from '../lane/listen';
import { watchOf } from '../lane/watch';
import type { ModulePlatform } from '../lane/run_types';
import type { TeamFacts } from '../lane/types';

const refused = async (): Promise<never> => {
  throw new Error('not part of this test');
};

/** Slack's Web API as far as reading one message needs it, on a local port. */
const answers: Record<string, unknown> = {
  'auth.test': { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: 'T1' },
  'conversations.info': { ok: true, channel: { id: 'C1', name: 'deals' } },
  'conversations.list': { ok: true, channels: [{ id: 'C1', name: 'deals' }], response_metadata: { next_cursor: '' } },
  'users.info': { ok: true, user: { id: 'U1', profile: { email: 'ada@example.com' } } },
};
let slack: Server;
let baseUrl = '';
beforeAll(async () => {
  slack = createServer((request, response) => {
    const method = (request.url ?? '').split('?')[0]?.split('/').at(-1) ?? '';
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(answers[method] ?? { ok: false, error: `unknown_method ${method}` }));
  });
  await new Promise<void>((resolve) => slack.listen(0, '127.0.0.1', resolve));
  const address = slack.address();
  baseUrl = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}/api/` : '';
});
afterAll(() => new Promise<void>((resolve) => slack.close(() => resolve())));

const store = new Map<string, unknown>();
const modules = (): ModulePlatform => ({
  hostFor: () => ({
    credential: { name: 'bot', fields: async () => ({ accessToken: 'xoxb-test' }), update: async () => {} },
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: refused,
      compareAndSet: refused,
    },
    files: { put: refused, read: refused, expose: refused },
    baseUrlOverride: baseUrl,
  }),
  parts: {
    askAnswerUrl: () => '',
    kgStore: () => {
      throw new Error('no kg');
    },
    kgChangeWebhooks: false,
    slackChat: refused,
    readFile: refused,
    whatsappNumber: null,
    isExposedFileUrl: () => false,
    systemRecords: () => ({ failedRuns: refused, pausedRuns: refused, strandedWaits: refused, releases: refused, unjudgedArrivals: refused, webBaseUrl: async () => null }),
    remoteInstall: refused,
    readDocument: refused,
  },
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  validateResults: false,
});

function team(): TeamFacts {
  return { credentials: [{ id: 'c1', name: 'deals', type: 'SLACK' }], files: [], connectOf: () => 'oauth', kgChangeWebhooks: false, mcpEnabled: false, whatsappNumber: null };
}

const SLACK_015 =
  'import { slack } from adapters\nimport { deals } from credentials\nchat = connect slack using deals\n' +
  'function intake(m: <chat-[:Message]->>) {\n  who = @user_email\n  said = m.Message\n}\n' +
  'listen to chat-[:Channels]->-[m:Messages WHERE m.Message != ""]-> fire intake\n';

const message = (text: string) =>
  Buffer.from(
    JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event: { type: 'message', channel: 'C1', user: 'U1', text, ts: '1700000000.000100' } }),
  ).toString('base64');

describe("a 0.15 listen, by 0.15's planner, module and judge", () => {
  it("plans a Slack listen into a row in 0.15's own listen shape", async () => {
    const planned = await planListens({ source: SLACK_015, pin: '0.15.3', file: 'intake', team: team(), connected: { teamId: 'team-1', modules: modules() } });
    expect(planned).toEqual({ ok: true, refused: [], listens: [{ listen: expect.objectContaining({ pipeline: expect.stringContaining('intake'), plan: expect.objectContaining({ movement: 'intake' }) }), textRunMode: 'live' }] });
    if (!planned.ok) return;
    expect(isListenRow({ config: { listen: planned.listens[0]?.listen } })).toBe(true);
    // A row another release planned is not 0.15's: its plan does not read as 0.15's.
    expect(isListenRow({ config: { listen: { ...planned.listens[0]?.listen, plan: { lane: 'x' } } } })).toBe(false);
  });

  it("reads a kept Slack delivery with 0.15's module and fires the listen its judge passes", async () => {
    const planned = await planListens({ source: SLACK_015, pin: '0.15.3', file: 'intake', team: team(), connected: { teamId: 'team-1', modules: modules() } });
    if (!planned.ok) throw new Error('unplanned');
    const row = { id: 'trigger-1', credentialsId: 'c1', config: { listen: planned.listens[0]?.listen } };
    const read = (text: string) =>
      readDelivery(
        { teamId: 'team-1', adapterType: 'slack', credentialsId: 'c1', matchAnyCredential: true, delivery: { body: message(text) }, listens: [row], now: new Date().toISOString() },
        modules(),
      );
    const fired = await read('hello');
    expect(fired.receipts).toEqual([{ triggerId: 'trigger-1', event: expect.objectContaining({ adapterType: 'slack' }), arrivalKey: expect.stringContaining('1700000000') }]);
    expect(fired.edges).toEqual(['Messages']);
    // The filter is 0.15's: an empty message does not pass it.
    expect((await read('')).receipts).toEqual([]);

    const gate = await gateFiring({ teamId: 'team-1', adapterType: 'slack', credentialsId: 'c1', config: row.config, event: fired.receipts[0]?.event ?? {} }, modules());
    expect(gate).toEqual({ kind: 'needs-actor', candidates: [expect.objectContaining({ identity: expect.objectContaining({ identifier: 'U1', email: 'ada@example.com' }) })] });
  });

  it("judges a page a door built with 0.15's judge, reading each arrival with 0.15's own schema", async () => {
    const planned = await planListens({ source: SLACK_015, pin: '0.15.3', file: 'intake', team: team(), connected: { teamId: 'team-1', modules: modules() } });
    if (!planned.ok) throw new Error('unplanned');
    const row = { id: 'trigger-1', credentialsId: 'c1', config: { listen: planned.listens[0]?.listen } };
    const said = (text: string, identity: string) => ({ edge: 'Messages', identity, landing: { recordId: identity, recordType: 'Message', fields: { Message: text } } });
    const judged = judgePage({ teamId: 'team-1', adapterType: 'slack', credentialsId: null, page: [said('hello', 'a'), said('', 'b'), { edge: 7 }], listens: [row], now: new Date().toISOString() });
    // A page for no connection is the install's: the listen on `c1` hears it.
    expect(judged.receipts).toEqual([{ triggerId: 'trigger-1', event: expect.objectContaining({ adapterType: 'slack' }), arrivalKey: expect.stringContaining('a') }]);
    expect(judged.lines).toEqual([expect.stringContaining('an arrival 0.15 does not read')]);
    // The edges of the arrivals it read, fired or not: an arrival on a listed
    // hop's edge lists its listen again.
    expect(judged.edges).toEqual(['Messages']);
    // A page for another connection is not this listen's.
    expect(judgePage({ teamId: 'team-1', adapterType: 'slack', credentialsId: 'c2', page: [said('hello', 'a')], listens: [row], now: new Date().toISOString() }).receipts).toEqual([]);
  });

  it("judges one event of a kept delivery for each row, with the event its run is handed, as 0.15's reading judges it", async () => {
    const planned = await planListens({ source: SLACK_015, pin: '0.15.3', file: 'intake', team: team(), connected: { teamId: 'team-1', modules: modules() } });
    if (!planned.ok) throw new Error('unplanned');
    const row = { id: 'trigger-1', credentialsId: 'c1', config: { listen: planned.listens[0]?.listen } };
    const elsewhere = { ...row, id: 'trigger-2', credentialsId: 'c2' };
    const notOurs = { id: 'trigger-3', credentialsId: 'c1', config: { listen: { plan: { lane: 'x' } } } };
    const judge = (text: string, arrivalIndex = 0) =>
      judgeEvent(
        { teamId: 'team-1', adapterType: 'slack', credentialsId: 'c1', kept: { delivery: { body: message(text) } }, arrivalIndex, listens: [row, elsewhere, notOurs], now: new Date().toISOString() },
        modules(),
      );
    expect(await judge('hello')).toEqual({
      ok: true,
      edge: 'Messages',
      listens: [
        { triggerId: 'trigger-1', heard: true, verdict: { kind: 'fires' }, event: expect.objectContaining({ adapterType: 'slack' }) },
        // Another connection's listen does not hear it; a row that is not 0.15's is left out.
        { triggerId: 'trigger-2', heard: false },
      ],
    });
    // The filter fails, and the event a vouched run is handed is still there.
    expect(await judge('')).toEqual({
      ok: true,
      edge: 'Messages',
      listens: [
        { triggerId: 'trigger-1', heard: true, verdict: { kind: 'skips', edge: 'Messages' }, event: expect.objectContaining({ adapterType: 'slack' }) },
        { triggerId: 'trigger-2', heard: false },
      ],
    });
    expect(await judge('hello', 1)).toEqual({ ok: false, refused: expect.stringContaining('no event at 1') });
    // Kept with more events than 0.15's module reads from it: which one is meant cannot be told.
    const keptWithTwo = await judgeEvent(
      { teamId: 'team-1', adapterType: 'slack', credentialsId: 'c1', kept: { delivery: { body: message('hello') }, brought: ['a', 'b'] }, arrivalIndex: 0, listens: [row], now: new Date().toISOString() },
      modules(),
    );
    expect(keptWithTwo).toEqual({ ok: false, refused: expect.stringContaining('kept with 2 events') });

    const said = { edge: 'Messages', identity: 'a', landing: { recordId: 'a', recordType: 'Message', fields: { Message: 'hi' } } };
    const page = await judgeEvent({ teamId: 'team-1', adapterType: 'slack', credentialsId: null, kept: { page: [said] }, arrivalIndex: 0, listens: [row], now: new Date().toISOString() }, modules());
    // A page for no connection is the install's: the listen on `c1` hears it.
    expect(page).toEqual({ ok: true, edge: 'Messages', listens: [expect.objectContaining({ triggerId: 'trigger-1', heard: true, verdict: { kind: 'fires' } })] });
  });

  it('takes the event at a place of several only when 0.15 reads that place as the event it was kept with', () => {
    const said = (identity: string) => ({ edge: 'Messages', identity, landing: { recordId: identity, recordType: 'Message', fields: { Message: identity } } });
    const present = [said('a'), said('b')];
    // The keys the delivery was kept with, in its order: 0.15 reads the same two.
    expect(eventAt({ present, brought: ['Messages::a:', 'Messages::b:'], arrivalIndex: 1 })).toEqual({ arrival: said('b') });
    // Another order, or another event, at that place is refused, never guessed.
    expect(eventAt({ present, brought: ['Messages::b:', 'Messages::a:'], arrivalIndex: 1 })).toEqual({ refused: expect.stringContaining('another event at 1') });
    expect(eventAt({ present, brought: ['Messages::a:'], arrivalIndex: 0 })).toEqual({ refused: expect.stringContaining('kept with 1 events') });
    // One event each way is that event, however each release names it.
    expect(eventAt({ present: [said('a')], brought: ['elsewhere'], arrivalIndex: 0 })).toEqual({ arrival: said('a') });
  });

  it('says how a 0.15 row is watched, off its own plan', async () => {
    const planned = await planListens({ source: SLACK_015, pin: '0.15.3', file: 'intake', team: team(), connected: { teamId: 'team-1', modules: modules() } });
    if (!planned.ok) throw new Error('unplanned');
    const listen = planned.listens[0]?.listen;
    expect(watchOf({ config: { listen } })).toEqual({
      pipeline: listen?.pipeline,
      adapter: 'slack',
      movement: 'intake',
      traversals: [expect.objectContaining({ edge: 'Messages', resolves: false, pushedParentEdges: [] })],
    });
    expect(watchOf({ config: { listen: { ...listen, plan: { lane: 'x' } } } })).toBeNull();
  });

  it("keeps the run mode the fired function's writes imply: a rehearsing connection's listen is dry_run", async () => {
    const rehearsing =
      'import { slack } from adapters\nimport { deals } from credentials\nchat = connect slack using deals { dryRun: true }\n' +
      'function intake(m: <chat-[:Message]->>) {\n  chat-[ch:Channels]-> {\n    write ch-[:Messages]-> { Message: "seen" }\n  }\n}\n' +
      'listen to chat-[:Channels]->-[m:Messages WHERE m.Message != ""]-> fire intake\n';
    const planned = await planListens({ source: rehearsing, pin: '0.15.3', file: 'intake', team: team(), connected: { teamId: 'team-1', modules: modules() } });
    expect(planned).toEqual({ ok: true, refused: [], listens: [expect.objectContaining({ textRunMode: 'dry_run' })] });
  });
});
