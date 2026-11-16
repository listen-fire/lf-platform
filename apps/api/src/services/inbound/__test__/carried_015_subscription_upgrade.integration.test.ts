// An upgrade off 0.15 hands a narrowed push listen's webhook to the upgraded
// listen in its own transaction (real Postgres, the real upgrade, the real
// webhook door): on 0.16 the 0.15 listen's subscription row is named by its key
// with version 0.15. The upgrade makes the listen this release's, and its key
// loses the version. The upgrade renames the row as it commits, so a delivery
// the source posts right after is heard by the upgraded listen, with no sync
// run yet and nothing registered or removed at the source; the sync it queued
// then finds the row already the upgraded listen's.
//
// The one network seam is a local stand-in for Attio's API, which both
// versions' Attio modules reach through the connection's stored base URL.
// Attio itself takes no part of a listen's WHERE, so it plans no narrowed key:
// this release's module is made to take `Kind` on a change, as a module that
// filters its webhook does, and the 0.15 row is the same listen planned so.

jest.mock('@listen-fire/attio/changes', () => {
  const actual = jest.requireActual('@listen-fire/attio/changes');
  return {
    ...actual,
    changesEdge: (object: unknown) => ({ ...actual.changesEdge(object), capability: { filter: 'native', supportsLimit: false } }),
    describeChange: (object: unknown, attributes: unknown) => {
      const described = actual.describeChange(object, attributes);
      return { ...described, fields: described.fields.map((field: { fieldId: string }) => (field.fieldId === 'Kind' ? { ...field, capability: { filterOperators: ['eq'] } } : field)) };
    },
  };
});

import { createServer, type Server } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

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
import { ProvisioningService } from '../../provisioning';
import { inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { listWorkByKind } from '../../work/store';
import { getAdapterManifest } from '../../translation_graph/adapters/registry';
import { upgradeMovement } from '../../translation_graph/movement/language_upgrade';
import { MOVEMENT_LISTEN_PROVISIONER, edgeSubscriptionOf, listensOfSubscription, syncListenSubscriptions } from '../../translation_graph/movement/listen_subscriptions';
import { handleInboundWebhook } from '../../webhook_sync/handler';
import { webhookProviderKey } from '../../webhook_sync/urls';
import { carriedEdgeKeysOf, carriedListens } from '../carried_listens';
import { fireRowSchema, savedListens } from '../listen_door';
import { listenEdgeDigest, listenEdgeKeysOf } from '../listen_edge';

/** Deals deleted, as an author writes it under 0.15 and under 0.16 alike. */
const DEALS_DELETED =
  'import { attio } from adapters\nimport { crm } from credentials\nc = connect attio using crm\n' +
  'function gone(d: <c-[:DealChange]->>) {\n  said = d.Kind\n  return said\n}\n' +
  'listen to c-[:Deals]->-[d:Changes WHERE d.Kind == "deleted"]-> fire gone\n';

/** Attio's API, as far as either module asks it here. */
const stand: { webhooks: string[]; removed: string[] } = { webhooks: [], removed: [] };
let api: Server;
let baseUrl: string;

let teamId: TeamId;
let movementId: MovementId;
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

/** The 0.15 listen's row, as 0.15's planner plans the text with `Kind` taken by
 *  the module. */
function carriedConfig(id: string) {
  return {
    listen: {
      pipeline: `listen:deals_gone:gone:${id.slice(0, 8)}`,
      plan: {
        movement: 'gone',
        connection: 'c',
        adapter: 'attio',
        carries: ['Deals'],
        hops: [
          { edge: 'Deals', from: '', to: 'Deals', judged: 'none' },
          {
            edge: 'Changes',
            from: 'Deals',
            to: 'DealChange',
            alias: 'd',
            judged: 'arrival',
            taken: { type: 'compare', op: 'eq', left: { type: 'edge_property', propertyTypeId: 'Kind', fieldOnly: true }, right: { type: 'static', value: 'deleted' } },
          },
        ],
      },
      credentialName: 'crm',
      awaits: { own: [], carried: {} },
      fieldIds: {},
      delivery: { kind: 'connection' },
    },
  };
}

const subscriptionRows = () =>
  getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', teamId)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .select(['id', 'status', 'subscriptions', 'external_webhook_id', 'webhook_secret'])
    .orderBy('created_at')
    .execute();

const readingsOf = async () => (await listWorkByKind('read_delivery')).filter((row) => row.teamId === teamId).map((row) => row.payload);

/** What a listen of this release fired: each run the door queued for it, by
 *  the arrival it was for. */
async function firedFor(triggerId: TriggerId): Promise<string[]> {
  const rows = await getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('kind', '=', 'fire_event').select('payload').execute();
  return rows.flatMap(({ payload }) => {
    const fire = fireRowSchema.parse(payload);
    return fire.triggerId === triggerId ? [fire.arrival.identity] : [];
  });
}

/** A deal deleted, as Attio posts it to the webhook at `subscriptionId`,
 *  signed with that webhook's secret, through the door every version shares. */
async function attioPosts(input: { subscriptionId: string; secret: string; recordId: string }): Promise<void> {
  const rawBody = Buffer.from(JSON.stringify({ webhook_id: 'wh-0160', events: [{ event_type: 'record.deleted', id: { workspace_id: 'ws', object_id: 'obj-deals', record_id: input.recordId } }] }), 'utf8');
  const handled = await handleInboundWebhook({
    provider: providerKey,
    subscriptionId: input.subscriptionId,
    rawBody,
    headers: { 'content-type': 'application/json', 'attio-signature': createHmac('sha256', input.secret).update(rawBody).digest('hex') },
  });
  expect(handled).toEqual(expect.objectContaining({ ok: true }));
  await handled.enqueueDeferred?.();
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
  setWorkNotifier({ notify() {} });
  const manifest = getAdapterManifest('attio');
  if (manifest === null) throw new Error('test: no attio module');
  providerKey = webhookProviderKey(manifest);
});

