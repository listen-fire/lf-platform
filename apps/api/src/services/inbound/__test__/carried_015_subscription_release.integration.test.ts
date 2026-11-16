// A carried push listen keeps hearing its webhook across the release (real
// Postgres, the real sync, door and 0.15's own Attio module): on 0.15.3 a
// narrowed 0.15 listen was the current version's, so its subscription row was
// named by its key without a version. On 0.16 the same listen is carried, and
// its key names version 0.15, which renames the subscription. The release's
// sync (queued once by the deploy check) takes the old row over, its
// registration at the source unchanged:
//
//   - with no current listen wanting the old name, the row is renamed, so the
//     webhook already registered posts to the carried listen, and no second
//     one is registered;
//   - with one, the row stays the current listen's, and the carried listen
//     gets one subscription of its own;
//   - the step run again changes nothing.
//
// The one network seam is a local stand-in for Attio's API, which 0.15's
// module reaches through the connection's stored base URL.

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION } from 'movement-lang';
import { versionOf, type ListeningLane } from '@listen-fire/language-versions';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { MovementVersionId } from '../../../generated/kysely/automations/MovementVersion';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import type { WebhookSubscriptionId } from '../../../generated/kysely/automations/WebhookSubscription';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { encryptToken } from '../../../lib/credentials';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { takenEquals, testListenConfig } from '../../../test/harness/listens';
import { ProvisioningService } from '../../provisioning';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { listWorkByKind, removeWork } from '../../work/store';
import { getAdapterManifest } from '../../translation_graph/adapters/registry';
import { builtinModuleRequestKeeping } from '../../translation_graph/adapters/builtin_modules';
import {
  MOVEMENT_LISTEN_PROVISIONER,
  edgeSubscriptionOf,
  listensOfSubscription,
  queueListenSubscriptionSyncAfterRelease,
  syncListenSubscriptions,
  syncListenSubscriptionsAfterRelease,
} from '../../translation_graph/movement/listen_subscriptions';
import { webhookProviderKey } from '../../webhook_sync/urls';
import { capturedRequest } from '../captured_request';
import { keepForEveryVersion, registerReadDeliveryWork } from '../carried_delivery';
import { carriedEdgeKeysOf, carriedListens } from '../carried_listens';
import { listenEdgeDigest, type ListenEdgeKey } from '../listen_edge';

const ATTIO_015 =
  'import { attio } from adapters\nimport { crm } from credentials\nc = connect attio using crm\n' +
  'function gone(d: <c-[:Changes]->>) {\n  said = d.Kind\n  return said\n}\n' +
  'listen to c-[d:Changes WHERE d.Kind == "deleted"]-> fire gone\n';

const RELEASE = `test-${randomUUID().slice(0, 8)}`;

/** Attio's API, as far as 0.15's module asks it here. */
const stand: { webhooks: string[]; removed: string[] } = { webhooks: [], removed: [] };
let api: Server;
let baseUrl: string;

let teamId: TeamId;
let lane: ListeningLane;
let carriedMovement: MovementId;
let currentMovement: MovementId;
let attioCredential: ExternalServiceCredentialsId;
let providerKey: string;

