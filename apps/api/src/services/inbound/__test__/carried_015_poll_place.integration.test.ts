// A carried listen keeps its poll's place across the upgrade (real Postgres,
// the real poll worker): on 0.15.3 a 0.15 listen was the current version's,
// so its poll's cursor is kept under its key without a version. On 0.16 the
// same listen is carried, and its key is 0.15.3's key naming version 0.15,
// which renames the cursor. Its first carried poll takes the old cursor over
// and fires what was stored after it (here a `Release Applied` the deploy check
// stored), instead of arming past it:
//
//   - with no current listen polling under the old key, the cursor is moved,
//     so an upgrade of the listen later never finds it again;
//   - with one, it is copied, and each polls from its own row;
//   - a listen that brought its own cursor from an earlier version (it polls
//     alone) is found under 0.15.3's key for it too, and under v0.16.0's
//     first, which named it without `alone`;
//   - a cursor under the new name always wins; with neither, the first poll
//     still only arms.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { LANGUAGE_VERSION } from 'movement-lang';
import { RELEASE_APPLIED } from '@listen-fire/system';

import type { PlanHop } from 'engine-contracts';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen } from '../../../test/harness/listens';
import { ProvisioningService } from '../../provisioning';
import { inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { listWorkByKind, removeWork } from '../../work/store';
import { registerCarriedRunWork } from '../../translation_graph/movement/carried_run_now';
import { saveMovement } from '../../translation_graph/movement/provision';
import { registerDispatchWork } from '../../translation_graph/triggers/dispatch_event';
import { automationsUrl, recordSystemEvent } from '../../translation_graph/adapters/system/events';
import { pollEdgeHandler, pollShared, pollSubscriptionId, sharedPolls, type SharedPoll } from '../../poll_source/worker';
import { listenEdgeDigest } from '../listen_edge';

const SYSTEM_015 =
  'import { system } from adapters\nsys = connect system\n' +
  'function released(e: <sys-[:Events]->>) {\n  said = e.Reason\n  return said\n}\n' +
  'listen to sys-[e:Events WHERE e.Kind == "Release Applied"]-> fire released\n';

/** The filter part 0.15's planner hands the module, as the row keeps it. */
const TAKEN: NonNullable<PlanHop['taken']> = { type: 'compare', op: 'eq', left: { type: 'edge_property', propertyTypeId: 'Kind', fieldOnly: true }, right: { type: 'static', value: 'Release Applied' } };

const teams: TeamId[] = [];
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function carriedPollOf(teamId: TeamId, triggerId: TriggerId): Promise<SharedPoll> {
  const poll = (await sharedPolls({ teamId })).find((shared) => shared.carried.some((listen) => listen.triggerId === triggerId));
  if (poll === undefined) throw new Error('test: the 0.15 listen shares no poll');
  return poll;
}

/** A team with one 0.15 listen on the platform's `Release Applied`, its poll,
 *  and the two names its cursor may be kept under: its own, which names
 *  version 0.15, and the one it polled under while 0.15 was current.
 *  `pollsAlone`: the row came up from an earlier version with its own cursor,
 *  as provisioning noted it (`carriedFrom`). */
async function carriedReleaseListen(options: { pollsAlone?: boolean } = {}) {
  const teamId = randomUUID() as TeamId;
  teams.push(teamId);
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `carried-place-${teamId.slice(0, 8)}` }).execute();
  await ProvisioningService.provisionUser({ teamId, email: `ada+${teamId.slice(0, 8)}@example.com`, access: 'admin' });
  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'releases', source: SYSTEM_015, description: '', language_version: '0.15.3' }).execute();
  const saved = await saveMovement({ audience: { for: 'run' }, teamId, id: movementId, source: SYSTEM_015 });
  if (!saved.ok) throw new Error(`test: the 0.15 automation did not save: ${JSON.stringify(saved)}`);
  const triggerId = saved.listeners[0]!.triggerId as TriggerId;
  if (options.pollsAlone === true) {
    await sql`update automations.trigger set config = jsonb_set(config, '{listen,carriedFrom}', ${JSON.stringify({ at: '2026-11-04T10:00:00.000Z', pollsAlone: true })}::text::jsonb)
      where id = ${triggerId}::uuid`.execute(getAutomationsQb(['trigger']));
  }

  const poll = await carriedPollOf(teamId, triggerId);
  // The key as 0.15.3 built it for the then current listen, written out.
  const asCurrent = { teamId, adapterType: 'system', credentialsId: null, constructionArgs: undefined, edge: 'Events', taken: TAKEN, ...(options.pollsAlone === true ? { alone: triggerId } : {}) };
  expect(poll.key).toEqual({ ...asCurrent, version: '0.15' });
  const ownId = pollSubscriptionId(poll.digest);
  const oldId = pollSubscriptionId(listenEdgeDigest(asCurrent));
  expect(oldId).not.toBe(ownId);
  return { teamId, movementId, triggerId, poll, ownId, oldId, oldDigest: listenEdgeDigest(asCurrent) };
}

