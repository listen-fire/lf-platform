// What a person is told of an event, for a 0.15.3 automation beside a 0.16 one
// on the same Slack connection (real Postgres, the real door, save and drains).
// A stranger's message and a team member's message each come in once. Then:
// the member's run is listed as fired by the delivery that started it; the
// automation's arrivals show the run and the stranger's message the old gate
// stopped, with its reason; "why didn't this fire?" answers for the 0.15
// listen with 0.15's own judge and gate, beside 0.16's answer for its own; and
// "run with this event" and replay run the 0.15 automation on its own pin, the
// old gate still deciding. A rehearsing 0.15 listen is not gated, in dispatch
// or in the explanation; an event 0.15 reads otherwise than the delivery was
// kept with is refused for 0.15, never guessed at; and a receipt from before
// this release, its delivery filled by the migration, still counts as run.
//
// The one network seam is Slack's Web API, a local stand-in 0.15's module
// reaches as the test-harness team's fake. This release's module is stood in
// for by its arrivals, as the door tests do.

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

const mockSlack = { baseUrl: '', teamId: '' };
jest.mock('../../../lib/recording', () => ({
  ...jest.requireActual('../../../lib/recording'),
  isTestHarnessTeam: (teamId: string) => teamId === mockSlack.teamId,
  injectFakeBaseUrl: (creds: Record<string, unknown>, service: string) => (service === 'SLACK' ? { ...creds, baseUrl: mockSlack.baseUrl } : creds),
}));
jest.mock('../../translation_graph/adapters/resolve', () => ({
  ...jest.requireActual('../../translation_graph/adapters/resolve'),
  // This release's Slack module, as far as this test needs it: the message as
  // one arrival on `Messages`.
  resolveAdapter: async () => ({
    adapterType: 'slack',
    // A message saying "twice" reads, here, as two events: what this release
    // keeps of the delivery is then not what 0.15's module reads from it.
    preprocessInbound: async ({ raw }: { raw: { event: { text: string; ts: string } } }) => ({
      arrivals: (raw.event.text === 'twice' ? [raw.event.ts, `${raw.event.ts}:again`] : [raw.event.ts]).map((identity) => ({
        edge: 'Messages',
        identity,
        landing: { recordId: identity, recordType: 'Thing', fields: { Message: raw.event.text } },
      })),
    }),
  }),
}));
jest.mock('../../credentials/credential_lifecycle', () => ({ credentialLifecycle: () => undefined }));

import type { AddressInfo } from 'node:net';

import express from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { LANGUAGE_VERSION } from 'movement-lang';
import { runWithPrincipal } from 'principal';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerEventId } from '../../../generated/kysely/automations/TriggerEvent';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { encryptToken } from '../../../lib/credentials';
import { teamIdSchema } from '../../../lib/team_id';
import { triggerIdSchema } from '../../../lib/trigger_id';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen, takenEquals } from '../../../test/harness/listens';
import { listArrivalsHandler } from '../../../interfaces/rest/v1/knowledge_agent_tools';
import { setStatement } from '../../access/decide';
import { userPrincipal } from '../../principal';
import { ProvisioningService } from '../../provisioning';
import { SLACK_APP_ID } from '../../credentials/app_id';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { registerCarriedRunWork } from '../../translation_graph/movement/carried_run_now';
import { saveMovement } from '../../translation_graph/movement/provision';
import { runWithEvent } from '../../translation_graph/movement/run_now';
import { registerDispatchWork } from '../../translation_graph/triggers/dispatch_event';
import { handleSlackEventsInbound } from '../../webhook_sync/slack_events';
import { registerReadDeliveryWork } from '../carried_delivery';
import { recentDeliveriesOf } from '../connection_deliveries';
import { explainDeliveryArrival } from '../explain_arrival';
import { movementEventsImpl } from '../arrival_ledger';
import { replayThroughListen } from '../listen_replay';

const SLACK_TEAM = 'T015P';

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