function answer(method: string, path: string): unknown {
  if (path === '/v2/objects' && method === 'GET') {
    return { data: [{ id: { workspace_id: 'ws', object_id: 'obj-deals' }, api_slug: 'deals', singular_noun: 'Deal', plural_noun: 'Deals' }] };
  }
  if (path === '/v2/lists' && method === 'GET') return { data: [] };
  if (path.startsWith('/v2/objects/') && path.endsWith('/attributes') && method === 'GET') return { data: [] };
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

/** A narrowed Attio listen's row: deals deleted. */
const DELETED = { adapterType: 'attio', edge: 'Changes', delivery: 'connection' as const, taken: takenEquals('Kind', 'deleted') };

function configOf(id: string) {
  const listen = testListenConfig({ ...DELETED, movement: 'gone' }, id);
  return { listen: { ...listen, plan: { ...listen.plan, hops: listen.plan.hops.map((hop) => ({ ...hop, to: 'DealChange' })) } } };
}

async function insertListen(movementId: MovementId): Promise<TriggerId> {
  const id = randomUUID() as TriggerId;
  const config = configOf(id);
  if (movementId === carriedMovement) expect(lane.isListenRow({ config })).toBe(true);
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    .values({ id, team_id: teamId, name: `gone:Changes`, kind: 'attio', config: JSON.stringify(config), movement_id: movementId, credentials_id: attioCredential })
    .execute();
  return id;
}

/** The carried listen's key, and its name while 0.15 was current: its key
 *  without the version. */
async function keysOf(triggerId: TriggerId): Promise<{ carried: ListenEdgeKey; digest: string; asCurrent: string }> {
  const listen = (await carriedListens({ teamId, kinds: ['attio'] })).find((candidate) => candidate.triggerId === triggerId);
  if (listen === undefined) throw new Error('test: the 0.15 listen is not read as carried');
  const [only] = carriedEdgeKeysOf(listen, ['connection', 'scope']);
  if (only === undefined || only.key.version !== '0.15') throw new Error('test: the 0.15 listen has no versioned key');
  return { carried: only.key, digest: only.digest, asCurrent: listenEdgeDigest({ ...only.key, version: undefined }) };
}

/** A registered subscription row, as a sync leaves one: under `name`, by the
 *  module of `version` (undefined: the current one's). */
async function registeredRow(input: { key: ListenEdgeKey; name: string; version?: string; webhook: string }): Promise<string> {
  const id = randomUUID();
  const held = { digest: input.name, edge: input.key.edge, filter: input.key.taken, ...(input.version !== undefined ? { version: input.version } : {}) };
  await getAutomationsQb(['webhook_subscription'])
    .insertInto('webhook_subscription')
    .values({
      id: id as WebhookSubscriptionId,
      team_id: teamId,
      provider: providerKey,
      credentials_id: attioCredential,
      webhook_secret: `secret-${input.webhook}`,
      external_webhook_id: input.webhook,
      subscriptions: JSON.stringify(held),
      status: 'active',
      provisioned_by: MOVEMENT_LISTEN_PROVISIONER,
    })
    .execute();
  return id;
}

/** The row v0.15.3's sync left for the listen: its key without the version,
 *  registered by the then current module. */
const rowAsV0153Left = (key: ListenEdgeKey) => registeredRow({ key, name: listenEdgeDigest({ ...key, version: undefined }), webhook: 'wh-0153' });

const subscriptionRows = () =>
  getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', teamId)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .select(['id', 'status', 'subscriptions', 'external_webhook_id', 'webhook_secret'])
    .orderBy('created_at')
    .execute();

const dispatchesOf = async (triggerId: TriggerId) =>
  (await listWorkByKind('dispatch_event')).filter((row) => row.teamId === teamId && (row.payload as { triggerId?: string }).triggerId === triggerId);
const readingsOf = async () => (await listWorkByKind('read_delivery')).filter((row) => row.teamId === teamId).map((row) => row.payload);

/** The listens the current version's door judges a delivery at `rowId` by. */
async function currentListensAt(rowId: string): Promise<string[] | undefined> {
  const [row] = (await subscriptionRows()).filter((candidate) => candidate.id === rowId);
  if (row === undefined) throw new Error('test: no such subscription row');
  return (await listensOfSubscription({ teamId, adapterType: 'attio', subscriptions: row.subscriptions }))?.map((listen) => listen.triggerId);
}

const receiptsOf = (triggerId: TriggerId) =>
  getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('trigger_id', '=', triggerId).select(['status']).orderBy('created_at').execute();

/** A deal deleted, as Attio posts it to the webhook at `subscriptionId`. */
async function postDeleted(subscriptionId: string, recordId: string): Promise<void> {
  const rawBody = Buffer.from(JSON.stringify({ webhook_id: 'wh-0153', events: [{ event_type: 'record.deleted', id: { workspace_id: 'ws', object_id: 'obj-deals', record_id: recordId } }] }), 'utf8');
  const kept = await keepForEveryVersion({
    origin: { teamId, adapterType: 'attio', providerKey, credentialsId: attioCredential },
    subscriptionId,
    externalId: null,
    source: 'webhook',
    request: capturedRequest({ keeping: builtinModuleRequestKeeping('attio'), headers: { 'content-type': 'application/json' }, rawBody, arrivals: [] }),
  });
  expect(kept.kind).toBe('read');
}

async function drainAll(): Promise<void> {
  for (let pass = 0; pass < 5; pass++) {
    const drained = await drainUntilIdle({ owner: 'carried-subscription-release', teamId });
    if (drained.claimed === 0) return;
  }
}

/** What the release does for subscriptions: the deploy check queues one sync
 *  of every team, which the api's drain runs. */
async function afterTheRelease(): Promise<void> {
  await queueListenSubscriptionSyncAfterRelease({ release: RELEASE });
  const [queued] = (await listWorkByKind('listen_subscription_release_sync')).filter((row) => row.key.endsWith(RELEASE));
  if (queued === undefined) throw new Error("test: the release's sync was not queued");
  await removeWork({ key: queued.key });
  // Run as its handler runs it, for every team; only this team's outcome is this test's.
  const { failed } = await syncListenSubscriptionsAfterRelease();
  expect(failed).not.toContain(teamId);
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
  registerReadDeliveryWork();
  setWorkNotifier({ notify() {} });

  const manifest = getAdapterManifest('attio');
  if (manifest === null) throw new Error('test: no attio module');
  providerKey = webhookProviderKey(manifest);

  const listening = await versionOf('0.15.3')?.listenRows?.();
  if (listening === undefined) throw new Error('test: 0.15 carries no listen lane');
  lane = listening;
});

