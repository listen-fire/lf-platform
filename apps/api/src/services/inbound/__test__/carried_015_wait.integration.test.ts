// A run parked on a wait for a Slack reply, under each version (real Postgres,
// the real Slack door, this release's real Slack module, save and drains). A
// team's 0.15.3 automation and its 0.16 one each wait, off the message that
// started them, for a reply that says "yes". Each reply is read once, by the
// current door's module, into the run host's one arrival log; each run's own
// engine judges it when the run resumes. So a reply that says "no" wakes both
// and resumes neither, and a "yes" finishes both: the 0.15.3 run judged by
// 0.15's engine, the 0.16 one by this release's, as before.
//
// The one network seam is Slack's Web API, a local stand-in both releases'
// modules reach as the test-harness team's fake.

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

const mockSlack = { baseUrl: '', teamId: '' };
jest.mock('../../../lib/recording', () => ({
  ...jest.requireActual('../../../lib/recording'),
  isTestHarnessTeam: (teamId: string) => teamId === mockSlack.teamId,
  injectFakeBaseUrl: (creds: Record<string, unknown>, service: string) => (service === 'SLACK' ? { ...creds, baseUrl: mockSlack.baseUrl } : creds),
}));

import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { encryptToken } from '../../../lib/credentials';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { ProvisioningService } from '../../provisioning';
import { SLACK_APP_ID } from '../../credentials/app_id';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { registerCoreWork } from '../../work/register';
import { saveMovement } from '../../translation_graph/movement/provision';
import { handleSlackEventsInbound } from '../../webhook_sync/slack_events';

const SLACK_TEAM = 'T015W';
const ROOT_TS = '1700000100.000100';

/** Slack's Web API as far as reading a message, its thread and its sender
 *  needs it. */
const SENDERS: Record<string, string> = { U1: 'ada@example.com' };
const thread: Array<{ ts: string; thread_ts: string; user: string; text: string }> = [];
function slackAnswer(method: string, query: URLSearchParams): unknown {
  switch (method) {
    case 'auth.test':
      return { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: SLACK_TEAM };
    case 'conversations.info':
      return { ok: true, channel: { id: 'C1', name: 'deals' } };
    case 'conversations.list':
      return { ok: true, channels: [{ id: 'C1', name: 'deals' }], response_metadata: { next_cursor: '' } };
    case 'conversations.replies':
      return { ok: true, messages: [{ ts: ROOT_TS, user: 'U1', text: 'ask' }, ...thread.map((reply) => ({ ...reply, channel: 'C1' }))], has_more: false };
    case 'conversations.history':
      return { ok: true, messages: [{ ts: ROOT_TS, user: 'U1', text: 'ask' }], has_more: false };
    case 'users.info': {
      const user = query.get('user') ?? '';
      const email = SENDERS[user];
      return email === undefined ? { ok: false, error: 'user_not_found' } : { ok: true, user: { id: user, profile: { email } } };
    }
    default:
      return { ok: false, error: `unknown_method ${method}` };
  }
}

/** The same automation in each version: off the message asking, wait for a
 *  reply in its thread that says "yes". */
const WAITS_FOR_YES =
  'import { slack } from adapters\nimport { deals } from credentials\nchat = connect slack using deals\n' +
  'function intake(m: <chat-[:Message]->>) {\n  r = await m-[x:Replies WHERE x.Message == "yes"]->\n  said = r.Message\n  return said\n}\n' +
  'listen to chat-[:Channels]->-[m:Messages WHERE m.Message == "ask"]-> fire intake\n';

let slack: Server;
let teamId: TeamId;
let credentialsId: ExternalServiceCredentialsId;
const automation: Record<'0.15.3' | 'current', MovementId> = { '0.15.3': randomUUID() as MovementId, current: randomUUID() as MovementId };

function envelope(input: { text: string; ts: string; threadTs?: string }) {
  return {
    type: 'event_callback',
    team_id: SLACK_TEAM,
    event_id: `Ev${input.ts}`,
    event: { type: 'message', channel: 'C1', user: 'U1', text: input.text, ts: input.ts, ...(input.threadTs !== undefined ? { thread_ts: input.threadTs } : {}) },
  };
}

async function reply(text: string, ts: string): Promise<void> {
  thread.push({ ts, thread_ts: ROOT_TS, user: 'U1', text });
  await handleSlackEventsInbound(envelope({ text, ts, threadTs: ROOT_TS }));
  await drainAll();
}

/** Each pass of the drain claims what is due; a row one pass queues (a
 *  reading's dispatch, a run, a wake) is the next pass's. */
async function drainAll(): Promise<void> {
  for (let pass = 0; pass < 8; pass++) {
    const drained = await drainUntilIdle({ owner: 'carried-wait', teamId });
    if (drained.claimed === 0) return;
  }
}

/** The automation's runs, as its pin and status. */
async function runsOf(movementId: MovementId) {
  return getAutomationsQb(['trigger_run', 'movement_version'])
    .selectFrom('trigger_run')
    .innerJoin('movement_version', 'movement_version.id', 'trigger_run.movement_version_id')
    .where('movement_version.movement_id', '=', movementId)
    .select(['trigger_run.id as id', 'trigger_run.status as status', 'trigger_run.failure_reason as failure', 'movement_version.language_version as pin'])
    .execute();
}