/** 0.15's spelling: `@user_email` is read only by 0.15's engine. */
const SLACK_015 =
  'import { slack } from adapters\nimport { deals } from credentials\nchat = connect slack using deals\n' +
  'function intake(m: <chat-[:Message]->>) {\n  who = @user_email\n  return who\n}\n' +
  'listen to chat-[:Channels]->-[m:Messages WHERE m.Message != ""]-> fire intake\n';

/** A listen on a connection made with `{ dryRun: true }`: its runs rehearse. */
const SLACK_015_DRY =
  'import { slack } from adapters\nimport { deals } from credentials\nchat = connect slack using deals { dryRun: true }\n' +
  'function rehearse(m: <chat-[:Message]->>) {\n  chat-[ch:Channels]-> {\n    write ch-[:Messages]-> { Message: "seen" }\n  }\n}\n' +
  'listen to chat-[:Channels]->-[m:Messages WHERE m.Message == "rehearse"]-> fire rehearse\n';

const movementIdOf = z.custom<MovementId>((value) => z.guid().safeParse(value).success);
const credentialsIdOf = z.custom<ExternalServiceCredentialsId>((value) => z.guid().safeParse(value).success);
const receiptIdOf = z.custom<TriggerEventId>((value) => z.guid().safeParse(value).success);
const arrivalsSchema = z.object({ arrivals: z.array(z.record(z.string(), z.unknown())) });
/** The migration that names a receipt's delivery, whose backfill is run again here as written. */
const BACKFILL = resolvePath(__dirname, '../../../db/migrations/20261116_100000_receipt-delivery.sql');

let slack: Server;
let rest: Server;
let restUrl = '';
let teamId: TeamId;
let admin: UserId;
let credentialsId: ExternalServiceCredentialsId;
let current: MovementId;
let carried: MovementId;
let listen016: TriggerId;
let listen015: TriggerId;
let fromStranger: string;
let fromMember: string;

const asAdmin = () => userPrincipal({ userId: admin, teamId, access: 'admin' });

function envelope(input: { user: string; text: string; ts: string }) {
  return {
    type: 'event_callback',
    team_id: SLACK_TEAM,
    event_id: `Ev${input.ts}`,
    event: { type: 'message', channel: 'C1', user: input.user, text: input.text, ts: input.ts },
  };
}

/** Each pass of the drain claims what is due; a row one pass queues (a
 *  reading's dispatch, a run) is the next pass's. */
async function drainAll(): Promise<void> {
  for (let pass = 0; pass < 5; pass++) {
    const drained = await drainUntilIdle({ owner: 'carried-pages', teamId });
    if (drained.claimed === 0) return;
  }
}