beforeEach(async () => {
  stand.webhooks = [];
  stand.removed = [];
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `carried-sub-upgrade-${teamId.slice(0, 8)}` }).execute();
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
  movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'deals_gone', source: DEALS_DELETED, description: '', language_version: '0.15.3' }).execute();
  const versionId = randomUUID() as MovementVersionId;
  await getAutomationsQb(['movement_version']).insertInto('movement_version').values({ id: versionId, movement_id: movementId, team_id: teamId, version_number: 1, source: DEALS_DELETED, content_hash: `hash-${versionId}`, language_version: '0.15.3' }).execute();
  await getAutomationsQb(['movement']).updateTable('movement').set({ current_version_id: versionId }).where('id', '=', movementId).execute();
});

afterEach(async () => {
  await getAutomationsQb(['webhook_subscription']).deleteFrom('webhook_subscription').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

afterAll(async () => {
  setWorkNotifier(inProcessNotifier);
  resetWorkHandlersForTests();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

describe('a narrowed push listen upgraded off 0.15 by the real upgrade (real Postgres)', () => {
  it('a delivery posted right after the upgrade commits, before any sync, runs the upgraded listen once; no webhook is registered or removed', async () => {
    const carried = randomUUID() as TriggerId;
    await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({ id: carried, team_id: teamId, name: 'movement/deals_gone/gone', kind: 'attio', config: JSON.stringify(carriedConfig(carried)), movement_id: movementId, credentials_id: attioCredential, fired_movement_name: 'gone' })
      .execute();
    const [carriedListen] = await carriedListens({ teamId, kinds: ['attio'] });
    const [keyed] = carriedListen !== undefined ? carriedEdgeKeysOf(carriedListen, ['connection', 'scope']) : [];
    if (keyed === undefined) throw new Error('test: the 0.15 listen is not read as carried, with a key');
    expect(keyed.key.version).toBe('0.15');
    // As the release's sync left it on 0.16.1: the carried key's row, registered by 0.15's module.
    const own = randomUUID();
    await getAutomationsQb(['webhook_subscription'])
      .insertInto('webhook_subscription')
      .values({
        id: own as WebhookSubscriptionId,
        team_id: teamId,
        provider: providerKey,
        credentials_id: attioCredential,
        webhook_secret: 'secret-wh-0160',
        external_webhook_id: 'wh-0160',
        subscriptions: JSON.stringify({ digest: keyed.digest, edge: 'Changes', filter: keyed.key.taken, version: '0.15' }),
        status: 'active',
        provisioned_by: MOVEMENT_LISTEN_PROVISIONER,
      })
      .execute();

    const upgraded = await upgradeMovement({ teamId, id: movementId, acknowledge: true });
    expect(upgraded).toEqual(expect.objectContaining({ status: 'upgraded' }));
    const [listen, ...more] = await savedListens({ teamId, movementId });
    expect(more).toEqual([]);
    if (listen === undefined) throw new Error('test: the upgraded automation has no listen of this release');
    expect(listenEdgeKeysOf(listen, ['connection']).map(({ digest }) => digest)).toEqual([listenEdgeDigest({ ...keyed.key, version: undefined })]);
    expect(listen.carriedFrom).toEqual({ at: expect.any(String) });

    // The upgrade renamed the row as it committed: no sync has run.
    const rows = await subscriptionRows();
    expect(rows.map((row) => row.id)).toEqual([own]);
    expect(rows[0]).toEqual(expect.objectContaining({ status: 'active', external_webhook_id: 'wh-0160', webhook_secret: 'secret-wh-0160' }));
    expect(edgeSubscriptionOf(rows[0]!.subscriptions)).toEqual(expect.objectContaining({ digest: listenEdgeDigest({ ...keyed.key, version: undefined }) }));
    expect(edgeSubscriptionOf(rows[0]!.subscriptions)?.version).toBeUndefined();
    expect((await listensOfSubscription({ teamId, adapterType: 'attio', subscriptions: rows[0]!.subscriptions }))?.map((one) => one.triggerId)).toEqual([listen.triggerId]);

    await attioPosts({ subscriptionId: own, secret: 'secret-wh-0160', recordId: 'rec-1' });
    expect(await readingsOf()).toEqual([]);
    expect(await firedFor(listen.triggerId)).toEqual(['obj-deals:rec-1:deleted']);

    // The sync the upgrade queued finds the row already the upgraded listen's.
    await syncListenSubscriptions({ teamId });
    expect(await subscriptionRows()).toEqual(rows);
    expect(stand.webhooks).toEqual([]);
    expect(stand.removed).toEqual([]);
    expect(await firedFor(listen.triggerId)).toEqual(['obj-deals:rec-1:deleted']);
  });
});
