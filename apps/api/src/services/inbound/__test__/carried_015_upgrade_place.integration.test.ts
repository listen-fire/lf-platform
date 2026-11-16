// An upgrade from 0.15 to this release keeps each polled listen's place (real
// Postgres, the real upgrade and the real poll worker). On 0.16 a 0.15 listen
// polls under its key naming version 0.15. The upgrade makes it this release's,
// and its key loses the version: another row's name, where v0.15.3 may have
// left its last cursor frozen, or nothing at all. The upgrade writes where the
// listen stood under the name it polls under now, so its first poll after it
// fires only what came after that place:
//
//   - a stale row under the unversioned name is never read (nothing replayed);
//   - with no row there, the listen does not arm (nothing lost);
//   - a listen that polls alone on a cursor it brought from 0.12 (Project A's
//     shape) the same;
//   - a schedule's tick due between its place and that poll fires once;
//   - a paused listen's place moves too;
//   - a 0.15 listen of another automation polling under the same key keeps
//     its own row: the place is copied.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { RELEASE_APPLIED } from '@listen-fire/system';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { ProvisioningService } from '../../provisioning';
import { inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { listWorkByKind, removeWork } from '../../work/store';
import { registerCarriedRunWork } from '../../translation_graph/movement/carried_run_now';
import { upgradeMovement } from '../../translation_graph/movement/language_upgrade';
import { saveMovement } from '../../translation_graph/movement/provision';
import { registerDispatchWork } from '../../translation_graph/triggers/dispatch_event';
import { automationsUrl, recordSystemEvent } from '../../translation_graph/adapters/system/events';
import { pollEdgeHandler, pollSubscriptionId, sharedPolls, type SharedPoll } from '../../poll_source/worker';
import { listenEdgeDigest, listenEdgeKeysOf } from '../listen_edge';
import { fireRowSchema, savedListens } from '../listen_door';

const SYSTEM_015 =
  'import { system } from adapters\nsys = connect system\n' +
  'function released(e: <sys-[:Events]->>) {\n  said = e.Reason\n  return said\n}\n' +
  'listen to sys-[e:Events WHERE e.Kind == "Release Applied"]-> fire released\n';

const HOURLY_015 =
  'import { cron } from adapters\nclock = connect cron\n' +
  'function tick(t: <clock-[:Tick]->>) {\n  at = t.`Fired at`\n  return at\n}\n' +
  'listen to clock-[t:Ticks WHERE t.Schedule == "0 * * * *"]-> fire tick\n';

const teams: TeamId[] = [];
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function newTeam(): Promise<TeamId> {
  const teamId = randomUUID() as TeamId;
  teams.push(teamId);
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `upgrade-place-${teamId.slice(0, 8)}` }).execute();
  await ProvisioningService.provisionUser({ teamId, email: `ada+${teamId.slice(0, 8)}@example.com`, access: 'admin' });
  return teamId;
}

/** A shipped 0.15.3 automation with one polled listen, and the two names its
 *  poll's cursor may be under on 0.16: its own, naming version 0.15, and the
 *  same key without it, where v0.15.3 kept it. `pollsAlone`: the row came up
 *  from 0.12 with its own cursor, as provisioning noted it (`carriedFrom`). */
async function shipped015(teamId: TeamId, options: { name: string; source: string; pollsAlone?: boolean }) {
  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: options.name, source: options.source, description: '', language_version: '0.15.3' }).execute();
  const saved = await saveMovement({ audience: { for: 'run' }, teamId, id: movementId, source: options.source });
  if (!saved.ok) throw new Error(`test: the 0.15 automation did not save: ${JSON.stringify(saved)}`);
  const triggerId = saved.listeners[0]!.triggerId as TriggerId;
  if (options.pollsAlone === true) {
    await sql`update automations.trigger set config = jsonb_set(config, '{listen,carriedFrom}', ${JSON.stringify({ at: '2026-11-04T10:00:00.000Z', pollsAlone: true })}::text::jsonb)
      where id = ${triggerId}::uuid`.execute(getAutomationsQb(['trigger']));
  }
  const poll = (await sharedPolls({ teamId })).find((shared) => shared.carried.some((listen) => listen.triggerId === triggerId));
  if (poll === undefined) throw new Error('test: the 0.15 listen shares no poll');
  expect(poll.key.version).toBe('0.15');
  if (options.pollsAlone === true) expect(poll.key.alone).toBe(triggerId);
  const versioned = pollSubscriptionId(poll.digest);
  const unversioned = pollSubscriptionId(listenEdgeDigest({ ...poll.key, version: undefined }));
  return { movementId, triggerId, versioned, unversioned };
}