/** What the run's engine noted of each arrival its waits read: whether it
 *  matched the wait's WHERE. */
async function judgedBy(runId: string): Promise<boolean[]> {
  const rows = await getAutomationsQb(['wait_seen', 'wait_row'])
    .selectFrom('wait_seen')
    .innerJoin('wait_row', 'wait_row.id', 'wait_seen.wait_id')
    .where('wait_row.run_id', '=', runId as never)
    .select('wait_seen.matched')
    .execute();
  return rows.map((row) => row.matched);
}

/** The run's waits that are parked, on which edge. */
async function parkedWaitsOf(runId: string) {
  return getAutomationsQb(['wait_row']).selectFrom('wait_row').where('run_id', '=', runId as never).where('address', 'is not', null).select(['edge', 'key']).execute();
}

beforeAll(async () => {
  slack = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = url.pathname.split('/').at(-1) ?? '';
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      for (const [key, value] of url.searchParams) form.set(key, value);
      const json: unknown = body.trim().startsWith('{') ? JSON.parse(body) : undefined;
      if (typeof json === 'object' && json !== null) for (const [key, value] of Object.entries(json)) if (typeof value === 'string') form.set(key, value);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(slackAnswer(method, form)));
    });
  });
  await new Promise<void>((resolve) => slack.listen(0, '127.0.0.1', resolve));
  const address = slack.address();
  mockSlack.baseUrl = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}/api/` : '';

  resetWorkHandlersForTests();
  registerCoreWork();
  setWorkNotifier({ notify() {} });

  teamId = randomUUID() as TeamId;
  mockSlack.teamId = teamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `carried-wait-${teamId.slice(0, 8)}` }).execute();
  await ProvisioningService.provisionUser({ teamId, email: 'ada@example.com', access: 'admin' });
  credentialsId = randomUUID() as ExternalServiceCredentialsId;
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({
      id: credentialsId,
      team_id: teamId,
      type: ExternalServiceType.SLACK,
      name: 'deals',
      identifier: `teamId:${SLACK_TEAM}`,
      app_id: SLACK_APP_ID.movements,
      user_id: null,
      credentials: await encryptToken(JSON.stringify({ accessToken: 'xoxb-test', access_token: 'xoxb-test' }), credentialsId),
    })
    .execute();

  for (const [pin, id] of [['0.15.3', automation['0.15.3']], [LANGUAGE_VERSION, automation.current]] as const) {
    await getAutomationsQb(['movement']).insertInto('movement').values({ id, team_id: teamId, name: `waits-${pin}`, source: WAITS_FOR_YES, description: '', language_version: pin }).execute();
    const saved = await saveMovement({ audience: { for: 'run' }, teamId, id, source: WAITS_FOR_YES });
    if (!saved.ok) throw new Error(`test: the ${pin} automation did not save: ${JSON.stringify(saved)}`);
  }
});

afterAll(async () => {
  setWorkNotifier(inProcessNotifier);
  resetWorkHandlersForTests();
  await new Promise<void>((resolve) => slack.close(() => resolve()));
  await cleanupTeam(teamId);
});

describe('a run parked on a wait for a Slack reply, under each version (real Postgres)', () => {
  it('the message asking starts both runs, and each parks on its message\'s Replies', async () => {
    await handleSlackEventsInbound(envelope({ text: 'ask', ts: ROOT_TS }));
    await drainAll();
    for (const [pin, id] of [['0.15.3', automation['0.15.3']], [LANGUAGE_VERSION, automation.current]] as const) {
      const runs = await runsOf(id);
      expect(runs).toEqual([expect.objectContaining({ status: 'parked', failure: null, pin })]);
      expect(await parkedWaitsOf(runs[0]!.id)).toEqual([expect.objectContaining({ edge: 'Replies' })]);
      expect(await judgedBy(runs[0]!.id)).toEqual([]);
    }
  });

  it('a reply that does not match wakes both runs, and each engine judges it and parks again', async () => {
    await reply('no', '1700000100.000200');
    for (const id of [automation['0.15.3'], automation.current]) {
      const runs = await runsOf(id);
      expect(runs).toEqual([expect.objectContaining({ status: 'parked', failure: null })]);
      expect(await parkedWaitsOf(runs[0]!.id)).toEqual([expect.objectContaining({ edge: 'Replies' })]);
      // Its engine read the reply off the shared log and judged it: no match.
      expect(await judgedBy(runs[0]!.id)).toEqual([false]);
    }
  });

  it("a reply that matches resumes both: the 0.15.3 run judged by 0.15's engine, the 0.16 one as before", async () => {
    await reply('yes', '1700000100.000300');
    expect(await runsOf(automation['0.15.3'])).toEqual([expect.objectContaining({ status: 'success', failure: null, pin: '0.15.3' })]);
    expect(await runsOf(automation.current)).toEqual([expect.objectContaining({ status: 'success', failure: null, pin: LANGUAGE_VERSION })]);
  });
});
