// What a switch does to a team's vendor registrations (real DB, the real
// switch, subscription sync and shared polls; a fake vendor). Switched to lf,
// the team's subscription is removed at the vendor and its row retired, and
// its poll is neither pulled nor kept armed. Switched back, the subscription
// is registered afresh and the first poll arms a new cursor rather than
// replaying what lf handled.

import { LANGUAGE_VERSION } from 'movement-lang';
import { randomUUID } from 'node:crypto';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { AdapterManifest } from 'movement-engine/public/adapter';
import type { PollEdgeInput } from 'module-kit';

const VENDOR = 'acme_vendor';
const VENDOR_POLL = 'acme_vendor_poll';

const vendor = {
  ensureEventSubscription: jest.fn(async (_input: unknown) => ({ externalId: `ext-${randomUUID().slice(0, 8)}`, secret: 'vendor-secret' })),
  removeEventSubscription: jest.fn(async (_input: unknown) => {}),
};
const polled = jest.fn<Promise<{ arrivals: Arrival[]; cursor?: unknown }>, [PollEdgeInput]>(async () => ({ arrivals: [], cursor: 'now' }));

const VENDOR_MANIFEST = {
  adapterType: VENDOR,
  displayName: 'Acme vendor',
  supportedTriggers: ['webhook'],
  methods: ['ensureEventSubscription', 'removeEventSubscription'],
} as unknown as AdapterManifest;

jest.mock('../../translation_graph/adapters/team_manifests', () => ({
  teamAdapterManifestSet: async () => ({ manifests: [VENDOR_MANIFEST], remoteSlugs: new Set<string>(), remoteDegraded: false }),
}));
jest.mock('../../translation_graph/adapters/resolve', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/resolve');
  return {
    ...actual,
    resolveAdapter: async (input: { adapterType: string }) => (input.adapterType === VENDOR ? vendor : actual.resolveAdapter(input)),
  };
});
jest.mock('../../poll_source/edge_poller', () => ({
  edgePollerOf: async (input: { adapterType: string }) => (input.adapterType === VENDOR_POLL ? polled : null),
}));

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen } from '../../../test/harness/listens';
import { testWorkContext } from '../../../test/harness/work';
import { MOVEMENT_LISTEN_PROVISIONER, syncListenSubscriptions } from '../../translation_graph/movement/listen_subscriptions';
import { pollEdgeHandler, pollReconcileHandler, pollWorkKey, sharedPolls } from '../../poll_source/worker';
import { listWorkByKind, removeWork } from '../../work/store';
import { forgetLfEngineTeams } from '../team_engine';
import { switchTeamEngine } from '../switch';

let teamId: TeamId;
let digest: string;
const savedApiBaseUrl = process.env.API_BASE_URL;

/** The team's live (not retired) movement-provisioned subscriptions. */
const liveSubscriptions = () =>
  getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', teamId)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .select(['id', 'status', 'external_webhook_id'])
    .execute();

const pollArmed = async () => (await listWorkByKind('poll_edge')).some((row) => row.key === pollWorkKey(digest));

const pollNow = () => pollEdgeHandler.run({ teamId, digest }, testWorkContext(new Date()));

beforeAll(async () => {
  process.env.API_BASE_URL = savedApiBaseUrl ?? 'https://platform.example.test';
  teamId = randomUUID() as TeamId;
  const movementId = randomUUID() as MovementId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `switch-${teamId.slice(0, 8)}` }).execute();
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'hello', source: '', language_version: LANGUAGE_VERSION }).execute();
  await insertTestListen({ teamId, movementId, adapterType: VENDOR, edge: 'Things', delivery: 'connection' });
  await insertTestListen({ teamId, movementId, adapterType: VENDOR_POLL, edge: 'Things', delivery: 'polled' });
  const [poll] = await sharedPolls({ teamId });
  if (poll === undefined) throw new Error('the polled listen shares no poll');
  digest = poll.digest;
});

afterAll(async () => {
  if (savedApiBaseUrl === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = savedApiBaseUrl;
  await removeWork({ key: pollWorkKey(digest) });
  await getAutomationsQb(['webhook_subscription']).deleteFrom('webhook_subscription').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['team_engine']).deleteFrom('team_engine').where('team_id', '=', teamId).execute();
  forgetLfEngineTeams();
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

describe("a switch moves the team's vendor registrations with it", () => {
  it('on the platform the edge is subscribed for and the poll pulls', async () => {
    expect((await syncListenSubscriptions({ teamId })).notes).toEqual([]);
    expect(vendor.ensureEventSubscription).toHaveBeenCalledTimes(1);
    const [subscription] = await liveSubscriptions();
    expect(subscription).toEqual(expect.objectContaining({ status: 'active', external_webhook_id: expect.stringMatching(/^ext-/) }));

    await pollNow();
    expect(polled).toHaveBeenCalledTimes(1);
    expect(await pollArmed()).toBe(true);
  });

  it('switched to lf, the subscription is removed at the vendor and the team is not polled', async () => {
    const [registered] = await liveSubscriptions();
    jest.clearAllMocks();

    expect(await switchTeamEngine(teamId, { engine: 'lf', changedBy: null })).toEqual({ engine: 'lf', changed: true, notes: [] });
    forgetLfEngineTeams();

    expect(vendor.removeEventSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ edge: 'Things', externalId: registered!.external_webhook_id, callbackUrl: expect.stringContaining(registered!.id) }),
    );
    expect(vendor.ensureEventSubscription).not.toHaveBeenCalled();
    expect(await liveSubscriptions()).toEqual([]);

    // A save while lf-engined registers nothing either.
    expect((await syncListenSubscriptions({ teamId })).notes).toEqual([]);
    expect(vendor.ensureEventSubscription).not.toHaveBeenCalled();

    // The armed row pulls nothing and is not re-armed; the reconcile removes it.
    await pollNow();
    await pollReconcileHandler.run({}, testWorkContext(new Date()));
    expect(polled).not.toHaveBeenCalled();
    expect(await pollArmed()).toBe(false);
  });

  it('switched back, the edge is subscribed for afresh and the first poll arms a new cursor', async () => {
    jest.clearAllMocks();

    expect(await switchTeamEngine(teamId, { engine: 'platform', changedBy: null })).toEqual({ engine: 'platform', changed: true, notes: [] });
    forgetLfEngineTeams();

    expect(vendor.ensureEventSubscription).toHaveBeenCalledTimes(1);
    expect(await liveSubscriptions()).toEqual([expect.objectContaining({ status: 'active' })]);

    await pollReconcileHandler.run({}, testWorkContext(new Date()));
    expect(await pollArmed()).toBe(true);
    await pollNow();
    expect(polled).toHaveBeenCalledTimes(1);
    expect(polled.mock.calls[0]![0].cursor).toBeUndefined();
  });
});
