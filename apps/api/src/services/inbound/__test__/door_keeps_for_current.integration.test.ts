// The door that keeps a delivery before any version reads it, from the current
// version's side, against a real database and with the real keep: the provider
// is answered, and the runs and receipts queued, as when the door kept nothing
// first; a provider's retry of a delivery not yet judged is read again, once;
// a request a module refused is never kept; and a store that cannot write
// answers the provider an error, with nothing read or kept.

import { LANGUAGE_VERSION } from 'movement-lang';
import { createHmac, randomUUID } from 'node:crypto';

const mockResolve = jest.fn();
jest.mock('../../translation_graph/adapters/resolve', () => ({
  ...jest.requireActual('../../translation_graph/adapters/resolve'),
  resolveAdapter: (...args: unknown[]) => mockResolve(...args),
}));
const mockInstalls: unknown[] = [];
jest.mock('../../translation_graph/adapters/remote/store', () => ({
  ...jest.requireActual('../../translation_graph/adapters/remote/store'),
  listRemoteAdapters: async () => mockInstalls,
}));

import { sql } from 'kysely';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';

import { answerDelivery } from 'movement-engine/public/inbound';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { encryptToken } from '../../../lib/credentials';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen } from '../../../test/harness/listens';
import * as hostDeliveries from '../../movement_engine/run_host_deliveries';
import { platformInboundStore, platformInboundStoreFor } from '../../webhook_sync/handler';
import { webhookProviderKey } from '../../webhook_sync/urls';
import { judgedEmpty, keepForEveryVersion } from '../carried_delivery';

const arrival = (identity: string): Arrival => ({
  edge: 'Things',
  identity,
  landing: { recordId: identity, recordType: 'Thing', fields: { status: 'open' } },
});