async function upgrade(teamId: TeamId, movementId: MovementId): Promise<void> {
  const upgraded = await upgradeMovement({ teamId, id: movementId, acknowledge: true });
  expect(upgraded).toEqual(expect.objectContaining({ status: 'upgraded' }));
}

const triggersOf = async (movementId: MovementId) =>
  (await getAutomationsQb(['trigger']).selectFrom('trigger').where('movement_id', '=', movementId).select(['id', 'run_mode']).execute()).map((row) => ({ id: row.id as TriggerId, runMode: row.run_mode }));

/** The upgraded automation's one listen, and the name its poll's cursor is kept under now. */
async function upgradedListen(teamId: TeamId, movementId: MovementId) {
  const [listen, ...more] = await savedListens({ teamId, movementId });
  expect(more).toEqual([]);
  if (listen === undefined) throw new Error('test: the upgraded automation has no listen of this release');
  const [keyed, ...others] = listenEdgeKeysOf(listen, ['polled']);
  expect(others).toEqual([]);
  if (keyed === undefined) throw new Error('test: the upgraded listen is polled under no key');
  expect(keyed.key.version).toBeUndefined();
  return { triggerId: listen.triggerId, digest: keyed.digest, subscriptionId: pollSubscriptionId(keyed.digest) };
}

