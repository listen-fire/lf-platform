// A 0.15 listen as 0.15 plans, reads and judges it: its row is 0.15's own
// plan, a kept Slack delivery is read by 0.15's Slack module and judged by
// 0.15's judge, and the old ownership gate asks 0.15's module who sent it.

import { createServer, type Server } from 'node:http';

import { gateFiring, isListenRow, planListens, readDelivery } from '../lane/listen';
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
    expect(planned).toEqual({ ok: true, refused: [], listens: [expect.objectContaining({ pipeline: expect.stringContaining('intake'), plan: expect.objectContaining({ movement: 'intake' }) })] });
    if (!planned.ok) return;
    expect(isListenRow({ config: { listen: planned.listens[0] } })).toBe(true);
    // A row another release planned is not 0.15's: its plan does not read as 0.15's.
    expect(isListenRow({ config: { listen: { ...planned.listens[0], plan: { lane: 'x' } } } })).toBe(false);
  });

  it("reads a kept Slack delivery with 0.15's module and fires the listen its judge passes", async () => {
    const planned = await planListens({ source: SLACK_015, pin: '0.15.3', file: 'intake', team: team(), connected: { teamId: 'team-1', modules: modules() } });
    if (!planned.ok) throw new Error('unplanned');
    const row = { id: 'trigger-1', credentialsId: 'c1', config: { listen: planned.listens[0] } };
    const read = (text: string) =>
      readDelivery(
        { teamId: 'team-1', adapterType: 'slack', credentialsId: 'c1', matchAnyCredential: true, delivery: { body: message(text) }, listens: [row], now: new Date().toISOString() },
        modules(),
      );
    const fired = await read('hello');
    expect(fired.receipts).toEqual([{ triggerId: 'trigger-1', event: expect.objectContaining({ adapterType: 'slack' }) }]);
    // The filter is 0.15's: an empty message does not pass it.
    expect((await read('')).receipts).toEqual([]);

    const gate = await gateFiring({ teamId: 'team-1', adapterType: 'slack', credentialsId: 'c1', config: row.config, event: fired.receipts[0]?.event ?? {} }, modules());
    expect(gate).toEqual({ kind: 'needs-actor', candidates: [expect.objectContaining({ identity: expect.objectContaining({ identifier: 'U1', email: 'ada@example.com' }) })] });
  });
});
