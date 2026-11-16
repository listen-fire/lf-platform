// A 0.15 listen fires on every way an event arrives (real Postgres, the real
// poll worker, subscription sync, judging and drains): the row's pin hands it
// to 0.15's own module and judge, and a 0.16 listen beside it is judged by 0.16
// alone.
//
//   - polls: a cron listen (`Ticks` is polled) and a Granola listen are polled
//     by 0.15's own cron unit and Granola module, under keys of 0.15's own, and
//     judged by 0.15's judge; the cron one runs on 0.15's engine;
//   - subscriptions: a 0.15 Attio listen's webhook is registered by 0.15's
//     Attio module, kept as it is on the next sync, and withdrawn by it when the
//     listen goes;
//   - the doors that build their own arrivals (an email, a WhatsApp message, an
//     ask's answer, a remote module's push): 0.15's judge judges the page the
//     door built, and the door's 0.16 listen is still judged by 0.16 alone.
//
// The one network seam is a local stand-in for Granola's and Attio's APIs,
// which 0.15's modules reach through each connection's stored base URL.

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

// The quarantine's notice to the team's support channel is not this test's.
jest.mock('../../../lib/slack', () => ({ ...jest.requireActual('../../../lib/slack'), sendSlackNotification: jest.fn(async () => undefined) }));

import { sql } from 'kysely';
import { LANGUAGE_VERSION } from 'movement-lang';
import { versionOf, type ListeningLane } from '@listen-fire/language-versions';
import { responseArrival } from '@listen-fire/ask';
import { whatsappInboundArrivals } from '@listen-fire/whatsapp/inbound';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { encryptToken } from '../../../lib/credentials';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { askIdSchema } from '../../asks/store';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen, takenEquals, testListenConfig } from '../../../test/harness/listens';
import { ProvisioningService } from '../../provisioning';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { enqueueWork, listWorkByKind, removeWork } from '../../work/store';
import { registerCarriedRunWork } from '../../translation_graph/movement/carried_run_now';
import { saveMovement } from '../../translation_graph/movement/provision';
import { MOVEMENT_LISTEN_PROVISIONER, edgeSubscriptionOf, listensOfSubscription, syncListenSubscriptions } from '../../translation_graph/movement/listen_subscriptions';
import { registerDispatchWork } from '../../translation_graph/triggers/dispatch_event';
import { inboundEmailArrival } from '../../translation_graph/adapters/email/arrival';
import { platformPushStore } from '../../webhook_sync/adapter_doors';
import { pollEdgeHandler, pollReconcileHandler, pollShared, pollSubscriptionId, pollWorkKey, sharedPolls } from '../../poll_source/worker';
import { runInContext } from '../../context/utils';
import { inboundEmailHandler } from '../../../interfaces/rest/private';
import { judgeCarriedPage, keepForEveryVersion } from '../carried_delivery';
import { carriedEdgeKeysOf, carriedListens } from '../carried_listens';
import { registerListenResolveWork } from '../listen_resolve';
import { deliverArrivals } from '../listen_door';

const CRON_015 =
  'import { cron } from adapters\nclock = connect cron\n' +
  'function tick(t: <clock-[:Tick]->>) {\n  at = t.`Fired at`\n  return at\n}\n' +
  'listen to clock-[t:Ticks WHERE t.Schedule == "* * * * *"]-> fire tick\n';

const GRANOLA_015 =
  'import { granola } from adapters\nimport { notes } from credentials\ng = connect granola using notes\n' +
  'function took(m: <g-[:`Meeting Note`]->>) {\n  said = m.Title\n  return said\n}\n' +
  'listen to g-[m:Meetings]-> fire took\n';

/** Granola's and Attio's APIs, as far as 0.15's modules ask them here. */
const stand: { notes: Array<Record<string, unknown>>; webhooks: string[]; removed: string[] } = { notes: [], webhooks: [], removed: [] };
let api: Server;
let baseUrl: string;

let teamId: TeamId;
let lane: ListeningLane;
let cronMovement: MovementId;
let currentMovement: MovementId;
let granolaCredential: ExternalServiceCredentialsId;
let attioCredential: ExternalServiceCredentialsId;