describe('the door that keeps first, from the current version', () => {
  let teamId: TeamId;
  let movementId: MovementId;

  beforeEach(async () => {
    mockResolve.mockReset();
    mockInstalls.length = 0;
    teamId = randomUUID() as TeamId;
    movementId = randomUUID() as MovementId;
    await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `keeps-${teamId}` }).execute();
    await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'heard', source: '', language_version: LANGUAGE_VERSION }).execute();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await cleanupTeam(teamId);
  });

  async function attioSubscription(secret: string): Promise<string> {
    const id = randomUUID();
    const credentialsId = randomUUID();
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({ id: credentialsId as never, team_id: teamId, type: ExternalServiceType.ATTIO, name: 'attio_conn', identifier: id, credentials: await encryptToken(JSON.stringify({ accessToken: 'k', access_token: 'k' }), credentialsId) })
      .execute();
    await getAutomationsQb(['webhook_subscription'])
      .insertInto('webhook_subscription')
      .values({ id: id as never, team_id: teamId, provider: 'ATTIO', credentials_id: credentialsId as never, webhook_secret: secret, external_webhook_id: id, status: 'active', subscriptions: '[]' as never })
      .execute();
    return id;
  }

  const SECRET = 'sekrit-secret-sekrit';
  const sign = (rawBody: Buffer) => createHmac('sha256', SECRET).update(rawBody).digest('hex');
  const bodyOf = (event: string) => Buffer.from(JSON.stringify({ webhook_id: 'w', event }));

  function attioRequest(subscriptionId: string, rawBody: Buffer) {
    const headers = { 'content-type': 'application/json', 'attio-signature': sign(rawBody), authorization: 'Bearer leak' };
    return { rawBody, headers, method: 'POST', path: `/x/${subscriptionId}`, query: '' };
  }

  /** The delivery as the door answers it: with the raw keep first, or without. */
  function deliver(input: { subscriptionId: string; rawBody: Buffer; keptFirst: boolean }) {
    const received = attioRequest(input.subscriptionId, input.rawBody);
    const store = input.keptFirst ? platformInboundStoreFor(received) : platformInboundStore;
    return answerDelivery(store, { notify: () => {} }, { provider: 'ATTIO', subscriptionId: input.subscriptionId, ...received });
  }

  const deliveries = () =>
    sql<{ id: string; judged_at: Date | null; event_count: number; request: unknown }>`
      select id::text as id, judged_at, event_count, request from automations.delivery where team_id = ${teamId}::uuid order by received_at`.execute(getAutomationsQb(['delivery']));
  const workOf = (kind: string) => getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('kind', '=', kind).select(['key', 'payload']).execute();
  const arrivals = () => getAutomationsQb(['arrival']).selectFrom('arrival').where('team_id', '=', teamId).select(['edge', 'identity']).execute();

  const readsOnce = (found: readonly Arrival[]) =>
    mockResolve.mockImplementation(async () => ({ adapterType: 'attio', preprocessInbound: async () => ({ events: [], arrivals: found }) }));

  it('answers the provider, queues the runs and logs the arrivals as when nothing was kept first', async () => {
    readsOnce([arrival('thing-1')]);
    const withKeep = await attioSubscription(SECRET);
    await insertTestListen({ teamId, movementId, adapterType: 'attio', edge: 'Things', delivery: 'connection' });
    const kept = await deliver({ subscriptionId: withKeep, rawBody: bodyOf('a'), keptFirst: true });
    const keptRuns = await workOf('fire_event');
    const keptArrivals = await arrivals();
    const [keptRow] = (await deliveries()).rows;

    await cleanupTeam(teamId);
    teamId = randomUUID() as TeamId;
    movementId = randomUUID() as MovementId;
    await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `keeps-${teamId}` }).execute();
    await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'heard', source: '', language_version: LANGUAGE_VERSION }).execute();
    const without = await attioSubscription(SECRET);
    await insertTestListen({ teamId, movementId, adapterType: 'attio', edge: 'Things', delivery: 'connection' });
    const bare = await deliver({ subscriptionId: without, rawBody: bodyOf('a'), keptFirst: false });
    const bareRuns = await workOf('fire_event');
    const bareArrivals = await arrivals();
    const [bareRow] = (await deliveries()).rows;

    expect(kept.status).toBe(bare.status);
    expect(kept.body).toEqual(bare.body);
    expect(kept.status).toBe(200);
    expect(keptRuns).toHaveLength(1);
    expect(keptRuns.map((row) => row.key.split(':')[0])).toEqual(bareRuns.map((row) => row.key.split(':')[0]));
    expect(keptArrivals).toEqual(bareArrivals);
    // One delivery row either way, judged, with its events counted and the run's row naming it.
    expect(keptRow).toMatchObject({ judged_at: expect.any(Date), event_count: bareRow!.event_count });
    expect((keptRuns[0]!.payload as { deliveryId: string }).deliveryId).toBe(keptRow!.id);
    // And what it kept is the request without its credentials.
    expect(JSON.stringify(keptRow!.request)).not.toMatch(/authorization|leak|signature/i);
    expect(bareRow!.request).toBeNull();
  });

  it.each([true, false])('records the subscription\'s connection on the delivery it keeps (kept first: %s)', async (keptFirst) => {
    readsOnce([arrival('thing-1')]);
    const subscriptionId = await attioSubscription(SECRET);
    await insertTestListen({ teamId, movementId, adapterType: 'attio', edge: 'Things', delivery: 'connection' });

    expect((await deliver({ subscriptionId, rawBody: bodyOf('recorded'), keptFirst })).status).toBe(200);

    const { rows } = await sql<{ credentials_id: string | null; connection: string }>`
      select d.credentials_id::text as credentials_id, w.credentials_id::text as connection
      from automations.delivery d join automations.webhook_subscription w on w.id::text = d.subscription_id
      where d.team_id = ${teamId}::uuid`.execute(getAutomationsQb(['delivery']));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.credentials_id).toBe(rows[0]!.connection);
  });

  it('reads a retry of a delivery the current version had not judged, once, and a delivery after that is a new one', async () => {
    const subscriptionId = await attioSubscription(SECRET);
    await insertTestListen({ teamId, movementId, adapterType: 'attio', edge: 'Things', delivery: 'connection' });
    const body = bodyOf('retried');

    // The first attempt dies in the module before anything is judged: the provider is told to retry.
    mockResolve.mockImplementationOnce(async () => ({ adapterType: 'attio', preprocessInbound: async () => { throw new Error('module down'); } }));
    expect((await deliver({ subscriptionId, rawBody: body, keptFirst: true })).status).toBe(500);
    const [first] = (await deliveries()).rows;
    expect(first).toMatchObject({ judged_at: null });

    readsOnce([arrival('thing-1')]);
    expect((await deliver({ subscriptionId, rawBody: body, keptFirst: true })).status).toBe(200);
    const afterRetry = (await deliveries()).rows;
    expect(afterRetry.map((row) => row.id)).toEqual([first!.id]);
    expect(afterRetry[0]!.judged_at).not.toBeNull();
    expect(await workOf('fire_event')).toHaveLength(1);

    // Judged, the same request again is another delivery.
    expect((await deliver({ subscriptionId, rawBody: body, keptFirst: true })).status).toBe(200);
    expect((await deliveries()).rows).toHaveLength(2);
  });

  describe('keeping a delivery by an id the provider sent', () => {
    const origin = () => ({ teamId, adapterType: 'attio', credentialsId: null });
    const keep = (externalId: string) => keepForEveryVersion({ origin: origin(), subscriptionId: 'sub', externalId, source: 'webhook', request: { kept: true } });

    it('answers a duplicate once it is judged, and the same delivery to read again while it is not', async () => {
      const first = await keep('evt-1');
      if (first.kind !== 'read') throw new Error('the first keep reads');

      const unjudged = await keep('evt-1');
      expect(unjudged).toMatchObject({ kind: 'read', deliveryId: first.deliveryId });

      await judgedEmpty({ teamId, id: first.deliveryId });
      expect(await keep('evt-1')).toEqual({ kind: 'duplicate' });
      expect((await deliveries()).rows).toHaveLength(1);
    });

    it('writes no second judging of a delivery that was judged', async () => {
      const first = await keep('evt-2');
      if (first.kind !== 'read') throw new Error('the first keep reads');
      await judgedEmpty({ teamId, id: first.deliveryId });

      const store = hostDeliveries.deliveryRowStore({ host: 'platform', teamId });
      const delivery = { id: randomUUID(), subscriptionId: 'sub', externalId: null, receivedAt: new Date().toISOString(), source: 'webhook' as const, inline: false, events: [] };
      expect(await store.keepDelivery({ subscriptionId: 'sub', delivery, work: [], rawKept: { id: first.deliveryId } })).toEqual({ kept: false });
    });
  });

  describe('a module that checks its own requests', () => {
    const ADAPTER = 'acme_mail';
    const install = () => ({
      adapter_type: ADAPTER,
      credentials_id: randomUUID(),
      manifest: {
        adapterType: ADAPTER,
        baseUrl: 'https://acme-mail.test',
        authStrategy: { kind: 'bearer' },
        supportedTriggers: ['webhook'],
        runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
        methods: ['manifest', 'checkInbound'],
        protocolVersion: 2,
      },
    });

    async function remoteSubscription(): Promise<string> {
      const id = randomUUID();
      const credentialsId = randomUUID();
      await getAutomationsQb(['external_service_credentials'])
        .insertInto('external_service_credentials')
        .values({ id: credentialsId as never, team_id: teamId, type: ExternalServiceType.ATTIO, name: 'acme_conn', identifier: id, credentials: await encryptToken(JSON.stringify({}), credentialsId) })
        .execute();
      await getAutomationsQb(['webhook_subscription'])
        .insertInto('webhook_subscription')
        .values({ id: id as never, team_id: teamId, provider: webhookProviderKey({ adapterType: ADAPTER }), credentials_id: credentialsId as never, webhook_secret: 'whsec', external_webhook_id: id, status: 'active', subscriptions: '[]' as never })
        .execute();
      return id;
    }

    function deliverRemote(subscriptionId: string) {
      const received = { rawBody: Buffer.from(JSON.stringify({ hello: 'world' })), headers: { 'content-type': 'application/json' }, method: 'POST', path: `/x/${subscriptionId}`, query: '' };
      return answerDelivery(platformInboundStoreFor(received), { notify: () => {} }, { provider: webhookProviderKey({ adapterType: ADAPTER }), subscriptionId, ...received });
    }

    it('is kept only once the module has accepted the request', async () => {
      mockInstalls.push(install());
      const subscriptionId = await remoteSubscription();

      mockResolve.mockImplementation(async () => ({ adapterType: ADAPTER, checkInbound: async () => ({ outcome: 'refused', status: 401 }) }));
      expect((await deliverRemote(subscriptionId)).status).toBe(401);
      expect((await deliveries()).rows).toEqual([]);

      mockResolve.mockImplementation(async () => ({ adapterType: ADAPTER, checkInbound: async () => ({ outcome: 'accepted', events: [], arrivals: [] }) }));
      expect((await deliverRemote(subscriptionId)).status).toBe(200);
      const { rows } = await deliveries();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.judged_at).not.toBeNull();
    });
  });

  it('answers the provider an error, with nothing read and nothing kept, when the store cannot write', async () => {
    const subscriptionId = await attioSubscription(SECRET);
    await insertTestListen({ teamId, movementId, adapterType: 'attio', edge: 'Things', delivery: 'connection' });
    const preprocess = jest.fn(async () => ({ events: [], arrivals: [arrival('thing-1')] }));
    mockResolve.mockImplementation(async () => ({ adapterType: 'attio', preprocessInbound: preprocess }));
    const real = hostDeliveries.deliveryRowStore;
    jest.spyOn(hostDeliveries, 'deliveryRowStore').mockImplementation((owner) => ({ ...real(owner), keepRawDelivery: async () => { throw new Error('the database is down'); } }));

    const answer = await deliver({ subscriptionId, rawBody: bodyOf('down'), keptFirst: true });

    expect(answer).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(preprocess).not.toHaveBeenCalled();
    expect((await deliveries()).rows).toEqual([]);
    expect(await workOf('fire_event')).toEqual([]);
    expect(await arrivals()).toEqual([]);
  });
});