beforeEach(async () => {
  stand.webhooks = [];
  stand.removed = [];
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `carried-sub-release-${teamId.slice(0, 8)}` }).execute();
  await ProvisioningService.provisionUser({ teamId, email: 'ada@example.com', access: 'admin' });
  attioCredential = randomUUID() as ExternalServiceCredentialsId;
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({
      id: attioCredential,
      team_id: teamId,
      type: ExternalServiceType.ATTIO,
      name: 'crm',
      identifier: 'crm',
      user_id: null,
      credentials: await encryptToken(JSON.stringify({ accessToken: 'attio-token', baseUrl }), attioCredential),
    })
    .execute();
  currentMovement = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: currentMovement, team_id: teamId, name: 'current', source: '', language_version: LANGUAGE_VERSION }).execute();
  carriedMovement = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: carriedMovement, team_id: teamId, name: 'deals', source: ATTIO_015, description: '', language_version: '0.15.3' }).execute();
  // Shipped under 0.15.3, as v0.15.3 left it: its rows' pin is the shipped version's.
  for (const [movementId, source, pin] of [[carriedMovement, ATTIO_015, '0.15.3'], [currentMovement, '', LANGUAGE_VERSION]] as const) {
    const versionId = randomUUID() as MovementVersionId;
    await getAutomationsQb(['movement_version']).insertInto('movement_version').values({ id: versionId, movement_id: movementId, team_id: teamId, version_number: 1, source, content_hash: `hash-${versionId}`, language_version: pin }).execute();
    await getAutomationsQb(['movement']).updateTable('movement').set({ current_version_id: versionId }).where('id', '=', movementId).execute();
  }
});