async function keep(teamId: TeamId, subscriptionId: string, checkpoint: unknown): Promise<void> {
  await sql`insert into automations.inbound_checkpoint (team_id, subscription_id, checkpoint, updated_at)
    values (${teamId}::uuid, ${subscriptionId}::text, ${JSON.stringify(checkpoint)}::text::jsonb, now() - interval '1 hour')`.execute(getAutomationsQb(['inbound_checkpoint']));
}

async function kept(teamId: TeamId, subscriptionId: string): Promise<{ checkpoint: unknown; updatedAt: string } | undefined> {
  const { rows } = await sql<{ checkpoint: unknown; updatedAt: string }>`
    select checkpoint, updated_at::text as "updatedAt" from automations.inbound_checkpoint
    where team_id = ${teamId}::uuid and subscription_id = ${subscriptionId}::text`.execute(getAutomationsQb(['inbound_checkpoint']));
  return rows[0];
}

async function released(teamId: TeamId, version: string, at: string): Promise<void> {
  await recordSystemEvent({ teamId, kind: RELEASE_APPLIED, payload: { automation: '', automationId: '', runId: '', version, reason: `release ${version}`, url: automationsUrl(), at } });
}

const receiptsOf = (triggerId: TriggerId) =>
  getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('trigger_id', '=', triggerId).select(['status']).orderBy('created_at').execute();

/** One run of the poll worker's handler for the key, as the drain runs it. */
async function pollOnce(poll: SharedPoll): Promise<void> {
  await pollEdgeHandler.run({ teamId: poll.key.teamId, digest: poll.digest }, { now: new Date(), owner: 'carried-place', attempts: 1, heartbeat: async () => {} });
}

/** The release mark a checkpoint holds. A poll marks every other kind its
 *  cursor lacks, as 0.15's module arms them, so only this one is compared. */
function releasesOf(row: { checkpoint: unknown } | undefined): unknown {
  const checkpoint = row?.checkpoint;
  return typeof checkpoint === 'object' && checkpoint !== null ? Reflect.get(checkpoint, 'releases') : undefined;
}

beforeAll(() => {
  resetWorkHandlersForTests();
  registerDispatchWork();
  registerCarriedRunWork();
  setWorkNotifier({ notify() {} });
});

afterAll(async () => {
  setWorkNotifier(inProcessNotifier);
  resetWorkHandlersForTests();
  for (const row of await listWorkByKind('poll_edge')) if (teams.includes(row.teamId as TeamId)) await removeWork({ key: row.key });
  for (const teamId of teams) await cleanupTeam(teamId);
});

