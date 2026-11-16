// One Slack delivery, two versions (real Postgres, the real door, save and
// drains): a team has a 0.16 automation and a 0.15.3 automation listening to
// the same Slack connection. A save of the 0.15.3 automation plans its listen
// with 0.15's own planner and ships it as a 0.15 row. The row's pin chooses who
// reads it. The current door judges only the 0.16 row, with this release's
// judge and its filter; the 0.15 row is read again by 0.15's own Slack module,
// judged by 0.15's judge, and gated by the old ownership gate, which asks
// 0.15's module who sent the message. An unregistered sender is suppressed
// there; a team member's message runs the 0.15 automation on 0.15's engine. An
// edit re-plans the row under 0.15; an upgrade re-plans it as 0.16's, and the
// old gate no longer reads it.
//
// The one network seam is Slack's Web API, a local stand-in both releases'
// modules reach as the test-harness team's fake. This release's module is
// stood in for by its arrivals, as the door tests do: this test is about who
// judges which row, and the 0.16 judge runs for real over them. The upgrade's
// check reads this release's real Slack module, against the same stand-in.

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
import { versionOf, type ListeningLane } from '@listen-fire/language-versions';

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
import { registerCarriedRunWork } from '../../translation_graph/movement/carried_run_now';
import { upgradeMovement } from '../../translation_graph/movement/language_upgrade';
import { saveMovement } from '../../translation_graph/movement/provision';
import { registerDispatchWork } from '../../translation_graph/triggers/dispatch_event';
import { handleSlackEventsInbound } from '../../webhook_sync/slack_events';
import { readDeliveryHandler, registerReadDeliveryWork } from '../carried_delivery';
import { listenConfigSchema, savedListens } from '../listen_door';
import { registerListenResolveWork } from '../listen_resolve';

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

/** The edit: the listen now fires for "deploy" only. */
const SLACK_015_EDITED =
  'import { slack } from adapters\nimport { deals } from credentials\nchat = connect slack using deals\n' +
  'function intake(m: <chat-[:Message]->>) {\n  said = m.Message\n  return said\n}\n' +
  'listen to chat-[:Channels]->-[m:Messages WHERE m.Message == "deploy"]-> fire intake\n';

/** Two listens on one connection, each firing its own function. */
const SLACK_015_TWO =
  'import { slack } from adapters\nimport { deals } from credentials\nchat = connect slack using deals\n' +
  'function one(m: <chat-[:Message]->>) {\n  said = m.Message\n  return said\n}\n' +
  'function two(m: <chat-[:Message]->>) {\n  said = m.Message\n  return said\n}\n' +
  'listen to chat-[:Channels]->-[m:Messages WHERE m.Message == "one"]-> fire one\n' +
  'listen to chat-[:Channels]->-[m:Messages WHERE m.Message == "two"]-> fire two\n';

/** A listen on a connection made with `{ dryRun: true }`. */
const SLACK_015_DRY =
  'import { slack } from adapters\nimport { deals } from credentials\nchat = connect slack using deals { dryRun: true }\n' +
  'function rehearse(m: <chat-[:Message]->>) {\n  chat-[ch:Channels]-> {\n    write ch-[:Messages]-> { Message: "seen" }\n  }\n}\n' +
  'listen to chat-[:Channels]->-[m:Messages WHERE m.Message == "rehearse"]-> fire rehearse\n';

let slack: Server;
let teamId: TeamId;
let credentialsId: ExternalServiceCredentialsId;
let listen016: TriggerId;
let listen015: TriggerId;
let carried: MovementId;
let lane: ListeningLane;

function envelope(input: { user: string; text: string; ts: string }) {
  return {
    type: 'event_callback',
    team_id: SLACK_TEAM,
    event_id: `Ev${input.ts}`,
    event: { type: 'message', channel: 'C1', user: input.user, text: input.text, ts: input.ts },
  };
}

/** This release's real Slack module, which the upgrade's check reads. */
function current016RealModule(): void {
  const actual: typeof import('../../translation_graph/adapters/resolve') = jest.requireActual('../../translation_graph/adapters/resolve');
  mockResolve.mockImplementation(actual.resolveAdapter);
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

  // The 0.15.3 automation, written then and never shipped: its listen is
  // planned by the save below.
  carried = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: carried, team_id: teamId, name: 'intake', source: SLACK_015, description: '', language_version: '0.15.3' }).execute();
  const listening = await versionOf('0.15.3')?.listenRows?.();
  if (listening === undefined) throw new Error('test: 0.15 carries no listen lane');
  lane = listening;
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
const rowsOf = (movementId: MovementId) =>
  getAutomationsQb(['trigger']).selectFrom('trigger').where('movement_id', '=', movementId).select(['id', 'config', 'run_mode', 'credentials_id']).execute();
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
const save = (source: string) => saveMovement({ audience: { for: 'run' }, teamId, id: carried, source });