function answer(method: string, path: string): unknown {
  if (path.startsWith('/v1/notes/')) return stand.notes.find((note) => path.startsWith(`/v1/notes/${String(note['id'])}`));
  if (path.startsWith('/v1/notes')) return { notes: stand.notes, hasMore: false, cursor: null };
  if (path === '/v2/webhooks' && method === 'POST') {
    const id = `wh-${stand.webhooks.length + 1}`;
    stand.webhooks.push(id);
    return { data: { id: { workspace_id: 'ws', webhook_id: id }, status: 'active', secret: `secret-${id}` } };
  }
  if (path.startsWith('/v2/webhooks/') && method === 'DELETE') {
    stand.removed.push(path.slice('/v2/webhooks/'.length));
    return {};
  }
  return { error: `unknown ${method} ${path}` };
}

async function credential(input: { type: ExternalServiceType; name: string; fields: Record<string, string> }): Promise<ExternalServiceCredentialsId> {
  const id = randomUUID() as ExternalServiceCredentialsId;
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({ id, team_id: teamId, type: input.type, name: input.name, identifier: input.name, user_id: null, credentials: await encryptToken(JSON.stringify(input.fields), id) })
    .execute();
  return id;
}

type RowListen = Parameters<typeof testListenConfig>[0] & { credentialsId?: string | null; to?: string };

/** A listen as provisioning keeps one, landing on `to`. */
function configOf(input: RowListen, id: string) {
  const listen = testListenConfig(input, id);
  const to = input.to;
  return { listen: to === undefined ? listen : { ...listen, plan: { ...listen.plan, hops: listen.plan.hops.map((hop) => ({ ...hop, to })) } } };
}

/** A 0.16 listen's row on the current automation. */
async function insert016Listen(input: RowListen): Promise<TriggerId> {
  const id = randomUUID() as TriggerId;
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    .values({ id, team_id: teamId, name: `heard:${input.edge}`, kind: input.adapterType, config: JSON.stringify(configOf(input, id)), movement_id: currentMovement, credentials_id: null })
    .execute();
  return id;
}

/** A 0.15 listen's row written as provisioning keeps one: 0.15's own plan
 *  schema reads it, as `lane.isListenRow` checks. */
async function insert015Listen(input: RowListen): Promise<TriggerId> {
  const id = randomUUID() as TriggerId;
  const config = configOf(input, id);
  expect(lane.isListenRow({ config })).toBe(true);
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    .values({
      id,
      team_id: teamId,
      name: `${input.movement ?? 'heard'}:${input.edge}`,
      kind: input.adapterType,
      config: JSON.stringify(config),
      movement_id: cronMovement,
      credentials_id: (input.credentialsId ?? null) as ExternalServiceCredentialsId | null,
    })
    .execute();
  return id;
}

const receiptsOf = (triggerId: TriggerId) =>
  getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('trigger_id', '=', triggerId).select(['status']).orderBy('created_at').execute();
const runsOf = (triggerId: TriggerId) =>
  getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('trigger_id', '=', triggerId).select(['status', 'failure_reason']).execute();
const firesFor = async () =>
  (await getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('kind', '=', 'fire_event').select('payload').execute()).map(
    (row) => (row.payload as { triggerId?: string }).triggerId,
  );
const clearWork = () => getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).where('kind', 'in', ['fire_event', 'dispatch_event']).execute();
const subscriptionRows = () =>
  getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', teamId)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .select(['id', 'status', 'subscriptions', 'external_webhook_id', 'webhook_secret'])
    .execute();

async function drainAll(): Promise<void> {
  for (let pass = 0; pass < 5; pass++) {
    const drained = await drainUntilIdle({ owner: 'carried-upkeep', teamId });
    if (drained.claimed === 0) return;
  }
}

beforeAll(async () => {
  api = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(answer(request.method ?? 'GET', url.pathname)));
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  baseUrl = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : '';

  resetWorkHandlersForTests();
  registerDispatchWork();
  registerCarriedRunWork();
  registerListenResolveWork();
  setWorkNotifier({ notify() {} });

  teamId = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `carried-upkeep-${teamId.slice(0, 8)}` }).execute();
  await ProvisioningService.provisionUser({ teamId, email: 'ada@example.com', access: 'admin' });
  granolaCredential = await credential({ type: ExternalServiceType.GRANOLA, name: 'notes', fields: { apiKey: 'granola-key', baseUrl } });
  attioCredential = await credential({ type: ExternalServiceType.ATTIO, name: 'crm', fields: { accessToken: 'attio-token', baseUrl } });

  currentMovement = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: currentMovement, team_id: teamId, name: 'current', source: '', language_version: LANGUAGE_VERSION }).execute();
  cronMovement = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: cronMovement, team_id: teamId, name: 'ticker', source: CRON_015, description: '', language_version: '0.15.3' }).execute();

  const listening = await versionOf('0.15.3')?.listenRows?.();
  if (listening === undefined) throw new Error('test: 0.15 carries no listen lane');
  lane = listening;
});

