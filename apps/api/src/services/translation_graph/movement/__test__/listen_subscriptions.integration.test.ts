// Subscriptions per listenable edge (real DB, the real sync; the vendor
// faked). Listens on one pushed edge of one connection with the same taken
// filter share one subscription; another filter is another; the webhook door
// judges a subscription's deliveries by its listens only; a subscription no
// listen shares is removed by its edge; a 0.12 webhook is removed in its own
// form and never renewed; a remote that answers no secret is withdrawn and
// left pending, and the platform's retry asks it again.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { WebhookSubscriptionId } from '../../../../generated/kysely/automations/WebhookSubscription';
import type { AdapterManifest } from 'movement-engine/public/adapter';

const VENDOR = 'acme_vendor';
const REMOTE = 'acme_remote';

const vendor = {
  ensureEventSubscription: jest.fn(async (_input: unknown): Promise<{ externalId?: string; secret?: string } | undefined> => ({
    externalId: `ext-${randomUUID().slice(0, 8)}`,
    secret: 'vendor-secret',
  })),
  removeEventSubscription: jest.fn(async (_input: unknown) => {}),
};

const manifest = (adapterType: string) => ({
  adapterType,
  displayName: adapterType,
  supportedTriggers: ['webhook'],
  methods: ['ensureEventSubscription', 'removeEventSubscription'],
});

jest.mock('../../adapters/team_manifests', () => ({
  teamAdapterManifestSet: async () => ({
    manifests: [manifest(VENDOR), manifest(REMOTE)] as unknown as AdapterManifest[],
    remoteSlugs: new Set([REMOTE]),
    remoteDegraded: false,
  }),
}));
jest.mock('../../adapters/resolve', () => {
  const actual = jest.requireActual('../../adapters/resolve');
  return {
    ...actual,
    resolveAdapter: async (input: { adapterType: string }) => (input.adapterType === VENDOR || input.adapterType === REMOTE ? vendor : actual.resolveAdapter(input)),
  };
});

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { insertTestListen, takenEquals } from '../../../../test/harness/listens';
import { listensOfSubscription, MOVEMENT_LISTEN_PROVISIONER, retryListenSubscriptions, syncListenSubscriptions } from '../listen_subscriptions';

let teamId: TeamId;
let movementId: MovementId;
const savedApiBaseUrl = process.env.API_BASE_URL;

const liveRows = () =>
  getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', teamId)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .select(['id', 'provider', 'status', 'subscriptions', 'external_webhook_id', 'webhook_secret'])
    .orderBy('created_at')
    .execute();

/** The live row subscribed for the listens taking `status == value`: rows
 *  made in one sync share a creation instant, so their order says nothing. */
const rowTaking = async (value: string) =>
  (await liveRows()).find((row) => JSON.stringify(row.subscriptions).includes(`"value":${JSON.stringify(value)}`));

beforeAll(async () => {
  process.env.API_BASE_URL = savedApiBaseUrl ?? 'https://platform.example.test';
  teamId = randomUUID() as TeamId;
  movementId = randomUUID() as MovementId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `subs-${teamId.slice(0, 8)}` }).execute();
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'subs', source: '' }).execute();
});