describe('one Slack delivery read by the version each listen is pinned to (real Postgres)', () => {
  it("a fresh save of the 0.15.3 automation ships its listen as 0.15's row, which the current door skips", async () => {
    const saved = await save(SLACK_015);
    expect(saved).toEqual(expect.objectContaining({ ok: true, warnings: [], listeners: [expect.objectContaining({ kind: 'slack', movementName: 'intake', credentialsId, runMode: 'live', reused: false })] }));
    if (!saved.ok) return;
    listen015 = saved.listeners[0]!.triggerId as TriggerId;
    const rows = await rowsOf(carried);
    expect(rows).toEqual([expect.objectContaining({ id: listen015, run_mode: 'live', credentials_id: credentialsId })]);
    // The row is 0.15's own plan, which only 0.15's reader claims.
    expect(lane.isListenRow({ config: rows[0]!.config })).toBe(true);
    expect((await savedListens({ teamId, adapterType: 'slack' })).map((listen) => listen.triggerId)).toEqual([listen016]);
    // The pin is 0.15.3 still: a save never moves it.
    expect((await getAutomationsQb(['movement']).selectFrom('movement').where('id', '=', carried).select('language_version').executeTakeFirstOrThrow()).language_version).toBe('0.15.3');
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

  it('an edit re-plans the 0.15 row in place, and 0.15 judges the edited filter', async () => {
    const before = (await rowsOf(carried))[0]!.config;
    const saved = await save(SLACK_015_EDITED);
    expect(saved).toEqual(expect.objectContaining({ ok: true, listeners: [expect.objectContaining({ triggerId: listen015, reused: true })] }));
    const rows = await rowsOf(carried);
    expect(rows.map((row) => row.id)).toEqual([listen015]);
    expect(rows[0]!.config).not.toEqual(before);
    expect(lane.isListenRow({ config: rows[0]!.config })).toBe(true);

    // "go" passed the old filter; the edited one fires for "deploy" only.
    await handleSlackEventsInbound(envelope({ user: 'U1', text: 'go', ts: '1700000000.000300' }));
    await clearFires();
    await drainAll();
    expect(await runsOf(listen015)).toHaveLength(1);

    await handleSlackEventsInbound(envelope({ user: 'U1', text: 'deploy', ts: '1700000000.000400' }));
    await clearFires();
    await drainAll();
    const runs = await runsOf(listen015);
    expect(runs).toHaveLength(2);
    expect(runs.at(-1)).toEqual(expect.objectContaining({ status: 'success', failure_reason: null }));
  });

  it("an upgrade to this release re-plans the row as 0.16's: the current door reads it, and 0.15's reader and gate no longer do", async () => {
    const before = (await rowsOf(carried))[0]!.config;
    current016RealModule();
    const upgraded = await upgradeMovement({ teamId, id: carried, acknowledge: true, applyAllFixes: true });
    current016Module();
    expect(upgraded).toEqual(expect.objectContaining({ status: 'upgraded' }));
    expect((await getAutomationsQb(['movement']).selectFrom('movement').where('id', '=', carried).select('language_version').executeTakeFirstOrThrow()).language_version).toBe(LANGUAGE_VERSION);

    const rows = await rowsOf(carried);
    // The row keeps its id (and its history), its plan now this release's.
    expect(rows.map((row) => row.id)).toEqual([listen015]);
    expect(rows[0]!.config).not.toEqual(before);
    expect(listenConfigSchema.safeParse(rows[0]!.config).success).toBe(true);
    expect((await savedListens({ teamId, adapterType: 'slack' })).map((listen) => listen.triggerId).sort()).toEqual([listen016, listen015].sort());

    // A delivery now queues no reading under 0.15: nothing pinned to it listens.
    const readingsBefore = (await workOf('read_delivery')).length;
    await handleSlackEventsInbound(envelope({ user: 'U2', text: 'deploy', ts: '1700000000.000500' }));
    expect(await workOf('read_delivery')).toHaveLength(readingsBefore);
  });

  it('a file with two listens on one connection upgrades to this release keeping both trigger ids', async () => {
    const two = randomUUID() as MovementId;
    await getAutomationsQb(['movement']).insertInto('movement').values({ id: two, team_id: teamId, name: 'pair', source: SLACK_015_TWO, description: '', language_version: '0.15.3' }).execute();
    const saved = await saveMovement({ audience: { for: 'run' }, teamId, id: two, source: SLACK_015_TWO });
    expect(saved).toEqual(expect.objectContaining({ ok: true, listeners: [expect.objectContaining({ movementName: 'one' }), expect.objectContaining({ movementName: 'two' })] }));
    const before = (await rowsOf(two)).map((row) => row.id).sort();
    expect(before).toHaveLength(2);
    expect((await rowsOf(two)).every((row) => lane.isListenRow({ config: row.config }))).toBe(true);

    current016RealModule();
    const upgraded = await upgradeMovement({ teamId, id: two, acknowledge: true, applyAllFixes: true });
    current016Module();
    expect(upgraded).toEqual(expect.objectContaining({ status: 'upgraded' }));

    const after = await rowsOf(two);
    expect(after.map((row) => row.id).sort()).toEqual(before);
    expect(after.every((row) => listenConfigSchema.safeParse(row.config).success)).toBe(true);
  });

  it('a save of a 0.15 listen on a connection made with { dryRun: true } ships its row as dry_run', async () => {
    const dry = randomUUID() as MovementId;
    await getAutomationsQb(['movement']).insertInto('movement').values({ id: dry, team_id: teamId, name: 'rehearsal', source: SLACK_015_DRY, description: '', language_version: '0.15.3' }).execute();
    const saved = await saveMovement({ audience: { for: 'run' }, teamId, id: dry, source: SLACK_015_DRY });
    expect(saved).toEqual(expect.objectContaining({ ok: true, listeners: [expect.objectContaining({ movementName: 'rehearse', runMode: 'dry_run' })] }));
    expect((await rowsOf(dry)).map((row) => row.run_mode)).toEqual(['dry_run']);
  });

  it("a delivery 0.15's reading row reads on a listed hop's edge whose members' changes are pushed lists that 0.15 listen again", async () => {
    // A 0.15 listen whose first hop's members the host lists, and whose
    // members' changes arrive on that hop's own edge (`Messages`).
    const relister = randomUUID() as MovementId;
    await getAutomationsQb(['movement']).insertInto('movement').values({ id: relister, team_id: teamId, name: 'relister', source: SLACK_015, description: '', language_version: '0.15.3' }).execute();
    // Shipped, so the rows beside it are read as its version's.
    expect(await saveMovement({ audience: { for: 'run' }, teamId, id: relister, source: SLACK_015 })).toEqual(expect.objectContaining({ ok: true }));
    const id = randomUUID() as TriggerId;
    const listen = {
      pipeline: `listen:test:relist:${id.slice(0, 8)}`,
      plan: {
        movement: 'intake',
        connection: 'chat',
        adapter: 'slack',
        hops: [
          { edge: 'Messages', from: '', to: 'Message', judged: 'resolved' },
          { edge: 'Replies', from: 'Message', to: 'Message', judged: 'arrival' },
        ],
        carries: ['Messages'],
      },
      awaits: { own: [], carried: {} },
      fieldIds: {},
      delivery: { kind: 'connection' },
      resolvedHops: [{ hop: 0, membersChange: 'pushed' }],
    };
    expect(lane.watchOf({ config: { listen } })?.traversals).toEqual([expect.objectContaining({ pushedParentEdges: ['Messages'] })]);
    await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({ id, team_id: teamId, name: 'intake:Replies', kind: 'slack', config: JSON.stringify({ listen }), movement_id: relister, credentials_id: credentialsId })
      .execute();
    // Registered only here: no earlier case's drain runs a listing.
    registerListenResolveWork();
    const relists = async () => (await workOf('resolve_listen')).map((row) => row.key);
    expect(await relists()).toEqual([]);

    await handleSlackEventsInbound(envelope({ user: 'U2', text: 'nothing', ts: '1700000000.000600' }));
    const readings = await workOf('read_delivery');
    expect(readings.map((row) => (row.payload as { version: string }).version)).toEqual(['0.15']);
    // The reading row itself, as its drain runs it: 0.15's module reads the
    // kept delivery, and its arrival on `Messages` lists the listen again.
    for (const row of readings) await readDeliveryHandler.run(row.payload, { attempts: 1, now: new Date() } as never);
    expect(await relists()).toEqual([`resolve_listen:${listen.pipeline}`]);

    await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).where('kind', 'in', ['read_delivery', 'resolve_listen', 'dispatch_event']).execute();
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('movement_id', '=', relister).execute();
  });
});
