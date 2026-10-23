// What a switch does to a team's vendor registrations (real DB, the real
// switch, subscription sync and poll worker; a fake vendor). Switched to lf,
// the team's webhook is deregistered at the vendor and its provisioned row
// retired, and its poll is neither pulled nor kept armed. Switched back, the
// webhook is registered afresh and the first poll starts a new mark rather
// than replaying what lf handled.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { AdapterManifest } from 'movement-engine/public/adapter';
import type { PollSource } from '../../translation_graph/poll_source';

const VENDOR = 'acme_vendor';
const VENDOR_POLL = 'acme_vendor_poll';

const vendor = {
  ensureEventSubscription: jest.fn(async (_input: unknown) => ({ externalId: `ext-${randomUUID().slice(0, 8)}`, secret: 'vendor-secret' })),
  removeEventSubscription: jest.fn(async (_input: unknown) => {}),
};
const getEvents = jest.fn<ReturnType<PollSource['getEvents']>, Parameters<PollSource['getEvents']>>(async () => ({
  events: [],
  checkpoint: { mark: 'now' },
}));

const VENDOR_MANIFEST = {
  adapterType: VENDOR,
  displayName: 'Acme vendor',
  supportedTriggers: ['webhook'],
  methods: ['ensureEventSubscription', 'removeEventSubscription'],
  triggerKinds: ['ACME_VENDOR'],
  subscribableEvents: ['thing.created'],
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
jest.mock('../../translation_graph/adapters/registry', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/registry');
  return {
    ...actual,
    isPollSource: (kind: string) => kind === VENDOR_POLL || actual.isPollSource(kind),
    getPollSource: (input: { adapterType: string }) =>
      input.adapterType === VENDOR_POLL ? { pollIntervalSeconds: 60, getEvents } : actual.getPollSource(input),
  };
});

import { getAutomationsQb } from '../../../lib/kysely';
import { testWorkContext } from '../../../test/harness/work';
import { upsertMovementRow } from '../../translation_graph/movement/store';
import { MOVEMENT_LISTEN_PROVISIONER, syncListenSubscriptions } from '../../translation_graph/movement/listen_subscriptions';
import { pollReconcileHandler, pollSourceHandler, pollWorkKey } from '../../poll_source/worker';
import { listWorkByKind, removeWork } from '../../work/store';
import { switchTeamEngine } from '../switch';

let teamId: TeamId;
let pollTriggerId: TriggerId;
const savedApiBaseUrl = process.env.API_BASE_URL;

async function insertTrigger(movementId: MovementId, kind: string): Promise<TriggerId> {
  const row = await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    .values({ team_id: teamId, name: `hello:${kind}`, kind, movement_id: movementId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id as TriggerId;
}

/** The team's live (not retired) movement-provisioned subscriptions. */
const liveSubscriptions = () =>
  getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', teamId)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .select(['id', 'status', 'external_webhook_id'])
    .execute();

const pollMark = async () =>
  getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('id', '=', pollTriggerId)
    .select(['poll_checkpoint', 'poll_last_at'])
    .executeTakeFirstOrThrow();

const pollArmed = async () => (await listWorkByKind('poll_source')).some((row) => row.key === pollWorkKey(pollTriggerId));

const pollNow = () => pollSourceHandler.run({ triggerId: pollTriggerId }, testWorkContext(new Date()));

beforeAll(async () => {
  process.env.API_BASE_URL = savedApiBaseUrl ?? 'https://platform.example.test';
  teamId = randomUUID() as TeamId;
  const movement = await upsertMovementRow({ teamId, name: 'hello', source: 'function hello() {}\n' });
  const movementId = movement.id as MovementId;
  await insertTrigger(movementId, VENDOR);
  pollTriggerId = await insertTrigger(movementId, VENDOR_POLL);
});

afterAll(async () => {
  if (savedApiBaseUrl === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = savedApiBaseUrl;
  await removeWork({ key: pollWorkKey(pollTriggerId) });
  await getAutomationsQb(['webhook_subscription']).deleteFrom('webhook_subscription').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['team_engine']).deleteFrom('team_engine').where('team_id', '=', teamId).execute();
});

describe("a switch moves the team's vendor registrations with it", () => {
  it('on the platform the webhook is registered and the poll pulls', async () => {
    expect((await syncListenSubscriptions({ teamId })).notes).toEqual([]);
    expect(vendor.ensureEventSubscription).toHaveBeenCalledTimes(1);
    const [subscription] = await liveSubscriptions();
    expect(subscription).toEqual(expect.objectContaining({ status: 'active', external_webhook_id: expect.stringMatching(/^ext-/) }));

    await pollNow();
    expect(getEvents).toHaveBeenCalledTimes(1);
    expect((await pollMark()).poll_last_at).not.toBeNull();
  });

  it('switched to lf, the webhook is deregistered at the vendor and the poll scanner skips the team', async () => {
    const [registered] = await liveSubscriptions();
    jest.clearAllMocks();

    expect(await switchTeamEngine(teamId, { engine: 'lf', changedBy: null })).toEqual({ engine: 'lf', changed: true, notes: [] });

    expect(vendor.removeEventSubscription).toHaveBeenCalledTimes(1);
    expect(vendor.removeEventSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: registered.external_webhook_id, callbackUrl: expect.stringContaining(registered.id) }),
    );
    expect(vendor.ensureEventSubscription).not.toHaveBeenCalled();
    expect(await liveSubscriptions()).toEqual([]);

    // A save while lf-engined registers nothing either.
    expect((await syncListenSubscriptions({ teamId })).notes).toEqual([]);
    expect(vendor.ensureEventSubscription).not.toHaveBeenCalled();

    // The scheduled row pulls nothing and is not re-armed; the reconcile does not arm one.
    await pollNow();
    await pollReconcileHandler.run({}, testWorkContext(new Date()));
    expect(getEvents).not.toHaveBeenCalled();
    expect(await pollArmed()).toBe(false);
  });

  it('switched back, the webhook is registered afresh and the first poll starts a new mark', async () => {
    jest.clearAllMocks();

    expect(await switchTeamEngine(teamId, { engine: 'platform', changedBy: null })).toEqual({
      engine: 'platform',
      changed: true,
      notes: [],
    });

    expect(vendor.ensureEventSubscription).toHaveBeenCalledTimes(1);
    expect(await liveSubscriptions()).toEqual([expect.objectContaining({ status: 'active' })]);
    expect(await pollMark()).toEqual({ poll_checkpoint: null, poll_last_at: null });

    await pollReconcileHandler.run({}, testWorkContext(new Date()));
    expect(await pollArmed()).toBe(true);
    await pollNow();
    expect(getEvents).toHaveBeenCalledTimes(1);
    expect(getEvents.mock.calls[0][0].checkpoint).toBeUndefined();
  });
});
