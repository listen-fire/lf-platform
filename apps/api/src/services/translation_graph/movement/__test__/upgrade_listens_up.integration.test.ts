// A failed step after an upgrade commits is never silent (real Postgres, the
// real upgrade and save, the real drain; the vendor and the listen's plan
// faked). The credential is unusable when the upgrade lands: the upgrade still
// answers `upgraded`, its work row retries, an issue says so while it fails, and
// when the credential comes back the automation receives events.

import { randomUUID } from 'node:crypto';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { AdapterManifest } from 'movement-engine/public/adapter';

const VENDOR = 'acme_vendor';

const credential = { usable: false };
/** Whether the planned listen lists its members before it subscribes. */
const plan = { resolved: false };

const vendor = {
  ensureEventSubscription: jest.fn(async (_input: unknown) => ({ externalId: 'ext-1', secret: 'vendor-secret' })),
  removeEventSubscription: jest.fn(async (_input: unknown) => {}),
};

jest.mock('../../../credentials/credential_lifecycle', () => ({ credentialLifecycle: () => undefined }));
jest.mock('../../../../lib/slack', () => ({ sendSlackNotification: async () => undefined }));
jest.mock('../../adapters/team_manifests', () => ({
  ...jest.requireActual('../../adapters/team_manifests'),
  teamAdapterManifestSet: async () => ({
    manifests: [
      { adapterType: VENDOR, displayName: VENDOR, supportedTriggers: ['webhook'], methods: ['ensureEventSubscription', 'removeEventSubscription'] },
    ] as unknown as AdapterManifest[],
    remoteSlugs: new Set<string>(),
    remoteDegraded: false,
  }),
}));
jest.mock('../../adapters/resolve', () => {
  const actual = jest.requireActual('../../adapters/resolve');
  return {
    ...actual,
    resolveAdapter: async (input: { adapterType: string }) => {
      if (input.adapterType !== VENDOR) return actual.resolveAdapter(input);
      if (!credential.usable) throw new Error('the credential needs reconnecting');
      return vendor;
    },
  };
});
// The program is saved for real; only the plan of its one listen is the vendor's,
// since checking a listen on a module needs that module's catalog.
jest.mock('../listen_plans', () => {
  const actual = jest.requireActual('../listen_plans');
  return {
    ...actual,
    plannedListensOfSource: () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { testListenConfig } = require('../../../../test/harness/listens');
      const listen = testListenConfig({ adapterType: VENDOR, edge: 'Things', delivery: 'connection', movement: 'stamp' }, 'a1b2c3d4');
      return { listens: [plan.resolved ? { ...listen, resolvedHops: [{ hop: 0, membersChange: 'pushed' }] } : listen], refused: [] };
    },
  };
});

jest.mock('../../../inbound/listen_resolve', () => {
  const actual = jest.requireActual('../../../inbound/listen_resolve');
  return { ...actual, resolveAndArm: jest.fn(async () => null) };
});

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { insertTestListen } from '../../../../test/harness/listens';
import { deliverArrivals } from '../../../inbound/listen_door';
import { resolveAndArm } from '../../../inbound/listen_resolve';
import { claimDueWork } from '../../../work/store';
import { drainWork, resetWorkHandlersForTests } from '../../../work/drain';
import { advanceLive, upgradeMovement, type Advance, type ValidateUnder } from '../language_upgrade';
import { listensOfSubscription, MOVEMENT_LISTEN_PROVISIONER } from '../listen_subscriptions';
import { registerBringUpListensWork } from '../listens_up';
import { mintMovementVersionIfChanged } from '../version_store';

const SOURCE = 'function stamp(go: <manual-[:Invocations]->>) {\n}\n\nlisten to manual-[:Invocations]-> fire stamp\n';
const clean: ValidateUnder = async () => ({ ok: true, diagnostics: [], listenerCount: 0, firedMovements: [], catalogNotes: [], gaps: [] });
const savedApiBaseUrl = process.env.API_BASE_URL;

let teamId: TeamId;
// Each pass looks far enough ahead that the row's backoff has passed.
let clockMs = Date.now();