async function currentPollOf(teamId: TeamId, triggerId: TriggerId): Promise<SharedPoll> {
  const poll = (await sharedPolls({ teamId })).find((shared) => shared.listens.some((listen) => listen.triggerId === triggerId));
  if (poll === undefined) throw new Error('test: the upgraded listen shares no poll');
  return poll;
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

/** The receipts a 0.15 listen kept: its version judges a page into them. */
const receiptsOf = (triggerId: TriggerId) =>
  getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('trigger_id', '=', triggerId).select(['status']).orderBy('created_at').execute();

/** What the upgraded listen fired: each run the door queued for it, by the
 *  arrival it was for. */
async function firedFor(teamId: TeamId, triggerId: TriggerId): Promise<unknown[]> {
  const rows = await getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('kind', '=', 'fire_event').select('payload').execute();
  return rows.flatMap(({ payload }) => {
    const fire = fireRowSchema.parse(payload);
    return fire.triggerId === triggerId ? [fire.arrival.identity] : [];
  });
}

async function pollOnce(poll: SharedPoll): Promise<void> {
  await pollEdgeHandler.run({ teamId: poll.key.teamId, digest: poll.digest }, { now: new Date(), owner: 'upgrade-place', attempts: 1, heartbeat: async () => {} });
}

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

describe.each([
  { shape: 'a listen sharing its poll', pollsAlone: false },
  { shape: 'a listen polling alone on a cursor it brought from 0.12', pollsAlone: true },
])('an upgrade from 0.15 keeps the place of $shape (real Postgres)', ({ pollsAlone }) => {
  it('with a stale row under its unversioned name: its first poll after the upgrade fires only what came after its place', async () => {
    const teamId = await newTeam();
    const before = await shipped015(teamId, { name: 'releases', source: SYSTEM_015, pollsAlone });
    // Where the 0.15 listen stands on 0.16, and v0.15.3's frozen row behind it.
    const place = { releases: { at: minutesAgo(10), version: '' } };
    await keep(teamId, before.versioned, place);
    await keep(teamId, before.unversioned, { releases: { at: minutesAgo(60), version: '' } });
    // Heard already, between the frozen row and the place: replaying it would fire it again.
    await released(teamId, '0.15.9', minutesAgo(30));
    const after = minutesAgo(5);
    await released(teamId, '0.16.0', after);

    await upgrade(teamId, before.movementId);
    const listen = await upgradedListen(teamId, before.movementId);
    expect(releasesOf(await kept(teamId, listen.subscriptionId))).toEqual(place.releases);
    await pollOnce(await currentPollOf(teamId, listen.triggerId));

    expect(await firedFor(teamId, listen.triggerId)).toEqual([`${RELEASE_APPLIED.id}:0.16.0`]);
    expect(releasesOf(await kept(teamId, listen.subscriptionId))).toEqual({ at: after, version: '0.16.0' });
    // Nothing polls under the 0.15 name any more, and the frozen row is gone
    // rather than left for a later listen on that key to replay from.
    expect(await kept(teamId, before.versioned)).toBeUndefined();
    if (before.unversioned !== listen.subscriptionId) expect(await kept(teamId, before.unversioned)).toBeUndefined();
  });

  it('with no row under its unversioned name: its first poll after the upgrade fires what arrived after its place, not arming past it', async () => {
    const teamId = await newTeam();
    const before = await shipped015(teamId, { name: 'releases', source: SYSTEM_015, pollsAlone });
    await keep(teamId, before.versioned, { releases: { at: minutesAgo(10), version: '' } });
    const after = minutesAgo(5);
    await released(teamId, '0.16.0', after);

    await upgrade(teamId, before.movementId);
    const listen = await upgradedListen(teamId, before.movementId);
    await pollOnce(await currentPollOf(teamId, listen.triggerId));

    expect(await firedFor(teamId, listen.triggerId)).toEqual([`${RELEASE_APPLIED.id}:0.16.0`]);
    expect(releasesOf(await kept(teamId, listen.subscriptionId))).toEqual({ at: after, version: '0.16.0' });
  });

  it('upgraded before it polled on 0.16: the place v0.15.3 left, which its first carried poll would have taken over, is the one carried', async () => {
    const teamId = await newTeam();
    const before = await shipped015(teamId, { name: 'releases', source: SYSTEM_015, pollsAlone });
    const place = { releases: { at: minutesAgo(10), version: '' } };
    await keep(teamId, before.unversioned, place);
    const after = minutesAgo(5);
    await released(teamId, '0.16.0', after);

    await upgrade(teamId, before.movementId);
    const listen = await upgradedListen(teamId, before.movementId);
    expect(releasesOf(await kept(teamId, listen.subscriptionId))).toEqual(place.releases);
    await pollOnce(await currentPollOf(teamId, listen.triggerId));

    expect(await firedFor(teamId, listen.triggerId)).toEqual([`${RELEASE_APPLIED.id}:0.16.0`]);
    if (before.unversioned !== listen.subscriptionId) expect(await kept(teamId, before.unversioned)).toBeUndefined();
  });
});

describe('an upgrade from 0.15 keeps a polled listen’s place (real Postgres)', () => {
  it('a schedule: a tick due after its place and before its first poll after the upgrade fires once', async () => {
    const teamId = await newTeam();
    const before = await shipped015(teamId, { name: 'hourly', source: HOURLY_015 });
    const topOfHour = new Date();
    topOfHour.setUTCMinutes(0, 0, 0);
    // Its last poll was just before the hour's tick, which nothing has fired yet.
    await keep(teamId, before.versioned, new Date(topOfHour.getTime() - 30_000).toISOString());

    await upgrade(teamId, before.movementId);
    const listen = await upgradedListen(teamId, before.movementId);
    await pollOnce(await currentPollOf(teamId, listen.triggerId));

    expect(await firedFor(teamId, listen.triggerId)).toEqual([expect.stringContaining(topOfHour.toISOString())]);
  });

  it('a paused listen’s place moves with the upgrade, and the listen stays paused', async () => {
    const teamId = await newTeam();
    const before = await shipped015(teamId, { name: 'releases', source: SYSTEM_015 });
    const place = { releases: { at: minutesAgo(10), version: '' } };
    await keep(teamId, before.versioned, place);
    await getAutomationsQb(['trigger']).updateTable('trigger').set({ run_mode: 'off' }).where('id', '=', before.triggerId).execute();

    await upgrade(teamId, before.movementId);

    const listen = await upgradedListen(teamId, before.movementId);
    expect(await triggersOf(before.movementId)).toEqual([{ id: listen.triggerId, runMode: 'off' }]);
    expect((await kept(teamId, listen.subscriptionId))?.checkpoint).toEqual(place);
    expect(await kept(teamId, before.versioned)).toBeUndefined();
  });

  it('with another 0.15 automation polling under the same key, the place is copied: the other polls on from its own row', async () => {
    const teamId = await newTeam();
    const before = await shipped015(teamId, { name: 'releases', source: SYSTEM_015 });
    const other = await shipped015(teamId, { name: 'releases_too', source: SYSTEM_015 });
    expect(other.versioned).toBe(before.versioned);
    const place = { releases: { at: minutesAgo(10), version: '' } };
    await keep(teamId, before.versioned, place);
    const otherBefore = await kept(teamId, before.versioned);
    const after = minutesAgo(5);
    await released(teamId, '0.16.0', after);

    await upgrade(teamId, before.movementId);

    expect(await kept(teamId, before.versioned)).toEqual(otherBefore);
    const listen = await upgradedListen(teamId, before.movementId);
    await pollOnce(await currentPollOf(teamId, listen.triggerId));
    const carried = (await sharedPolls({ teamId })).find((shared) => shared.carried.some((one) => one.triggerId === other.triggerId));
    if (carried === undefined) throw new Error('test: the other 0.15 listen shares no poll');
    await pollOnce(carried);

    expect(await firedFor(teamId, listen.triggerId)).toEqual([`${RELEASE_APPLIED.id}:0.16.0`]);
    expect(await receiptsOf(other.triggerId)).toEqual([{ status: 'received' }]);
  });
});
