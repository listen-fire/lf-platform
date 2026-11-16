// One Slack delivery, two versions (real Postgres, the real door and drains):
// a team has a 0.16 automation and a 0.15.3 automation listening to the same
// Slack connection. The row's pin chooses who reads it. The current door judges
// only the 0.16 row, with this release's judge and its filter; the 0.15 row is
// read again by 0.15's own Slack module, judged by 0.15's judge, and gated by
// the old ownership gate, which asks 0.15's module who sent the message. An
// unregistered sender is suppressed there; a team member's message runs the
// 0.15 automation on 0.15's engine.
//
// The one network seam is Slack's Web API, a local stand-in both releases'
// modules reach as the test-harness team's fake. This release's module is
// stood in for by its arrivals, as the door tests do: this test is about who
// judges which row, and the 0.16 judge runs for real over them.

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

const mockSlack = { baseUrl: '', teamId: '' };
jest.mock('../../../lib/recording', () => ({
  ...jest.requireActual('../../../lib/recording'),
  isTestHarnessTeam: (teamId: string) => teamId === mockSlack.teamId,
  injectFakeBaseUrl: (creds: Record<string, unknown>, service: string) => (service === 'SLACK' ? { ...creds, baseUrl: mockSlack.baseUrl } : creds),
}));
const mockResolve = jest.fn();
jest.mock('../../translation_graph/adapters/resolve', () => ({
  ...jest.requireActual('../../translation_graph/adapters/resolve'),
  resolveAdapter: (...args: unknown[]) => mockResolve(...args),
}));

import { LANGUAGE_VERSION } from 'movement-lang';
import { versionOf } from '@listen-fire/language-versions';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { encryptToken } from '../../../lib/credentials';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen, takenEquals } from '../../../test/harness/listens';
import { ProvisioningService } from '../../provisioning';
import { SLACK_APP_ID } from '../../credentials/app_id';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { modulePlatform } from '../../translation_graph/movement/carried_run';
import { registerCarriedRunWork } from '../../translation_graph/movement/carried_run_now';
import { mintMovementVersionIfChanged } from '../../translation_graph/movement/version_store';
import { registerDispatchWork } from '../../translation_graph/triggers/dispatch_event';
import { handleSlackEventsInbound } from '../../webhook_sync/slack_events';
import { registerReadDeliveryWork } from '../carried_delivery';
import { savedListens } from '../listen_door';

const SLACK_TEAM = 'T015';

/** Slack's Web API as far as reading a message and its sender needs it. */
const SENDERS: Record<string, string> = { U1: 'ada@example.com', U2: 'mallory@elsewhere.test' };
function slackAnswer(method: string, query: URLSearchParams): unknown {
  switch (method) {
    case 'auth.test':
      return { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: SLACK_TEAM };
    case 'conversations.info':
      return { ok: true, channel: { id: 'C1', name: 'deals' } };
    case 'conversations.list':
      return { ok: true, channels: [{ id: 'C1', name: 'deals' }], response_metadata: { next_cursor: '' } };
    case 'users.info': {
      const user = query.get('user') ?? '';
      const email = SENDERS[user];
      return email === undefined ? { ok: false, error: 'user_not_found' } : { ok: true, user: { id: user, profile: { email } } };
    }
    default:
      return { ok: false, error: `unknown_method ${method}` };
  }
}

const SLACK_015 =
  'import { slack } from adapters\nimport { deals } from credentials\nchat = connect slack using deals\n' +
  'function intake(m: <chat-[:Message]->>) {\n  who = @user_email\n  return who\n}\n' +
  'listen to chat-[:Channels]->-[m:Messages WHERE m.Message != ""]-> fire intake\n';

let slack: Server;
let teamId: TeamId;
let credentialsId: ExternalServiceCredentialsId;
let listen016: TriggerId;
let listen015: TriggerId;

function envelope(input: { user: string; text: string; ts: string }) {
  return {
    type: 'event_callback',
    team_id: SLACK_TEAM,
    event_id: `Ev${input.ts}`,
    event: { type: 'message', channel: 'C1', user: input.user, text: input.text, ts: input.ts },
  };
}

/** This release's Slack module, as far as this test needs it: the message as
 *  one arrival on `Messages`. */