const pass = async () => {
  clockMs += 3_600_000;
  const at = new Date(clockMs);
  return drainWork({ teamId, now: () => at });
};

async function seedShipped(name: string): Promise<string> {
  const id = randomUUID();
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    .values({ id: id as MovementId, team_id: teamId, name, source: SOURCE, description: '', language_version: '0.12.13' })
    .execute();
  await mintMovementVersionIfChanged({ teamId, movementId: id, source: SOURCE, languageVersion: '0.12.13' });
  return id;
}

const workRows = (id: string) =>
  getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('key', '=', `bring_up_listens:${id}`).select(['id', 'attempts']).execute();

const issues = (id: string) =>
  getAutomationsQb(['movement_issue'])
    .selectFrom('movement_issue')
    .where('movement_id', '=', id as MovementId)
    .select(['state', 'failure_class', 'message'])
    .execute();

const subscriptions = () =>
  getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', teamId)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .select(['id', 'status', 'subscriptions'])
    .execute();

beforeAll(async () => {
  process.env.API_BASE_URL = savedApiBaseUrl ?? 'https://platform.example.test';
  resetWorkHandlersForTests();
  registerBringUpListensWork();
});

beforeEach(async () => {
  plan.resolved = false;
  jest.mocked(resolveAndArm).mockResolvedValue(null);
  credential.usable = false;
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `up-${teamId.slice(0, 8)}` }).execute();
});

