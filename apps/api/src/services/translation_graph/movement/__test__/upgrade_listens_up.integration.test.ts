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
/** The edge a file's planned listen watches; a file not named watches Things. */
const edgeOf: Record<string, string> = {};

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
    plannedListensOfSource: (input: { file: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { testListenConfig } = require('../../../../test/harness/listens');
      const listen = testListenConfig({ adapterType: VENDOR, edge: edgeOf[input.file] ?? 'Things', delivery: 'connection', movement: input.file }, `${input.file}0000`.padStart(8, '0'));
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
import { claimResolve, saveResolution } from '../../../lf_store/listens';
import { recordMovementFailureIssue } from '../issues';
import { drainWork, resetWorkHandlersForTests } from '../../../work/drain';
import { advanceLive, upgradeMovement, type Advance, type ValidateUnder } from '../language_upgrade';
import { listensOfSubscription, MOVEMENT_LISTEN_PROVISIONER } from '../listen_subscriptions';
import { bringUpListensLater, registerBringUpListensWork } from '../listens_up';
import { mintMovementVersionIfChanged } from '../version_store';
import { StatementStore, type Target } from '../../../access/statement';

const SOURCE = 'function stamp(go: <manual-[:Invocations]->>) {\n}\n\nlisten to manual-[:Invocations]-> fire stamp\n';
const clean: ValidateUnder = async () => ({ ok: true, diagnostics: [], listenerCount: 0, firedMovements: [], catalogNotes: [], gaps: [] });
const savedApiBaseUrl = process.env.API_BASE_URL;

let teamId: TeamId;
// Each pass looks far enough ahead that the row's backoff has passed: at a
// stated number of minutes after the test began, or an hour after the last.
let startedAtMs = Date.now();
let clockMs = startedAtMs;

const pass = async (minutesIn?: number) => {
  clockMs = minutesIn === undefined ? clockMs + 3_600_000 : startedAtMs + minutesIn * 60_000;
  const at = new Date(clockMs);
  return drainWork({ teamId, now: () => at });
};

/** Passes at which a row failing since the test began has failed three times and
 *  is ten minutes old, which is when an issue is raised. */
const PASSES_TO_AN_ISSUE = [1, 5, 20];

async function seedShipped(name: string, source = SOURCE): Promise<string> {
  const id = randomUUID();
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    .values({ id: id as MovementId, team_id: teamId, name, source, description: '', language_version: '0.12.13' })
    .execute();
  await mintMovementVersionIfChanged({ teamId, movementId: id, source, languageVersion: '0.12.13' });
  // Every automation says who may fire it, one saved before statements by the
  // deploy's backfill; the vendor's door admits anyone.
  await StatementStore.replaceGrants({ thing: 'automation', id }, { teamId, verb: 'fire', grantees: [{ kind: 'anyone' }] });
  return id;
}

const LIBRARY = 'export function shout(before: <text>) {\n  return before\n}\n';
/** A listening member that imports the library, so the two members upgrade as one group. */
const memberSource = (name: string) => `import { shout } from "lib"\nfunction ${name}(go: <manual-[:Invocations]->>) {\n}\n\nlisten to manual-[:Invocations]-> fire ${name}\n`;

const workRows = (_id?: string) =>
  getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('kind', '=', 'bring_up_listens').select(['id', 'attempts', 'key']).execute();

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
  startedAtMs = Date.now();
  clockMs = startedAtMs;
  plan.resolved = false;
  for (const file of Object.keys(edgeOf)) delete edgeOf[file];
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
    // Off 0.12.13 its forced anyone is restated from its text, which constructs
    // no module, so the team. The vendor here says nothing of who acted, so the
    // person widens it again, as setAccess would.
    const automation = { thing: 'automation', id } satisfies Target<'automation'>;
    expect(await StatementStore.grantsOf(automation, { teamId, verb: 'fire' })).toEqual([{ kind: 'team' }]);
    await StatementStore.replaceGrants(automation, { teamId, verb: 'fire', grantees: [{ kind: 'anyone' }] });

    // Failing, the row stays and counts; a first failure may be a blip.
    expect(await pass(PASSES_TO_AN_ISSUE[0])).toEqual(expect.objectContaining({ failed: 0, deferred: 1 }));
    expect(await pass(PASSES_TO_AN_ISSUE[1])).toEqual(expect.objectContaining({ failed: 0, deferred: 1 }));
    expect(await workRows(id)).toEqual([expect.objectContaining({ attempts: 2 })]);
    expect(await issues(id)).toEqual([]);

    // Once it has failed for ten minutes, an issue says so, keeping the note that says why.
    expect(await pass(PASSES_TO_AN_ISSUE[2])).toEqual(expect.objectContaining({ failed: 0, deferred: 1 }));
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
    expect((await pass(30)).failed).toBe(0);
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
      return async (moving) => {
        expect(await move(moving)).toEqual({ ok: true });
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

    for (const minutes of PASSES_TO_AN_ISSUE) expect(await pass(minutes)).toEqual(expect.objectContaining({ failed: 0, deferred: 1 }));

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
  it('a group of two with one member failing: the healthy member comes up, the issue is on the failing one only, and clearing it closes that issue and no other', async () => {
    credential.usable = true;
    edgeOf['member_b'] = 'Others';
    vendor.ensureEventSubscription.mockImplementation(async (input: unknown) => {
      if ((input as { edge: string }).edge === 'Others') throw new Error('refused for the other edge');
      return { externalId: 'ext-1', secret: 'vendor-secret' };
    });
    await seedShipped('lib', LIBRARY);
    const healthy = await seedShipped('member_a', memberSource('member_a'));
    const failing = await seedShipped('member_b', memberSource('member_b'));
    // An issue of another class on the healthy member, which coming up must leave open.
    await recordMovementFailureIssue({ teamId, movementId: healthy, movementName: 'member_a', triggerName: 'member_a', message: 'MOV_UNRELATED: something else is wrong here' });

    expect((await upgradeMovement({ teamId, id: healthy, acknowledge: true, validate: clean })).status).toBe('upgraded');
    expect(await workRows()).toHaveLength(1);

    for (const minutes of PASSES_TO_AN_ISSUE) expect(await pass(minutes)).toEqual(expect.objectContaining({ failed: 0, deferred: 1 }));

    expect(vendor.ensureEventSubscription).toHaveBeenCalledWith(expect.objectContaining({ edge: 'Things' }));
    expect(await issues(healthy)).toEqual([expect.objectContaining({ state: 'open', failure_class: 'MOV_UNRELATED' })]);
    expect(await issues(failing)).toEqual([
      expect.objectContaining({ state: 'open', failure_class: 'MOV_LISTENS_NOT_UP', message: expect.stringContaining('subscribing for Others failed') }),
    ]);

    vendor.ensureEventSubscription.mockImplementation(async () => ({ externalId: 'ext-1', secret: 'vendor-secret' }));
    expect((await pass()).failed).toBe(0);

    expect(await workRows()).toEqual([]);
    expect(await issues(failing)).toEqual([expect.objectContaining({ state: 'resolved', failure_class: 'MOV_LISTENS_NOT_UP' })]);
    expect(await issues(healthy)).toEqual([expect.objectContaining({ state: 'open', failure_class: 'MOV_UNRELATED' })]);
  });
  it('an error that stops the bring up raises the issue once the row is ten minutes old, as a failed listen does, and coming up closes it', async () => {
    plan.resolved = true;
    credential.usable = true;
    const id = await seedShipped('stamp');
    await upgradeMovement({ teamId, id, acknowledge: true, validate: clean });
    jest.mocked(resolveAndArm).mockRejectedValue(new Error('the database dropped the connection'));

    // Thrown, not answered: the row fails and is retried, and the pulse is told.
    for (const minutes of PASSES_TO_AN_ISSUE.slice(0, 2)) expect(await pass(minutes)).toEqual(expect.objectContaining({ failed: 1 }));
    expect(await issues(id)).toEqual([]);
    expect(await pass(PASSES_TO_AN_ISSUE[2])).toEqual(expect.objectContaining({ failed: 1 }));

    expect(await issues(id)).toEqual([
      expect.objectContaining({ state: 'open', failure_class: 'MOV_LISTENS_NOT_UP', message: expect.stringContaining('the database dropped the connection') }),
    ]);

    jest.mocked(resolveAndArm).mockResolvedValue(null);
    expect((await pass()).failed).toBe(0);
    expect(await issues(id)).toEqual([expect.objectContaining({ state: 'resolved' })]);
  });

  it('a member that stays down is tried again without listing the healthy members again', async () => {
    plan.resolved = true;
    credential.usable = true;
    await seedShipped('lib', LIBRARY);
    const healthy = await seedShipped('member_a', memberSource('member_a'));
    await seedShipped('member_b', memberSource('member_b'));
    // The healthy member's listing is kept, as listing it for real keeps it; the other cannot be listed.
    jest.mocked(resolveAndArm).mockImplementation(async (listen) => {
      if (listen.file === 'member_b') return 'LISTEN_RESOLVE_FAILED: it could not list the records it watches';
      const scope = { tenant: listen.teamId };
      const held = await claimResolve(scope, { pipeline: listen.pipeline, ttlMs: 60_000 });
      await saveResolution(scope, { pipeline: listen.pipeline, token: held!.token, resolution: { heads: ['base1'], resolvedAt: new Date().toISOString(), failure: null } });
      return null;
    });
    await upgradeMovement({ teamId, id: healthy, acknowledge: true, validate: clean });

    for (const minutes of PASSES_TO_AN_ISSUE) expect(await pass(minutes)).toEqual(expect.objectContaining({ failed: 0, deferred: 1 }));

    const listed = jest.mocked(resolveAndArm).mock.calls.map(([listen]) => listen.file);
    expect(listed.filter((file) => file === 'member_a')).toHaveLength(1);
    expect(listed.filter((file) => file === 'member_b')).toHaveLength(3);
  });

  it("a listen another process is listing is not yet up: the row defers, looks again, and hears that process's failure", async () => {
    credential.usable = true;
    plan.resolved = true;
    const id = await seedShipped('held_elsewhere');
    // Another process holds the listen's resolve claim, and the real resolve meets it.
    jest.mocked(resolveAndArm).mockImplementation(async (listen) => {
      await claimResolve({ tenant: listen.teamId }, { pipeline: listen.pipeline, ttlMs: 60_000 });
      const { resolveAndArm: real } = jest.requireActual<typeof import('../../../inbound/listen_resolve')>('../../../inbound/listen_resolve');
      return real(listen);
    });
    await upgradeMovement({ teamId, id, acknowledge: true, validate: clean });

    expect(await pass(1)).toEqual(expect.objectContaining({ failed: 0, deferred: 1 }));
    expect(await workRows(id)).toEqual([expect.objectContaining({ attempts: 0 })]);
    expect(await issues(id)).toEqual([]);

    // That process failed. Looking again lists it here and hears the same failure.
    jest.mocked(resolveAndArm).mockResolvedValue('LISTEN_RESOLVE_FAILED: it could not list the records it watches');
    expect(await pass(11)).toEqual(expect.objectContaining({ failed: 0, deferred: 1 }));
    expect(await issues(id)).toEqual([expect.objectContaining({ state: 'open', failure_class: 'MOV_LISTENS_NOT_UP' })]);
  });

  it('a credential that is unusable only for seconds raises no issue however often it was tried, and one that stays so for ten minutes does', async () => {
    const id = await seedShipped('stamp');
    await upgradeMovement({ teamId, id, acknowledge: true, validate: clean });

    // Six attempts in the first minute: the drain backs off from a second, so these are what a blip looks like.
    for (const seconds of [1, 4, 9, 20, 40, 59]) expect(await pass(seconds / 60)).toEqual(expect.objectContaining({ failed: 0, deferred: 1 }));
    expect(await workRows(id)).toEqual([expect.objectContaining({ attempts: 6 })]);
    expect(await issues(id)).toEqual([]);

    expect(await pass(11)).toEqual(expect.objectContaining({ failed: 0, deferred: 1 }));
    expect(await issues(id)).toEqual([expect.objectContaining({ state: 'open', failure_class: 'MOV_LISTENS_NOT_UP' })]);
  });

  it('two groups that share a member each keep their own row and member list, and the same group asked twice keeps one', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const members = async () =>
      (await getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('kind', '=', 'bring_up_listens').select('payload').execute())
        .map((row) => (row.payload as { movementIds: string[] }).movementIds.slice().sort())
        .sort((x, y) => x.length - y.length);

    await bringUpListensLater({ teamId, movementIds: [a, b] });
    await bringUpListensLater({ teamId, movementIds: [a] });
    expect(await members()).toEqual([[a], [a, b].sort()]);

    await bringUpListensLater({ teamId, movementIds: [b, a] });
    expect(await members()).toEqual([[a], [a, b].sort()]);
  });
});