function current016Module(): void {
  mockResolve.mockImplementation(async () => ({
    adapterType: 'slack',
    preprocessInbound: async ({ raw }: { raw: { event: { text: string; ts: string } } }) => {
      const arrival: Arrival = { edge: 'Messages', identity: raw.event.ts, landing: { recordId: raw.event.ts, recordType: 'Thing', fields: { Message: raw.event.text } } };
      return { arrivals: [arrival] };
    },
  }));
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
  registerReadDeliveryWork();
  registerDispatchWork();
  registerCarriedRunWork();
  setWorkNotifier({ notify() {} });
  current016Module();

  teamId = randomUUID() as TeamId;
  mockSlack.teamId = teamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `two-versions-${teamId.slice(0, 8)}` }).execute();
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

  // The 0.16 automation: a saved listen on Slack's Messages, firing for "go" only.
  const current = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: current, team_id: teamId, name: 'current', source: '', language_version: LANGUAGE_VERSION }).execute();
  listen016 = await insertTestListen({ teamId, movementId: current, adapterType: 'slack', edge: 'Messages', delivery: 'connection', credentialsId, movement: 'heard', taken: takenEquals('Message', 'go') });

  // The 0.15.3 automation: shipped, and its listen planned by 0.15's own check.
  const carried = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: carried, team_id: teamId, name: 'intake', source: SLACK_015, description: '', language_version: '0.15.3' }).execute();
  await mintMovementVersionIfChanged({ teamId, movementId: carried, source: SLACK_015, languageVersion: '0.15.3' });
  const lane = await versionOf('0.15.3')?.listenRows?.();
  if (lane === undefined) throw new Error('test: 0.15 carries no listen lane');
  const planned = await lane.planListens({
    source: SLACK_015,
    pin: '0.15.3',
    file: 'intake',
    team: { credentials: [{ id: credentialsId, name: 'deals', type: 'SLACK' }], files: [], connectOf: () => 'oauth', kgChangeWebhooks: false, mcpEnabled: false, whatsappNumber: null },
    connected: { teamId, modules: modulePlatform() },
  });
  if (!planned.ok || planned.listens.length !== 1 || planned.refused.length > 0) throw new Error(`test: 0.15 did not plan the listen: ${JSON.stringify(planned)}`);
  listen015 = randomUUID() as TriggerId;
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    .values({
      id: listen015,
      team_id: teamId,
      name: 'movement/intake/intake',
      kind: 'slack',
      config: JSON.stringify({ listen: planned.listens[0] }),
      movement_id: carried,
      fired_movement_name: 'intake',
      credentials_id: credentialsId,
    })
    .execute();
});

afterAll(async () => {
  setWorkNotifier(inProcessNotifier);
  resetWorkHandlersForTests();
  await new Promise<void>((resolve) => slack.close(() => resolve()));
  await cleanupTeam(teamId);
});

const workOf = (kind: string) => getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('kind', '=', kind).select(['key', 'payload']).execute();
const receiptsOf = (triggerId: TriggerId) =>
  getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('trigger_id', '=', triggerId).select(['status', 'failure_reason']).orderBy('created_at').execute();
const runsOf = (triggerId: TriggerId) =>
  getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('trigger_id', '=', triggerId).select(['status', 'failure_reason']).orderBy('started_at').execute();
const pinOfRun = async (triggerId: TriggerId) =>
  (
    await getAutomationsQb(['trigger_run', 'movement_version'])
      .selectFrom('trigger_run')
      .innerJoin('movement_version', 'movement_version.id', 'trigger_run.movement_version_id')
      .where('trigger_run.trigger_id', '=', triggerId)
      .select('movement_version.language_version as pin')
      .executeTakeFirstOrThrow()
  ).pin;
const firesFor = async () => (await workOf('fire_event')).map((row) => (row.payload as { triggerId?: string }).triggerId);
/** Each pass of the drain claims what is due; a row one pass queues (a judged
 *  receipt's dispatch, a run) is the next pass's. */
async function drainAll(): Promise<void> {
  for (let pass = 0; pass < 5; pass++) {
    const drained = await drainUntilIdle({ owner: 'two-versions', teamId });
    if (drained.claimed === 0) return;
  }
}
const clearFires = () => getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).where('kind', '=', 'fire_event').execute();

describe('one Slack delivery read by the version each listen is pinned to (real Postgres)', () => {
  it("the current door judges only the 0.16 row: the 0.15 row is no listen of this release's", async () => {
    expect((await savedListens({ teamId, adapterType: 'slack' })).map((listen) => listen.triggerId)).toEqual([listen016]);
  });

  it("an unregistered sender's message: 0.16's filter fires nothing, and 0.15's old gate suppresses its listen", async () => {
    await handleSlackEventsInbound(envelope({ user: 'U2', text: 'hello', ts: '1700000000.000100' }));
    // 0.16's judge read its own filter: "hello" is not "go".
    expect(await firesFor()).toEqual([]);
    // The 0.15 row got a reading of its own, under 0.15.
    expect((await workOf('read_delivery')).map((row) => (row.payload as { version: string }).version)).toEqual(['0.15']);

    await drainAll();

    expect(await receiptsOf(listen015)).toEqual([{ status: 'suppressed', failure_reason: expect.stringMatching(/does not resolve to a registered team user/) }]);
    expect(await runsOf(listen015)).toEqual([]);
    expect(await receiptsOf(listen016)).toEqual([]);
  });

  it("a team member's message: 0.16's listen fires through its own door, and the 0.15 automation runs on 0.15's engine", async () => {
    await handleSlackEventsInbound(envelope({ user: 'U1', text: 'go', ts: '1700000000.000200' }));
    // The current door queued the 0.16 run, and nothing for the 0.15 row.
    expect(await firesFor()).toEqual([listen016]);
    await clearFires();

    await drainAll();

    const receipts = await receiptsOf(listen015);
    expect(receipts.at(-1)).toEqual(expect.objectContaining({ status: 'dispatched' }));
    const runs = await runsOf(listen015);
    expect(runs).toEqual([expect.objectContaining({ status: 'success', failure_reason: null })]);
    // It ran the version 0.15.3 shipped: `@user_email` is 0.15's spelling,
    // which only 0.15's engine runs, answered as the registered sender.
    expect(await pinOfRun(listen015)).toBe('0.15.3');
    // No 0.16 receipt came of the 0.15 reading.
    expect(await receiptsOf(listen016)).toEqual([]);
  });
});