/** The delivery the door kept for a message, newest first. */
async function latestDelivery(): Promise<string> {
  const row = await getAutomationsQb(['delivery'])
    .selectFrom('delivery')
    .where('team_id', '=', teamId)
    .where('replay_of', 'is', null)
    .orderBy('received_at', 'desc')
    .select('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** One message in through the real door, read and dispatched; answers the delivery it was kept as. */
async function message(input: { user: string; text: string; ts: string }): Promise<string> {
  await handleSlackEventsInbound(envelope(input));
  await drainAll();
  return latestDelivery();
}

const runsOf = (triggerId: TriggerId) =>
  getAutomationsQb(['trigger_run', 'movement_version'])
    .selectFrom('trigger_run')
    .innerJoin('movement_version', 'movement_version.id', 'trigger_run.movement_version_id')
    .where('trigger_run.trigger_id', '=', triggerId)
    .select(['trigger_run.id as id', 'trigger_run.status as status', 'trigger_run.failure_reason as failure', 'trigger_run.delivery_id as deliveryId', 'movement_version.language_version as pin'])
    .orderBy('trigger_run.started_at')
    .execute();

const receiptCount = async () =>
  (await getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('team_id', '=', teamId).select('id').execute()).length;

/** REST `arrivals` for an automation, as its route answers it over HTTP. */
async function restArrivals(idOrName: string): Promise<Array<Record<string, unknown>>> {
  const answered = await fetch(`${restUrl}/automations/${idOrName}/arrivals`);
  expect(answered.status).toBe(200);
  return arrivalsSchema.parse(await answered.json()).arrivals;
}

/** The one listen a save shipped. */
function onlyListen(saved: Awaited<ReturnType<typeof saveMovement>>): TriggerId {
  if (!saved.ok) throw new Error(`test: the automation did not save: ${JSON.stringify(saved)}`);
  const [first] = saved.listeners;
  if (first === undefined) throw new Error('test: the save shipped no listen');
  return triggerIdSchema.parse(first.triggerId);
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

  const app = express();
  app.get('/automations/:idOrName/arrivals', (req, res, next) =>
    runWithPrincipal(asAdmin(), async () => {
      await listArrivalsHandler(req, res, next);
    }),
  );
  rest = createServer(app);
  await new Promise<void>((resolve) => rest.listen(0, '127.0.0.1', resolve));
  const { port } = z.custom<AddressInfo>((value) => typeof value === 'object' && value !== null && 'port' in value).parse(rest.address());
  restUrl = `http://127.0.0.1:${port}`;

  resetWorkHandlersForTests();
  registerReadDeliveryWork();
  registerDispatchWork();
  registerCarriedRunWork();
  setWorkNotifier({ notify() {} });

  teamId = teamIdSchema.parse(randomUUID());
  mockSlack.teamId = teamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `carried-pages-${teamId.slice(0, 8)}` }).execute();
  admin = (await ProvisioningService.provisionUser({ teamId, email: 'ada@example.com', access: 'admin' })).userId;
  credentialsId = credentialsIdOf.parse(randomUUID());
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

  // The 0.16 automation: a listen on Slack's Messages, firing for "go" only.
  current = movementIdOf.parse(randomUUID());
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: current, team_id: teamId, name: 'current', source: '', language_version: LANGUAGE_VERSION }).execute();
  listen016 = await insertTestListen({ teamId, movementId: current, adapterType: 'slack', edge: 'Messages', delivery: 'connection', credentialsId, movement: 'heard', taken: takenEquals('Message', 'go') });

  // The 0.15.3 automation, planned and shipped by its save under 0.15.
  carried = movementIdOf.parse(randomUUID());
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: carried, team_id: teamId, name: 'intake', source: SLACK_015, description: '', language_version: '0.15.3' }).execute();
  listen015 = onlyListen(await saveMovement({ audience: { for: 'run' }, teamId, id: carried, source: SLACK_015 }));

  await runWithPrincipal(asAdmin(), async () => {
    await setStatement(asAdmin(), { target: { thing: 'connection', id: credentialsId }, verb: 'use', grantees: [{ kind: 'user', userId: admin }] });
    for (const id of [current, carried]) {
      await setStatement(asAdmin(), { target: { thing: 'automation', id }, verb: 'read', grantees: [{ kind: 'team' }] });
      await setStatement(asAdmin(), { target: { thing: 'automation', id }, verb: 'write', grantees: [{ kind: 'team' }] });
    }
  });

  fromStranger = await message({ user: 'U2', text: 'hello', ts: '1700000300.000100' });
  fromMember = await message({ user: 'U1', text: 'hello', ts: '1700000300.000200' });
});

afterAll(async () => {
  setWorkNotifier(inProcessNotifier);
  resetWorkHandlersForTests();
  await new Promise<void>((resolve) => slack.close(() => resolve()));
  await new Promise<void>((resolve) => rest.close(() => resolve()));
  await cleanupTeam(teamId);
});