afterAll(async () => {
  if (savedApiBaseUrl === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = savedApiBaseUrl;
  await getAutomationsQb(['webhook_subscription']).deleteFrom('webhook_subscription').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

beforeEach(() => jest.clearAllMocks());

describe('subscriptions per listenable edge', () => {
  let open: TriggerId;
  let alsoOpen: TriggerId;
  let closed: TriggerId;

  it('subscribes once per edge and taken filter, by the edge and the filter', async () => {
    open = await insertTestListen({ teamId, movementId, adapterType: VENDOR, edge: 'Things', delivery: 'connection', taken: takenEquals('status', 'open'), movement: 'a' });
    alsoOpen = await insertTestListen({ teamId, movementId, adapterType: VENDOR, edge: 'Things', delivery: 'connection', taken: takenEquals('status', 'open'), movement: 'b' });
    closed = await insertTestListen({ teamId, movementId, adapterType: VENDOR, edge: 'Things', delivery: 'connection', taken: takenEquals('status', 'closed'), movement: 'c' });
    // Polled: never subscribed for.
    await insertTestListen({ teamId, movementId, adapterType: VENDOR, edge: 'Things', delivery: 'polled', movement: 'd' });

    expect((await syncListenSubscriptions({ teamId })).notes).toEqual([]);

    const rows = await liveRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'active' && row.webhook_secret === 'vendor-secret')).toBe(true);
    expect(vendor.ensureEventSubscription.mock.calls.map(([input]) => input)).toEqual(
      expect.arrayContaining([
        { edge: 'Things', filter: takenEquals('status', 'open'), callbackUrl: expect.stringContaining((await rowTaking('open'))!.id) },
        { edge: 'Things', filter: takenEquals('status', 'closed'), callbackUrl: expect.stringContaining((await rowTaking('closed'))!.id) },
      ]),
    );

    // A second sync with nothing changed asks the built-in nothing.
    jest.clearAllMocks();
    expect((await syncListenSubscriptions({ teamId })).notes).toEqual([]);
    expect(vendor.ensureEventSubscription).not.toHaveBeenCalled();
  });

  it("judges what arrives at a subscription's URL by the listens sharing it only", async () => {
    const openRow = await rowTaking('open');
    const closedRow = await rowTaking('closed');
    const heard = async (subscriptions: unknown) =>
      (await listensOfSubscription({ teamId, adapterType: VENDOR, subscriptions }))?.map((listen) => listen.triggerId).sort();

    expect(await heard(openRow!.subscriptions)).toEqual([open, alsoOpen].sort());
    expect(await heard(closedRow!.subscriptions)).toEqual([closed]);
    // A row holding no edge's subscription (an operator's) is every listen's.
    expect(await heard([{ event_type: 'thing.created' }])).toBeUndefined();
  });

  it('removes a subscription no listen shares any more, by its edge, filter and external id', async () => {
    const closedRow = await rowTaking('closed');
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', '=', closed).execute();

    expect((await syncListenSubscriptions({ teamId })).notes).toEqual([]);

    expect(vendor.removeEventSubscription).toHaveBeenCalledWith({
      edge: 'Things',
      filter: takenEquals('status', 'closed'),
      callbackUrl: expect.stringContaining(closedRow!.id),
      externalId: closedRow!.external_webhook_id,
    });
    expect(await liveRows()).toHaveLength(1);
  });

  it('removes a webhook a 0.12 settings listen registered in its own form, and never renews it', async () => {
    const legacy = randomUUID();
    await getAutomationsQb(['webhook_subscription'])
      .insertInto('webhook_subscription')
      .values({
        id: legacy as WebhookSubscriptionId,
        team_id: teamId,
        provider: 'ACME_VENDOR',
        webhook_secret: 'old',
        external_webhook_id: 'ext-0-12',
        subscriptions: JSON.stringify([{ event_type: 'thing.created' }]),
        scope: JSON.stringify({ base: 'b1' }),
        status: 'active',
        provisioned_by: MOVEMENT_LISTEN_PROVISIONER,
      })
      .execute();

    expect(await retryListenSubscriptions()).toMatchObject({ teams: expect.any(Number) });

    expect(vendor.removeEventSubscription).toHaveBeenCalledWith({ callbackUrl: expect.stringContaining(legacy), externalId: 'ext-0-12', scope: { base: 'b1' } });
    expect(vendor.ensureEventSubscription).not.toHaveBeenCalled();
    expect((await liveRows()).map((row) => row.id)).not.toContain(legacy);
  });

  it('withdraws a remote registration that answers no secret, leaves it pending, and the retry registers it', async () => {
    vendor.ensureEventSubscription.mockResolvedValueOnce({ externalId: 'ext-nosecret' });
    await insertTestListen({ teamId, movementId, adapterType: REMOTE, edge: 'Things', delivery: 'connection', movement: 'e' });

    const { notes } = await syncListenSubscriptions({ teamId });

    expect(notes).toEqual([expect.stringContaining('remote adapter returned no secret')]);
    expect(vendor.removeEventSubscription).toHaveBeenCalledWith(expect.objectContaining({ edge: 'Things', externalId: 'ext-nosecret' }));
    const pending = (await liveRows()).find((row) => row.provider === 'ACME_REMOTE');
    expect(pending).toMatchObject({ status: 'pending', external_webhook_id: null });

    await retryListenSubscriptions();

    expect((await liveRows()).find((row) => row.id === pending!.id)).toMatchObject({ status: 'active', webhook_secret: 'vendor-secret' });
  });
});