afterAll(async () => {
  setWorkNotifier(inProcessNotifier);
  resetWorkHandlersForTests();
  for (const row of await listWorkByKind('poll_edge')) if (row.teamId === teamId) await removeWork({ key: row.key });
  await getAutomationsQb(['webhook_subscription']).deleteFrom('webhook_subscription').where('team_id', '=', teamId).execute();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await cleanupTeam(teamId);
});

describe("a 0.15 listen fires through 0.15's own module and judge, however its event arrives (real Postgres)", () => {
  let cronListen: TriggerId;

  it("a cron listen is polled by 0.15's own cron unit, apart from a 0.16 one on the same schedule, and runs on 0.15's engine", async () => {
    const saved = await saveMovement({ audience: { for: 'run' }, teamId, id: cronMovement, source: CRON_015 });
    expect(saved).toEqual(expect.objectContaining({ ok: true, listeners: [expect.objectContaining({ kind: 'cron', movementName: 'tick' })] }));
    if (!saved.ok) return;
    cronListen = saved.listeners[0]!.triggerId as TriggerId;
    const current = await insertTestListen({ teamId, movementId: currentMovement, adapterType: 'cron', edge: 'Ticks', delivery: 'polled', taken: takenEquals('Schedule', '* * * * *') });

    const polls = await sharedPolls({ teamId });
    const carried = polls.find((poll) => poll.carried.some((listen) => listen.triggerId === cronListen));
    const own = polls.find((poll) => poll.listens.some((listen) => listen.triggerId === current));
    // One schedule, two versions: two polls, the 0.15 one under a key of its own.
    expect(carried?.key.version).toBe('0.15');
    expect(carried?.listens).toEqual([]);
    expect(own?.key.version).toBeUndefined();
    expect(own?.carried).toEqual([]);
    expect(carried?.digest).not.toBe(own?.digest);
    if (carried === undefined) return;

    // A first poll only arms.
    expect(await pollShared(carried)).toEqual(expect.objectContaining({ arrivals: 0, armed: true }));
    expect(await receiptsOf(cronListen)).toEqual([]);

    // Ten minutes unpolled: of what it missed, only the latest tick fires.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await sql`update automations.inbound_checkpoint set checkpoint = to_jsonb(${tenMinutesAgo}::text)
      where team_id = ${teamId}::uuid and subscription_id = ${pollSubscriptionId(carried.digest)}::text`.execute(getAutomationsQb(['inbound_checkpoint']));
    // The latest missed tick, and any due since the poll began.
    const polled = await pollShared(carried);
    expect(polled.armed).toBe(false);
    expect(polled.arrivals).toBeGreaterThan(0);
    const receipts = await receiptsOf(cronListen);
    expect(receipts).toHaveLength(polled.arrivals);
    expect(receipts.every((receipt) => receipt.status === 'received')).toBe(true);

    await drainAll();
    const runs = await runsOf(cronListen);
    expect(runs).toHaveLength(polled.arrivals);
    expect(runs.every((run) => run.status === 'success' && run.failure_reason === null)).toBe(true);
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', '=', current).execute();
  });

  it("a polled Granola listen is polled by 0.15's own Granola module, and judged by 0.15's judge", async () => {
    const movementId = randomUUID() as MovementId;
    await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'meetings', source: GRANOLA_015, description: '', language_version: '0.15.3' }).execute();
    const saved = await saveMovement({ audience: { for: 'run' }, teamId, id: movementId, source: GRANOLA_015 });
    expect(saved).toEqual(expect.objectContaining({ ok: true, listeners: [expect.objectContaining({ kind: 'granola', credentialsId: granolaCredential })] }));
    if (!saved.ok) return;
    const granola = saved.listeners[0]!.triggerId as TriggerId;
    const poll = (await sharedPolls({ teamId })).find((shared) => shared.carried.some((listen) => listen.triggerId === granola));
    expect(poll?.key).toEqual(expect.objectContaining({ adapterType: 'granola', edge: 'Meetings', version: '0.15', credentialsId: granolaCredential }));
    if (poll === undefined) return;

    expect(await pollShared(poll)).toEqual(expect.objectContaining({ armed: true }));
    stand.notes.push({
      id: 'not_1',
      title: 'Pipeline review',
      summary_text: 'We went through the pipeline.',
      folder_membership: [],
      owner: { email: 'ada@example.com', name: 'Ada' },
      attendees: [],
      created_at: new Date().toISOString(),
      updated_at: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(await pollShared(poll)).toEqual(expect.objectContaining({ arrivals: 1, armed: false }));
    expect(await receiptsOf(granola)).toEqual([{ status: 'received' }]);
    await clearWork();
  });

  it("a 0.15 Attio listen's webhook is registered by 0.15's Attio module, kept on the next sync, and withdrawn with the listen", async () => {
    const attio = await insert015Listen({ adapterType: 'attio', edge: 'Changes', delivery: 'connection', credentialsId: attioCredential, movement: 'tick' });

    const first = await syncListenSubscriptions({ teamId });
    expect(first.unregistered).toEqual([]);
    const rows = await subscriptionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ status: 'active', external_webhook_id: 'wh-1', webhook_secret: 'secret-wh-1' }));
    expect(rows[0]!.subscriptions).toEqual(expect.objectContaining({ edge: 'Changes', version: '0.15' }));

    await syncListenSubscriptions({ teamId });
    expect(stand.webhooks).toEqual(['wh-1']);
    expect((await subscriptionRows()).map((row) => row.id)).toEqual([rows[0]!.id]);

    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', '=', attio).execute();
    await syncListenSubscriptions({ teamId });
    expect(stand.removed).toEqual(['wh-1']);
    expect(await subscriptionRows()).toEqual([]);
  });

  it('a paused 0.15 listen keeps its webhook subscription, as a paused 0.16 listen does', async () => {
    const removedBefore = stand.removed.length;
    const attio = await insert015Listen({ adapterType: 'attio', edge: 'Changes', delivery: 'connection', credentialsId: attioCredential, movement: 'tick' });
    await syncListenSubscriptions({ teamId });
    const [row] = await subscriptionRows();
    expect(row).toEqual(expect.objectContaining({ status: 'active' }));

    await getAutomationsQb(['trigger']).updateTable('trigger').set({ run_mode: 'off' }).where('id', '=', attio).execute();
    await syncListenSubscriptions({ teamId });
    expect((await subscriptionRows()).map((kept) => kept.id)).toEqual([row!.id]);
    expect(stand.removed).toHaveLength(removedBefore);

    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', '=', attio).execute();
    await syncListenSubscriptions({ teamId });
    expect(await subscriptionRows()).toEqual([]);
  });

  it("one subscription to a whole connection's edge serves both versions: registered once, a delivery there read by each", async () => {
    const webhooksBefore = stand.webhooks.length;
    const removedBefore = stand.removed.length;
    const old = await insert015Listen({ adapterType: 'attio', edge: 'Changes', delivery: 'connection', credentialsId: attioCredential, movement: 'tick' });
    const now = await insertTestListen({ teamId, movementId: currentMovement, adapterType: 'attio', edge: 'Changes', delivery: 'connection', credentialsId: attioCredential });

    await syncListenSubscriptions({ teamId });
    const rows = await subscriptionRows();
    expect(rows).toHaveLength(1);
    expect(stand.webhooks).toHaveLength(webhooksBefore + 1);
    const held = edgeSubscriptionOf(rows[0]!.subscriptions);
    if (held === null) throw new Error('test: the row holds no edge subscription');
    // This release's module registered it: its listen came first.
    expect(held.version).toBeUndefined();

    // 0.16's door reads it by its listen sharing it; 0.15 gets a reading of its own, by its listen sharing it.
    expect((await listensOfSubscription({ teamId, adapterType: 'attio', subscriptions: rows[0]!.subscriptions }))?.map((listen) => listen.triggerId)).toEqual([now]);
    const sharing015 = (await carriedListens({ teamId, kinds: ['attio'] })).filter((listen) => carriedEdgeKeysOf(listen, ['connection', 'scope']).some(({ digest }) => digest === held.digest));
    expect(sharing015.map((listen) => listen.triggerId)).toEqual([old]);
    const provider = (await getAutomationsQb(['webhook_subscription']).selectFrom('webhook_subscription').where('id', '=', rows[0]!.id as never).select('provider').executeTakeFirstOrThrow()).provider;
    const kept = await keepForEveryVersion({ origin: { teamId, adapterType: 'attio', providerKey: provider, credentialsId: attioCredential }, subscriptionId: rows[0]!.id, externalId: 'attio:shared-1', source: 'webhook', request: {} });
    expect(kept.kind).toBe('read');
    const readings = (await listWorkByKind('read_delivery')).filter((row) => row.teamId === teamId);
    expect(readings.map((row) => row.payload)).toEqual([expect.objectContaining({ version: '0.15', digest: held.digest })]);
    for (const row of readings) await removeWork({ key: row.key });

    // Either version's listens keep it alone.
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', '=', now).execute();
    await syncListenSubscriptions({ teamId });
    expect((await subscriptionRows()).map((row) => row.id)).toEqual([rows[0]!.id]);
    expect(stand.removed).toHaveLength(removedBefore);
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', '=', old).execute();
    await syncListenSubscriptions({ teamId });
    expect(await subscriptionRows()).toEqual([]);
  });

  describe('the doors that build their own arrivals', () => {
    /** The two calls each door makes: the current version's judging and keep,
     *  then each carried version's judging of the same page. */
    async function delivered(input: { adapterType: string; providerKey?: string; arrivals: Parameters<typeof deliverArrivals>[0]['arrivals']; externalId: string }) {
      const current = await deliverArrivals({
        teamId,
        delivered: { adapterType: input.adapterType, credentialsId: null },
        subscriptionId: input.providerKey ?? input.adapterType,
        externalId: input.externalId,
        source: 'webhook',
        arrivals: input.arrivals,
      });
      const carried = await judgeCarriedPage({
        teamId,
        adapterType: input.adapterType,
        ...(input.providerKey !== undefined ? { providerKey: input.providerKey } : {}),
        credentialsId: null,
        page: input.arrivals,
        stableKey: input.externalId,
      });
      return { fires: current.fires.map((fire) => fire.triggerId), carried };
    }

    it("an email: 0.15's judge reads its own filter, and the 0.16 listen is judged by 0.16 alone", async () => {
      const old = await insert015Listen({ adapterType: 'email', edge: 'Emails', to: 'Email', delivery: 'connection', taken: takenEquals('Key', 'intake'), movement: 'tick' });
      const now = await insert016Listen({ adapterType: 'email', edge: 'Emails', to: 'Email', delivery: 'connection', taken: takenEquals('Key', 'deals') });
      const email = (key: string, id: string) =>
        inboundEmailArrival({ payload: { messageId: id, recipient: `inbox+${key}@example.com`, sender: 'ada@example.com', 'body-plain': 'hi' }, fallbackIdentity: id });

      expect(await delivered({ adapterType: 'email', arrivals: [email('intake', 'm-1')], externalId: 'email:m-1' })).toEqual({ fires: [], carried: 1 });
      expect(await receiptsOf(old)).toEqual([{ status: 'received' }]);
      expect(await delivered({ adapterType: 'email', arrivals: [email('deals', 'm-2')], externalId: 'email:m-2' })).toEqual({ fires: [now], carried: 0 });
      expect(await receiptsOf(now)).toEqual([]);
      // The same email told twice keeps one receipt, and counts as fired once.
      expect(await delivered({ adapterType: 'email', arrivals: [email('intake', 'm-1')], externalId: 'email:m-1' })).toEqual({ fires: [], carried: 0 });
      expect(await receiptsOf(old)).toHaveLength(1);
      await clearWork();
    });

    it("a WhatsApp message: 0.15's listen fires on the arrival the door built, 0.16's through its own door", async () => {
      const old = await insert015Listen({ adapterType: 'whatsapp', edge: 'Messages', to: 'Message', delivery: 'connection', movement: 'tick' });
      const now = await insert016Listen({ adapterType: 'whatsapp', edge: 'Messages', to: 'Message', delivery: 'connection' });
      const arrivals = whatsappInboundArrivals({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'P1' }, contacts: [], messages: [{ from: '447700900000', id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: 'hello' } }] } }] }],
      });
      expect(arrivals.length).toBeGreaterThan(0);

      // The provider key the WhatsApp door passes.
      expect(await delivered({ adapterType: 'whatsapp', providerKey: 'INBOUND_WHATSAPP', arrivals, externalId: 'whatsapp:wamid.1' })).toEqual({ fires: [now], carried: 1 });
      expect(await receiptsOf(old)).toEqual([{ status: 'received' }]);
      expect(await receiptsOf(now)).toEqual([]);
      await clearWork();
    });

    it("an ask's answer on `Response`: 0.15's listen fires on it, 0.16's through its own door", async () => {
      const id = askIdSchema.parse(randomUUID());
      const arrival = responseArrival({ id, family: 'Check', answer: true, state: 'answered' });
      const to = arrival.landing.recordType;
      const old = await insert015Listen({ adapterType: 'ask', edge: arrival.edge, ...(to !== undefined ? { to } : {}), delivery: 'connection', movement: 'tick' });
      const now = await insert016Listen({ adapterType: 'ask', edge: arrival.edge, ...(to !== undefined ? { to } : {}), delivery: 'connection' });

      expect(await delivered({ adapterType: 'ask', arrivals: [arrival], externalId: `answered:${id}` })).toEqual({ fires: [now], carried: 1 });
      expect(await receiptsOf(old)).toEqual([{ status: 'received' }]);
      await clearWork();
    });

    it("an arrival on a listed hop's edge whose members' changes are pushed lists the 0.15 listen again", async () => {
      // A 0.15 listen whose first hop's members the host lists, and whose
      // module pushes their changes on that hop's own edge.
      const id = randomUUID() as TriggerId;
      const listen = {
        pipeline: `listen:test:tick:${id.slice(0, 8)}`,
        plan: {
          movement: 'tick',
          connection: 'source',
          adapter: 'acme_parents',
          hops: [
            { edge: 'Parents', from: '', to: 'Parent', judged: 'resolved' },
            { edge: 'Things', from: 'Parent', to: 'Thing', judged: 'arrival' },
          ],
          carries: ['Parents'],
        },
        awaits: { own: [], carried: {} },
        fieldIds: {},
        delivery: { kind: 'connection' },
        resolvedHops: [{ hop: 0, membersChange: 'pushed' }],
      };
      expect(lane.watchOf({ config: { listen } })?.traversals).toEqual([expect.objectContaining({ pushedParentEdges: ['Parents'] })]);
      await getAutomationsQb(['trigger'])
        .insertInto('trigger')
        .values({ id, team_id: teamId, name: 'tick:Things', kind: 'acme_parents', config: JSON.stringify({ listen }), movement_id: cronMovement, credentials_id: null })
        .execute();
      const relists = async () => (await listWorkByKind('resolve_listen')).filter((row) => row.teamId === teamId).map((row) => row.key);
      const arrival = (edge: string, recordType: string) => ({ edge, identity: `${edge}-1`, landing: { recordId: `${edge}-1`, recordType, fields: { Name: 'one' } } });

      // A row's own change, on its last edge, is no member's change.
      await judgeCarriedPage({ teamId, adapterType: 'acme_parents', credentialsId: null, page: [arrival('Things', 'Thing')], stableKey: 'push:things' });
      expect(await relists()).toEqual([]);

      await judgeCarriedPage({ teamId, adapterType: 'acme_parents', credentialsId: null, page: [arrival('Parents', 'Parent')], stableKey: 'push:parents' });
      expect(await relists()).toEqual([`resolve_listen:${listen.pipeline}`]);

      for (const key of await relists()) await removeWork({ key });
      await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', '=', id).execute();
      await clearWork();
    });

    it('the email door: an email only a 0.15 listen takes is not quarantined; one no listen takes is', async () => {
      const old = await insert015Listen({ adapterType: 'email', edge: 'Emails', to: 'Email', delivery: 'connection', taken: takenEquals('Key', 'oldonly'), movement: 'tick' });
      const post = (key: string, messageId: string) =>
        new Promise<number>((resolve, reject) => {
          const body = { sender: 'ada@example.com', from: 'ada@example.com', recipient: `inbox+${key}@example.com`, subject: 'hi', 'body-plain': 'hi', 'Message-Id': messageId };
          const res = { headersSent: false, status: (status: number) => ({ send: () => resolve(status) }) };
          void runInContext(async () => inboundEmailHandler({ body, inboundEmailRoute: { key } } as never, res as never, reject), { email: 'ada@example.com' }, { teamId }).catch(reject);
        });
      const quarantined = async () => (await sql<{ n: number }>`select count(*)::int as n from public.dropped_inbound_email where team_id = ${teamId}::uuid`.execute(getCoreQb(['team']))).rows[0]?.n;

      expect(await post('oldonly', '<m-door-1@example.com>')).toBe(201);
      expect(await receiptsOf(old)).toEqual([{ status: 'received' }]);
      expect(await quarantined()).toBe(0);

      expect(await post('nobody', '<m-door-2@example.com>')).toBe(200);
      expect(await quarantined()).toBe(1);
      await sql`delete from public.dropped_inbound_email where team_id = ${teamId}::uuid`.execute(getCoreQb(['team']));
      await clearWork();
    });

    it("a remote module's push: the push door hands 0.15's judge the page, and 0.16's listen is judged by 0.16", async () => {
      const old = await insert015Listen({ adapterType: 'acme_remote', edge: 'Things', delivery: 'connection', movement: 'tick' });
      const now = await insertTestListen({ teamId, movementId: currentMovement, adapterType: 'acme_remote', edge: 'Things', delivery: 'connection' });

      await platformPushStore.keepArrivals({
        adapterType: 'acme_remote',
        teamId,
        arrivals: [{ edge: 'Things', identity: 'thing-1', landing: { recordId: 'thing-1', recordType: 'Thing', fields: { Name: 'one' } } }],
      });

      expect(await firesFor()).toEqual([now]);
      expect(await receiptsOf(old)).toEqual([{ status: 'received' }]);
      expect(await receiptsOf(now)).toEqual([]);
      await clearWork();
    });
  });

  it("with 0.15's lane failing to load, 0.16's polls, cron and subscriptions still run, and 0.15's are left as they are", async () => {
    const version = versionOf('0.15.3');
    if (version?.listenRows === undefined) throw new Error('test: 0.15 carries no listen lane');
    const work = { now: new Date(), owner: 'carried-upkeep', attempts: 1, heartbeat: async () => {} };
    // 0.15's own, while its lane loads: the cron listen's poll, and a narrowed Attio subscription of its own.
    const oldAttio = await insert015Listen({ adapterType: 'attio', edge: 'Changes', delivery: 'connection', credentialsId: attioCredential, taken: takenEquals('Kind', 'created'), movement: 'tick' });
    await syncListenSubscriptions({ teamId });
    const [carriedRow] = await subscriptionRows();
    expect(carriedRow?.subscriptions).toEqual(expect.objectContaining({ version: '0.15' }));
    const carriedPoll = (await sharedPolls({ teamId })).find((poll) => poll.key.version === '0.15');
    if (carriedPoll === undefined) throw new Error('test: no 0.15 poll');
    const nowCron = await insertTestListen({ teamId, movementId: currentMovement, adapterType: 'cron', edge: 'Ticks', delivery: 'polled', taken: takenEquals('Schedule', '*/5 * * * *') });
    const nowAttio = await insertTestListen({ teamId, movementId: currentMovement, adapterType: 'attio', edge: 'Changes', delivery: 'connection', credentialsId: attioCredential });
    const removedBefore = stand.removed.length;

    const failing = jest.spyOn(version, 'listenRows').mockRejectedValue(new Error('0.15 could not load'));
    try {
      const polls = await sharedPolls({ teamId });
      expect(polls.some((poll) => poll.key.version === '0.15')).toBe(false);
      const own = polls.find((poll) => poll.listens.some((listen) => listen.triggerId === nowCron));
      if (own === undefined) throw new Error('test: no 0.16 cron poll');
      // 0.16's cron poll runs by its handler, and is armed for its next tick.
      await pollEdgeHandler.run({ teamId, digest: own.digest }, work);
      expect((await listWorkByKind('poll_edge')).some((row) => row.key === pollWorkKey(own.digest))).toBe(true);
      // 0.15's poll is retried, never dropped as gone.
      await expect(pollEdgeHandler.run({ teamId, digest: carriedPoll.digest }, work)).rejects.toThrow('could not be read');

      // 0.16's subscription is registered; 0.15's is left as it is.
      const synced = await syncListenSubscriptions({ teamId });
      expect(synced.notes).toEqual(expect.arrayContaining([expect.stringContaining('pinned to 0.15 could not be read')]));
      const rows = await subscriptionRows();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.status === 'active')).toBe(true);
      expect(rows.map((row) => row.id)).toContain(carriedRow!.id);
      expect(stand.removed).toHaveLength(removedBefore);
    } finally {
      failing.mockRestore();
    }

    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', 'in', [oldAttio, nowCron, nowAttio]).execute();
    await syncListenSubscriptions({ teamId });
    expect(await subscriptionRows()).toEqual([]);
  });

  it("with 0.15's lane failing to load, the one subscription both versions share outlives its 0.16 listens", async () => {
    const version = versionOf('0.15.3');
    if (version?.listenRows === undefined) throw new Error('test: 0.15 carries no listen lane');
    const old = await insert015Listen({ adapterType: 'attio', edge: 'Changes', delivery: 'connection', credentialsId: attioCredential, movement: 'tick' });
    const now = await insertTestListen({ teamId, movementId: currentMovement, adapterType: 'attio', edge: 'Changes', delivery: 'connection', credentialsId: attioCredential });
    await syncListenSubscriptions({ teamId });
    const [shared] = await subscriptionRows();
    // This release registered it, so the row names no version.
    expect(edgeSubscriptionOf(shared!.subscriptions)?.version).toBeUndefined();
    const removedBefore = stand.removed.length;

    const failing = jest.spyOn(version, 'listenRows').mockRejectedValue(new Error('0.15 could not load'));
    try {
      await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', '=', now).execute();
      const synced = await syncListenSubscriptions({ teamId });
      // 0.15's listen on it may still want it: it is kept, and not withdrawn at the source.
      expect((await subscriptionRows()).map((row) => row.id)).toEqual([shared!.id]);
      expect(stand.removed).toHaveLength(removedBefore);
      expect(synced.notes).toEqual(expect.arrayContaining([expect.stringContaining('stays while the listens of 0.15 on it cannot be read')]));
    } finally {
      failing.mockRestore();
    }

    // Read again, 0.15's listen keeps it; with that gone too, it is withdrawn.
    await syncListenSubscriptions({ teamId });
    expect((await subscriptionRows()).map((row) => row.id)).toEqual([shared!.id]);
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', '=', old).execute();
    await syncListenSubscriptions({ teamId });
    expect(await subscriptionRows()).toEqual([]);
    expect(stand.removed).toHaveLength(removedBefore + 1);
  });

  it("with 0.15's lane failing to load, the poll reconcile removes no poll row", async () => {
    const version = versionOf('0.15.3');
    if (version?.listenRows === undefined) throw new Error('test: 0.15 carries no listen lane');
    // The reconcile is every team's: rows it arms for others are taken back.
    const armedBefore = new Set((await listWorkByKind('poll_edge')).map((row) => row.key));
    // A 0.15 listen that polls, whose lane then fails to load; and a row no
    // listen read shares, as an unread version's poll looks while unread.
    const old = await insert015Listen({ adapterType: 'cron', edge: 'Ticks', delivery: 'polled', taken: takenEquals('Schedule', '*/7 * * * *'), movement: 'tick' });
    const stray = pollWorkKey(`stray-${randomUUID()}`);
    await enqueueWork({ kind: 'poll_edge', key: stray, teamId, payload: { teamId, digest: 'stray' } });

    const failing = jest.spyOn(version, 'listenRows').mockRejectedValue(new Error('0.15 could not load'));
    try {
      await pollReconcileHandler.run({}, { now: new Date(), owner: 'carried-upkeep', attempts: 1, heartbeat: async () => {} });
      expect((await listWorkByKind('poll_edge')).map((row) => row.key)).toContain(stray);
    } finally {
      failing.mockRestore();
      for (const row of await listWorkByKind('poll_edge')) if (!armedBefore.has(row.key)) await removeWork({ key: row.key });
      await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', '=', old).execute();
    }
  });
});