describe('what a person is told of an event, for a 0.15.3 automation beside a 0.16 one (real Postgres)', () => {
  it("the member's 0.15 run records the delivery that started it, and the connection lists it as fired by that delivery", async () => {
    const runs = await runsOf(listen015);
    expect(runs).toEqual([expect.objectContaining({ status: 'success', pin: '0.15.3', deliveryId: fromMember })]);

    const listed = await runWithPrincipal(asAdmin(), () => recentDeliveriesOf({ teamId, connectionId: credentialsId }));
    expect(listed.map((delivery) => delivery.deliveryId)).toEqual([fromMember, fromStranger]);
    const [member, stranger] = listed;
    expect(member?.fired).toEqual([{ automationId: carried, automationName: 'intake', listen: listen015 }]);
    expect(stranger?.fired).toEqual([]);
    // Both automations are offered to run with either event.
    expect(stranger?.runnable).toEqual([
      { automationId: current, automationName: 'current' },
      { automationId: carried, automationName: 'intake' },
    ]);
  });

  it("the automation's arrivals show its run and the stranger's message the old gate stopped, with its reason, on its page and in REST", async () => {
    const events = await movementEventsImpl({ teamId, movementId: carried });
    expect(events).toEqual([
      expect.objectContaining({ status: 'ran', triggerId: listen015, deliveryId: fromMember, arrivalIndex: 0, failureReason: null }),
      expect.objectContaining({ status: 'does_not_fire', triggerId: listen015, deliveryId: fromStranger, arrivalIndex: 0, failureReason: expect.stringMatching(/registered team user/) }),
    ]);

    const arrivals = await restArrivals(carried);
    expect(arrivals).toEqual([
      expect.objectContaining({ listen: listen015, deliveryId: fromMember, arrivalIndex: 0, status: 'ran', runId: events[0]?.id }),
      expect.objectContaining({ listen: listen015, deliveryId: fromStranger, arrivalIndex: 0, status: 'does_not_fire', reason: expect.stringMatching(/registered team user/) }),
    ]);
    // An event that ran nothing names no run.
    expect(arrivals[1]).not.toHaveProperty('runId');
  });

  it("why didn't this fire: the 0.15 listen is answered by 0.15's judge and old gate, the 0.16 one by its own, and nothing is written", async () => {
    const receipts = await receiptCount();
    const why = (deliveryId: string) => runWithPrincipal(asAdmin(), () => explainDeliveryArrival({ teamId, deliveryId, arrivalIndex: 0 }));

    const stranger = await why(fromStranger);
    if (!stranger.ok) throw new Error(stranger.errors.join('; '));
    const strangerBy = Object.fromEntries(stranger.listens.map((entry) => [entry.listen, entry]));
    expect(stranger.edge).toBe('Messages');
    // 0.16's own filter: "hello" is not "go".
    expect(strangerBy[listen016]).toMatchObject({ automationId: current, verdict: 'does_not_fire', firstFailed: expect.stringContaining('go') });
    // 0.15's judge passes its filter, and its old gate stops the stranger, as dispatch did.
    expect(strangerBy[listen015]).toMatchObject({
      automationId: carried,
      automationName: 'intake',
      verdict: 'does_not_fire',
      reason: expect.stringMatching(/does not resolve to a registered team user/),
      hostAnswers: { used: true },
    });
    expect(strangerBy[listen015]).not.toHaveProperty('firstFailed');

    const member = await why(fromMember);
    if (!member.ok) throw new Error(member.errors.join('; '));
    expect(member.listens.find((entry) => entry.listen === listen015)).toMatchObject({ verdict: 'fires', hostAnswers: { used: true } });

    expect(await receiptCount()).toBe(receipts);
  });

  it('run with this event: the 0.15 automation runs on its own pin, and the old gate still stops the stranger', async () => {
    const run = (deliveryId: string) =>
      runWithPrincipal(asAdmin(), () => runWithEvent({ teamId, automationId: carried, deliveryId, arrivalIndex: 0, by: { userId: admin } }));

    const member = await run(fromMember);
    if (!member.ok) throw new Error(member.errors.join('; '));
    expect(member).toEqual({ ok: true, runIds: [expect.any(String)], movementName: 'intake' });
    const stranger = await run(fromStranger);
    if (!stranger.ok) throw new Error(stranger.errors.join('; '));
    await drainAll();

    const runs = await runsOf(listen015);
    const memberRun = runs.find((candidate) => candidate.id === member.runIds[0]);
    const strangerRun = runs.find((candidate) => candidate.id === stranger.runIds[0]);
    // The member's event ran again, under a receipt of its own, on 0.15.3.
    expect(memberRun).toEqual(expect.objectContaining({ status: 'success', pin: '0.15.3', failure: null }));
    expect(strangerRun).toEqual(expect.objectContaining({ status: 'failed', pin: '0.15.3', failure: expect.stringMatching(/does not resolve to a registered team user/) }));

    // Each run is a delivery of its own, a replay of the one stored: listed
    // under the automation's arrivals by the stored one, not on the connection.
    const replays = await getAutomationsQb(['delivery']).selectFrom('delivery').where('team_id', '=', teamId).where('replay_of', 'is not', null).select(['id', 'replay_of']).execute();
    expect(replays.map((replay) => replay.replay_of).sort()).toEqual([fromMember, fromStranger].sort());
    expect(replays.map((replay) => replay.id).sort()).toEqual([memberRun?.deliveryId, strangerRun?.deliveryId].sort());
    const listed = await runWithPrincipal(asAdmin(), () => recentDeliveriesOf({ teamId, connectionId: credentialsId }));
    expect(listed.map((delivery) => delivery.deliveryId)).toEqual([fromMember, fromStranger]);
    const events = await movementEventsImpl({ teamId, movementId: carried });
    expect(events.filter((event) => event.id === memberRun?.id || event.id === strangerRun?.id).map((event) => event.deliveryId).sort()).toEqual([fromMember, fromStranger].sort());
  });
  it('a rehearsing 0.15 listen is not gated: dispatch rehearses the stranger\'s message, and "why didn\'t this fire?" says it fires', async () => {
    const rehearsal = movementIdOf.parse(randomUUID());
    await getAutomationsQb(['movement']).insertInto('movement').values({ id: rehearsal, team_id: teamId, name: 'rehearsal', source: SLACK_015_DRY, description: '', language_version: '0.15.3' }).execute();
    const listenDry = onlyListen(await saveMovement({ audience: { for: 'run' }, teamId, id: rehearsal, source: SLACK_015_DRY }));
    await runWithPrincipal(asAdmin(), () => setStatement(asAdmin(), { target: { thing: 'automation', id: rehearsal }, verb: 'read', grantees: [{ kind: 'team' }] }));

    const delivery = await message({ user: 'U2', text: 'rehearse', ts: '1700000300.000300' });

    // Dispatch: the stranger's message rehearses the dry-run listen and is stopped for the live one.
    expect(await runsOf(listenDry)).toEqual([expect.objectContaining({ status: 'success', pin: '0.15.3', deliveryId: delivery })]);
    const explained = await runWithPrincipal(asAdmin(), () => explainDeliveryArrival({ teamId, deliveryId: delivery, arrivalIndex: 0 }));
    if (!explained.ok) throw new Error(explained.errors.join('; '));
    expect(explained.listens.find((entry) => entry.listen === listenDry)).toMatchObject({ verdict: 'fires', hostAnswers: { used: false } });
    expect(explained.listens.find((entry) => entry.listen === listen015)).toMatchObject({ verdict: 'does_not_fire', reason: expect.stringMatching(/registered team user/) });
  });

  it('an event 0.15 reads otherwise than the delivery was kept with: 0.15 cannot tell which it is, and 0.16\'s answer stands', async () => {
    // This release keeps two events of the message; 0.15's module reads one.
    const delivery = await message({ user: 'U1', text: 'twice', ts: '1700000300.000400' });

    const explained = await runWithPrincipal(asAdmin(), () => explainDeliveryArrival({ teamId, deliveryId: delivery, arrivalIndex: 0 }));
    if (!explained.ok) throw new Error(explained.errors.join('; '));
    expect(explained.listens.find((entry) => entry.listen === listen016)).toMatchObject({ verdict: 'does_not_fire', firstFailed: expect.stringContaining('go') });
    expect(explained.listens.find((entry) => entry.listen === listen015)).toMatchObject({ verdict: 'cannot_tell', reason: expect.stringContaining('kept with 2 events') });

    const run = await runWithPrincipal(asAdmin(), () => runWithEvent({ teamId, automationId: carried, deliveryId: delivery, arrivalIndex: 1, by: { userId: admin } }));
    expect(run).toEqual({ ok: false, errors: [expect.stringContaining('kept with 2 events')] });
  });

  it("replay through the 0.15 listen runs on its pin through 0.15's own reading, and the old gate still decides", async () => {
    const replay = (deliveryId: string, force?: boolean) =>
      replayThroughListen({ teamId, triggerId: listen015, deliveryId, ...(force !== undefined ? { force } : {}) });

    // The stranger's message ran nothing: replaying it runs it, and the old gate stops it again.
    const stranger = await replay(fromStranger);
    if (stranger.outcome !== 'replayed') throw new Error(stranger.reason);
    expect(stranger.runIds).toHaveLength(1);
    // The member's message ran before: unforced, nothing runs; forced, it runs again.
    const unforced = await replay(fromMember);
    expect(unforced).toEqual(expect.objectContaining({ outcome: 'replayed', runIds: [], lines: [expect.stringContaining('before: nothing replayed')] }));
    const forced = await replay(fromMember, true);
    if (forced.outcome !== 'replayed') throw new Error(forced.reason);
    expect(forced.runIds).toHaveLength(1);
    await drainAll();

    const runs = await runsOf(listen015);
    expect(runs.find((candidate) => candidate.id === stranger.runIds[0])).toEqual(
      expect.objectContaining({ status: 'failed', pin: '0.15.3', failure: expect.stringMatching(/does not resolve to a registered team user/) }),
    );
    expect(runs.find((candidate) => candidate.id === forced.runIds[0])).toEqual(expect.objectContaining({ status: 'success', pin: '0.15.3', failure: null, deliveryId: forced.replayDeliveryId }));
  });

  it("an unforced replay of a delivery whose receipt predates this release runs nothing again, once the migration's backfill named its delivery", async () => {
    const delivery = await message({ user: 'U1', text: 'hello again', ts: '1700000300.000500' });
    const receipt = await getAutomationsQb(['trigger_event', 'trigger_run'])
      .selectFrom('trigger_event')
      .innerJoin('trigger_run', 'trigger_run.trigger_event_id', 'trigger_event.id')
      .where('trigger_event.trigger_id', '=', listen015)
      .where('trigger_event.delivery_id', '=', delivery)
      .select('trigger_event.id as id')
      .executeTakeFirstOrThrow();
    // A receipt as one written before this release: no delivery named.
    await getAutomationsQb(['trigger_event']).updateTable('trigger_event').set({ delivery_id: null }).where('id', '=', receipt.id).execute();
    // A key the platform built for a run of its own names no delivery: it must stay unfilled.
    const { rows: own } = await sql<{ id: string }>`
      insert into automations.trigger_event (team_id, trigger_id, adapter_type, trigger_type, payload, external_event_id)
      values (${teamId}::uuid, ${listen015}::text, 'slack', 'arrival', '{}'::jsonb, ${`own:${randomUUID()}`}::text) returning id::text as id`.execute(getAutomationsQb(['trigger_event']));

    await sql.raw(await readFile(BACKFILL, 'utf8')).execute(getAutomationsQb(['trigger_event']));

    const deliveryOf = async (id: string) =>
      (await getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('id', '=', receiptIdOf.parse(id)).select('delivery_id').executeTakeFirstOrThrow()).delivery_id;
    expect(await deliveryOf(receipt.id)).toBe(delivery);
    expect(await deliveryOf(own[0]?.id ?? '')).toBeNull();

    const runsBefore = (await runsOf(listen015)).length;
    const replayed = await replayThroughListen({ teamId, triggerId: listen015, deliveryId: delivery });
    expect(replayed).toEqual(expect.objectContaining({ outcome: 'replayed', runIds: [], replayDeliveryId: null, lines: [expect.stringContaining('before: nothing replayed')] }));
    await drainAll();
    expect(await runsOf(listen015)).toHaveLength(runsBefore);
  });
});