afterEach(async () => {
  vendor.ensureEventSubscription.mockImplementation(async () => ({ externalId: 'ext-1', secret: 'vendor-secret' }));
  await getAutomationsQb(['webhook_subscription']).deleteFrom('webhook_subscription').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

afterAll(() => {
  if (savedApiBaseUrl === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = savedApiBaseUrl;
});

describe('an upgraded automation whose listens could not be brought up', () => {
  it('answers upgraded, retries, raises an issue while failing, and receives events once the credential is back', async () => {
    const id = await seedShipped('stamp');

    const result = await upgradeMovement({ teamId, id, acknowledge: true, validate: clean });

    expect(result.status).toBe('upgraded');
    expect(await workRows(id)).toHaveLength(1);

    // Failing, the row stays and counts; a first failure may be a blip.
    expect((await pass()).failed).toBe(1);
    expect((await pass()).failed).toBe(1);
    expect(await workRows(id)).toEqual([expect.objectContaining({ attempts: 2 })]);
    expect(await issues(id)).toEqual([]);

    // By the third, an issue says so, keeping the note that says why.
    expect((await pass()).failed).toBe(1);
    expect(await issues(id)).toEqual([
      {
        state: 'open',
        failure_class: 'MOV_LISTENS_NOT_UP',
        message: expect.stringContaining(`${VENDOR}: subscribing for Things failed (the credential needs reconnecting)`),
      },
    ]);
    expect(await subscriptions()).toEqual([]);

    // The credential comes back: the row finishes and the issue closes.
    credential.usable = true;
    expect((await pass()).failed).toBe(0);
    expect(await workRows(id)).toEqual([]);
    expect(await issues(id)).toEqual([expect.objectContaining({ state: 'resolved' })]);

    // And what the vendor delivers at the subscription's URL reaches the listen.
    const [row] = await subscriptions();
    expect(row).toEqual(expect.objectContaining({ status: 'active' }));
    const listens = await listensOfSubscription({ teamId, adapterType: VENDOR, subscriptions: row!.subscriptions });
    expect(listens).toHaveLength(1);
    const arrival: Exclude<Arrival, { gone: true }> = {
      edge: 'Things',
      key: 'thing-1',
      identity: 'thing-1',
      landing: { recordId: 't1', recordType: 'Thing', fields: { Id: 't1' } },
    };
    const delivered = await deliverArrivals({
      teamId,
      delivered: { adapterType: VENDOR, credentialsId: null },
      subscriptionId: row!.id,
      externalId: null,
      source: 'webhook',
      arrivals: [arrival],
      listens: listens!,
    });
    expect(delivered.fires).toEqual([expect.objectContaining({ triggerId: listens![0]!.triggerId })]);
  });

  it('an instance that dies holding the row loses nothing: the lease lapses and it runs again', async () => {
    credential.usable = true;
    const id = await seedShipped('stamp');
    await upgradeMovement({ teamId, id, acknowledge: true, validate: clean });

    // Claimed and never finished, as by an instance stopped mid effect.
    expect(await claimDueWork({ owner: 'dying', limit: 10, leaseMs: 1, teamId })).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await pass()).toEqual(expect.objectContaining({ recovered: 1, failed: 0 }));
    expect(await workRows(id)).toEqual([]);
    expect(await subscriptions()).toEqual([expect.objectContaining({ status: 'active' })]);
  });

  it('a rollback leaves nothing owed for a listen that lists its members: no listing, no provider, no state, no rows', async () => {
    plan.resolved = true;
    credential.usable = true;
    const id = await seedShipped('stamp');
    const stopsAfterSaving: Advance = async (input) => {
      const move = await advanceLive(input);
      return async () => {
        expect(await move()).toEqual({ ok: true });
        return { ok: false, detail: 'a later member refused' };
      };
    };

    const result = await upgradeMovement({ teamId, id, acknowledge: true, validate: clean, advance: stopsAfterSaving });

    expect(result).toEqual(expect.objectContaining({ status: 'unverified' }));
    await pass();
    expect(resolveAndArm).not.toHaveBeenCalled();
    expect(vendor.ensureEventSubscription).not.toHaveBeenCalled();
    expect(await workRows(id)).toEqual([]);
    expect(await getAutomationsQb(['trigger']).selectFrom('trigger').where('movement_id', '=', id as MovementId).select('id').execute()).toEqual([]);
    expect(await getAutomationsQb(['listen_state']).selectFrom('listen_state').where('team_id', '=', teamId as never).select('pipeline').execute()).toEqual([]);
  });

  it('a listen whose members could not be listed fails the row and says why, and is listed before it subscribes', async () => {
    plan.resolved = true;
    credential.usable = true;
    const id = await seedShipped('stamp');
    await upgradeMovement({ teamId, id, acknowledge: true, validate: clean });
    expect(resolveAndArm).not.toHaveBeenCalled();
    jest.mocked(resolveAndArm).mockResolvedValue('LISTEN_RESOLVE_FAILED: it could not list the records it watches');

    for (let failing = 0; failing < 3; failing++) expect((await pass()).failed).toBe(1);

    expect(await issues(id)).toEqual([expect.objectContaining({ state: 'open', message: expect.stringContaining('LISTEN_RESOLVE_FAILED') })]);

    jest.mocked(resolveAndArm).mockResolvedValue(null);
    expect((await pass()).failed).toBe(0);
    expect(await workRows(id)).toEqual([]);
    expect(await issues(id)).toEqual([expect.objectContaining({ state: 'resolved' })]);
    const [listed] = jest.mocked(resolveAndArm).mock.invocationCallOrder;
    const [subscribed] = vendor.ensureEventSubscription.mock.invocationCallOrder;
    expect(listed).toBeLessThan(subscribed!);
  });

  it("another automation's failing listen neither holds this row nor raises an issue here", async () => {
    credential.usable = true;
    vendor.ensureEventSubscription.mockImplementation(async (input: unknown) => {
      if ((input as { edge: string }).edge === 'Others') throw new Error('refused for the other edge');
      return { externalId: 'ext-1', secret: 'vendor-secret' };
    });
    const other = await seedShipped('other');
    await insertTestListen({ teamId, movementId: other as MovementId, adapterType: VENDOR, edge: 'Others', delivery: 'connection', movement: 'other' });
    const id = await seedShipped('stamp');
    await upgradeMovement({ teamId, id, acknowledge: true, validate: clean });

    expect((await pass()).failed).toBe(0);

    expect(await workRows(id)).toEqual([]);
    expect(await issues(id)).toEqual([]);
    expect(await issues(other)).toEqual([]);
  });
});