describe('a carried listen keeps its poll’s place across the upgrade (real Postgres)', () => {
  it('a 0.15 listen whose cursor 0.15.3 kept under its unversioned key fires what was stored after it on its first 0.16 poll; with no current listen there, the cursor is moved', async () => {
    const { teamId, triggerId, poll, ownId, oldId } = await carriedReleaseListen();
    // As v0.15.3 left it: the 0.15 module's cursor under the unversioned key.
    await keep(teamId, oldId, { releases: { at: minutesAgo(10), version: '' } });
    // The deploy check stored the release between the last 0.15.3 poll and the first 0.16 one.
    const at = minutesAgo(5);
    await released(teamId, '0.16.0', at);

    await pollOnce(poll);

    expect(await receiptsOf(triggerId)).toEqual([{ status: 'received' }]);
    // The cursor moved on under the new name, and the old row is gone.
    expect(releasesOf(await kept(teamId, ownId))).toEqual({ at, version: '0.16.0' });
    expect(await kept(teamId, oldId)).toBeUndefined();

    // Adopted once: the next poll reads its own row, and fires nothing again.
    await pollOnce(poll);
    expect(await receiptsOf(triggerId)).toEqual([{ status: 'received' }]);
  });

  it('a listen that polls alone on a cursor it brought finds it under 0.15.3’s key for it, and fires what was stored after it', async () => {
    const { teamId, movementId, triggerId, poll, ownId, oldId } = await carriedReleaseListen({ pollsAlone: true });
    await keep(teamId, oldId, { releases: { at: minutesAgo(10), version: '' } });
    const at = minutesAgo(5);
    await released(teamId, '0.16.0', at);

    await pollOnce(poll);

    expect(await receiptsOf(triggerId)).toEqual([{ status: 'received' }]);
    expect(releasesOf(await kept(teamId, ownId))).toEqual({ at, version: '0.16.0' });
    expect(await kept(teamId, oldId)).toBeUndefined();

    // A re-save under 0.15 keeps it polling alone, under the same key.
    const again = await saveMovement({ audience: { for: 'run' }, teamId, id: movementId, source: SYSTEM_015 });
    expect(again.ok).toBe(true);
    expect((await carriedPollOf(teamId, triggerId)).digest).toBe(poll.digest);
  });

  it('a first poll that fails after the cursor was taken over polls again from it: the old row stays moved, and the next poll fires what was stored after it', async () => {
    const { teamId, triggerId, poll, ownId, oldId } = await carriedReleaseListen();
    const old = { releases: { at: minutesAgo(10), version: '' } };
    await keep(teamId, oldId, old);
    const at = minutesAgo(5);
    await released(teamId, '0.16.0', at);

    const failing = jest.spyOn(poll.carried[0]!.lane, 'pollEdge').mockRejectedValueOnce(new Error("0.15's module could not be reached"));
    try {
      await expect(pollShared(poll)).rejects.toThrow('could not be reached');
    } finally {
      failing.mockRestore();
    }
    // Taken over before the module was asked: the place is under the new name, and the old row is gone.
    expect(await receiptsOf(triggerId)).toEqual([]);
    expect((await kept(teamId, ownId))?.checkpoint).toEqual(old);
    expect(await kept(teamId, oldId)).toBeUndefined();

    // The retry polls from the place taken over, so it fires what was stored after it, and does not arm.
    await pollOnce(poll);
    expect(await receiptsOf(triggerId)).toEqual([{ status: 'received' }]);
    expect(releasesOf(await kept(teamId, ownId))).toEqual({ at, version: '0.16.0' });
    expect(await kept(teamId, oldId)).toBeUndefined();
  });

  it('Project A’s history: a listen polling alone, its row frozen by v0.15.3 and polled on by v0.16.0, takes v0.16.0’s place on its first 0.16.1 poll', async () => {
    const { teamId, triggerId, poll, ownId, oldId } = await carriedReleaseListen({ pollsAlone: true });
    // v0.16.0 polled the carried listen under its key without `alone`.
    const v0160Id = pollSubscriptionId(listenEdgeDigest({ ...poll.key, alone: undefined }));
    expect(poll.earlier?.map(({ digest }) => pollSubscriptionId(digest))).toEqual([v0160Id, oldId]);
    await keep(teamId, oldId, { releases: { at: minutesAgo(60), version: '' } });
    // Heard by v0.16.0 already: from the frozen row it would fire again.
    await released(teamId, '0.15.9', minutesAgo(30));
    await keep(teamId, v0160Id, { releases: { at: minutesAgo(10), version: '' } });
    const after = minutesAgo(5);
    await released(teamId, '0.16.0', after);

    await pollOnce(poll);

    expect(await receiptsOf(triggerId)).toEqual([{ status: 'received' }]);
    expect(releasesOf(await kept(teamId, ownId))).toEqual({ at: after, version: '0.16.0' });
    // Nothing else polls under v0.16.0's name: the place moved.
    expect(await kept(teamId, v0160Id)).toBeUndefined();
  });

  it('with a current 0.16 listen polling under the old key, the cursor is copied: the old row is untouched, and each polls from its own', async () => {
    const { teamId, triggerId, poll, ownId, oldId, oldDigest } = await carriedReleaseListen();
    const currentMovement = randomUUID() as MovementId;
    await getAutomationsQb(['movement']).insertInto('movement').values({ id: currentMovement, team_id: teamId, name: 'current', source: '', language_version: LANGUAGE_VERSION }).execute();
    const current = await insertTestListen({ teamId, movementId: currentMovement, adapterType: 'system', edge: 'Events', delivery: 'polled', taken: TAKEN });
    const polls = await sharedPolls({ teamId });
    const own = polls.find((shared) => shared.listens.some((listen) => listen.triggerId === current));
    expect(own?.digest).toBe(oldDigest);
    if (own === undefined) return;
    const carried = await carriedPollOf(teamId, triggerId);
    expect(carried.earlier).toEqual([{ digest: oldDigest, polled: true }]);

    await keep(teamId, oldId, { releases: { at: minutesAgo(10), version: '' } });
    const oldBefore = await kept(teamId, oldId);
    const first = minutesAgo(5);
    await released(teamId, '0.16.0', first);

    // The carried listen first: it copies the cursor, and the old row is as it was.
    await pollOnce(poll);
    expect(await receiptsOf(triggerId)).toEqual([{ status: 'received' }]);
    expect(releasesOf(await kept(teamId, ownId))).toEqual({ at: first, version: '0.16.0' });
    expect(await kept(teamId, oldId)).toEqual(oldBefore);

    // The current listen polls from the old row, which is its own.
    expect(await pollShared(own)).toEqual(expect.objectContaining({ arrivals: 1, armed: false }));
    expect(releasesOf(await kept(teamId, oldId))).toEqual({ at: first, version: '0.16.0' });

    // Each goes on from its own row.
    const second = minutesAgo(3);
    await released(teamId, '0.16.1', second);
    await pollOnce(poll);
    expect(await pollShared(own)).toEqual(expect.objectContaining({ arrivals: 1, armed: false }));
    expect(await receiptsOf(triggerId)).toEqual([{ status: 'received' }, { status: 'received' }]);
    expect(releasesOf(await kept(teamId, ownId))).toEqual({ at: second, version: '0.16.1' });
    expect(releasesOf(await kept(teamId, oldId))).toEqual({ at: second, version: '0.16.1' });
  });

  it('a carried listen with a cursor under its own name never reads the old one, even an armed one', async () => {
    const { teamId, triggerId, poll, ownId, oldId } = await carriedReleaseListen();
    const old = { releases: { at: minutesAgo(10), version: '' } };
    await keep(teamId, oldId, old);
    // Its own first poll armed after the release was stored.
    const armed = { releases: { at: minutesAgo(2), version: '' } };
    await keep(teamId, ownId, armed);
    await released(teamId, '0.16.0', minutesAgo(5));

    await pollOnce(poll);

    expect(await receiptsOf(triggerId)).toEqual([]);
    expect(releasesOf(await kept(teamId, ownId))).toEqual(armed.releases);
    expect((await kept(teamId, oldId))?.checkpoint).toEqual(old);
  });

  it('a carried listen with no cursor under either name arms on its first poll and fires nothing', async () => {
    const { teamId, triggerId, poll, ownId, oldId } = await carriedReleaseListen();
    await released(teamId, '0.16.0', minutesAgo(5));

    await pollOnce(poll);

    expect(await receiptsOf(triggerId)).toEqual([]);
    expect(await kept(teamId, ownId)).toBeDefined();
    expect(await kept(teamId, oldId)).toBeUndefined();
  });
});