afterEach(async () => {
  for (const row of await listWorkByKind('read_delivery')) if (row.teamId === teamId) await removeWork({ key: row.key });
  for (const row of await listWorkByKind('dispatch_event')) if (row.teamId === teamId) await removeWork({ key: row.key });
  await getAutomationsQb(['webhook_subscription']).deleteFrom('webhook_subscription').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

afterAll(async () => {
  setWorkNotifier(inProcessNotifier);
  resetWorkHandlersForTests();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

describe('a carried narrowed push listen across the release that versions its key (real Postgres)', () => {
  it("after the release's step, a delivery at the webhook v0.15.3 registered runs the carried listen once, and no webhook is registered again", async () => {
    const carried = await insertListen(carriedMovement);
    const { carried: key, digest } = await keysOf(carried);
    const old = await rowAsV0153Left(key);

    await afterTheRelease();

    // The row v0.15.3 registered is the carried key's now, its registration unchanged.
    const rows = await subscriptionRows();
    expect(rows.map((row) => row.id)).toEqual([old]);
    expect(rows[0]).toEqual(expect.objectContaining({ status: 'active', external_webhook_id: 'wh-0153', webhook_secret: 'secret-wh-0153' }));
    expect(edgeSubscriptionOf(rows[0]!.subscriptions)).toEqual(expect.objectContaining({ digest, version: '0.15' }));
    expect(stand.webhooks).toEqual([]);
    expect(stand.removed).toEqual([]);

    await postDeleted(old, 'rec-1');
    await drainAll();
    expect(await receiptsOf(carried)).toEqual([{ status: 'received' }]);
    expect(await dispatchesOf(carried)).toHaveLength(1);
  });

  it('with a current listen still wanting the old name, each hears its own, and the carried listen is registered once', async () => {
    const carried = await insertListen(carriedMovement);
    const current = await insertListen(currentMovement);
    const { carried: key, digest } = await keysOf(carried);
    const shared = await rowAsV0153Left(key);

    await afterTheRelease();
    await afterTheRelease();

    // The old row stays the current listen's; the carried listen has one of its own, registered once by 0.15's module.
    const rows = await subscriptionRows();
    expect(rows.map((row) => row.id)).toEqual([shared, expect.any(String)]);
    expect(edgeSubscriptionOf(rows[0]!.subscriptions)?.version).toBeUndefined();
    expect(rows[1]).toEqual(expect.objectContaining({ status: 'active', external_webhook_id: 'wh-1' }));
    expect(edgeSubscriptionOf(rows[1]!.subscriptions)).toEqual(expect.objectContaining({ digest, version: '0.15' }));
    expect(stand.webhooks).toEqual(['wh-1']);
    expect(stand.removed).toEqual([]);

    // The current version's door judges the old row's deliveries by the current listen, and asks 0.15 nothing.
    expect(await currentListensAt(shared)).toEqual([current]);
    await postDeleted(shared, 'rec-1');
    expect(await readingsOf()).toEqual([]);
    expect(await currentListensAt(rows[1]!.id)).toEqual([]);

    // The carried listen's own webhook is read by 0.15, for it, once.
    await postDeleted(rows[1]!.id, 'rec-2');
    expect(await readingsOf()).toEqual([expect.objectContaining({ version: '0.15', digest })]);
    await drainAll();
    expect(await receiptsOf(carried)).toEqual([{ status: 'received' }]);
  });

  it("the release's step run again changes nothing, as on an installation v0.16.0's sync already moved", async () => {
    const carried = await insertListen(carriedMovement);
    const { carried: key } = await keysOf(carried);
    await rowAsV0153Left(key);

    await afterTheRelease();
    const once = await subscriptionRows();
    await afterTheRelease();
    expect(await subscriptionRows()).toEqual(once);
    expect(stand.webhooks).toEqual([]);
    expect(stand.removed).toEqual([]);
  });

  it("on an installation v0.16.0's sync registered the carried key on, the step changes nothing", async () => {
    const carried = await insertListen(carriedMovement);
    const { carried: key, digest } = await keysOf(carried);
    const own = await registeredRow({ key, name: digest, version: '0.15', webhook: 'wh-0160' });

    await afterTheRelease();
    expect((await subscriptionRows()).map((row) => row.id)).toEqual([own]);
    expect(stand.webhooks).toEqual([]);
    expect(stand.removed).toEqual([]);
  });

  it('a delivery at the old row before the step is heard by no listen, and is not heard later; one after it is heard once', async () => {
    const carried = await insertListen(carriedMovement);
    const { carried: key } = await keysOf(carried);
    const old = await rowAsV0153Left(key);

    // Between the deploy and the step the row names no version, so only the current version reads it, and it has no listen there.
    await postDeleted(old, 'rec-before');
    expect(await readingsOf()).toEqual([]);
    expect(await currentListensAt(old)).toEqual([]);

    await afterTheRelease();
    await drainAll();
    expect(await receiptsOf(carried)).toEqual([]);

    await postDeleted(old, 'rec-after');
    await drainAll();
    expect(await receiptsOf(carried)).toEqual([{ status: 'received' }]);
  });
});

describe('a narrowed push listen upgraded off 0.15 (real Postgres)', () => {
  /** The upgrade's rows alone: the 0.15 row replaced by a current one with the
   *  same plan, as the upgrade re-plans it. The upgrade itself also renames the
   *  subscription row as it commits (carried_015_subscription_upgrade); these
   *  cases are of the sync's own takeover, which does it when nothing did. */
  async function upgraded(carried: TriggerId): Promise<TriggerId> {
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', '=', carried).execute();
    return insertListen(currentMovement);
  }

  it("its sync takes over the carried key's row: no webhook registered or removed, and the row's deliveries are the current listen's", async () => {
    const carried = await insertListen(carriedMovement);
    const { carried: key, digest } = await keysOf(carried);
    const own = await registeredRow({ key, name: digest, version: '0.15', webhook: 'wh-0160' });

    const now = await upgraded(carried);
    // Until a sync runs, the row still names 0.15, which has no listen there, so a delivery is heard by neither version.
    expect(await currentListensAt(own)).toEqual([]);
    await postDeleted(own, 'rec-before');
    await drainAll();
    expect(await receiptsOf(now)).toEqual([]);
    for (const row of await listWorkByKind('read_delivery')) if (row.teamId === teamId) await removeWork({ key: row.key });

    await syncListenSubscriptions({ teamId });

    const rows = await subscriptionRows();
    expect(rows.map((row) => row.id)).toEqual([own]);
    expect(rows[0]).toEqual(expect.objectContaining({ status: 'active', external_webhook_id: 'wh-0160' }));
    expect(edgeSubscriptionOf(rows[0]!.subscriptions)).toEqual(expect.objectContaining({ digest: listenEdgeDigest({ ...key, version: undefined }) }));
    expect(edgeSubscriptionOf(rows[0]!.subscriptions)?.version).toBeUndefined();
    expect(stand.webhooks).toEqual([]);
    expect(stand.removed).toEqual([]);
    expect(await currentListensAt(own)).toEqual([now]);
    await postDeleted(own, 'rec-1');
    expect(await readingsOf()).toEqual([]);
  });

  it('with another 0.15 listen still on the key, the row stays 0.15\'s, and the upgraded listen is registered once', async () => {
    const carried = await insertListen(carriedMovement);
    const staying = await insertListen(carriedMovement);
    const { carried: key, digest } = await keysOf(carried);
    const own = await registeredRow({ key, name: digest, version: '0.15', webhook: 'wh-0160' });

    const now = await upgraded(carried);
    await syncListenSubscriptions({ teamId });
    await syncListenSubscriptions({ teamId });

    const rows = await subscriptionRows();
    expect(rows.map((row) => row.id)).toEqual([own, expect.any(String)]);
    expect(edgeSubscriptionOf(rows[0]!.subscriptions)).toEqual(expect.objectContaining({ digest, version: '0.15' }));
    expect(edgeSubscriptionOf(rows[1]!.subscriptions)?.version).toBeUndefined();
    expect(await currentListensAt(rows[1]!.id)).toEqual([now]);
    expect(stand.webhooks).toHaveLength(1);
    expect(stand.removed).toEqual([]);
    await postDeleted(own, 'rec-1');
    expect(await readingsOf()).toEqual([expect.objectContaining({ version: '0.15', digest })]);
    await drainAll();
    expect(await receiptsOf(staying)).toEqual([{ status: 'received' }]);
  });
});
