// A carried listen keeps its poll's place across the upgrade (real Postgres,
// the real poll worker): on 0.15.3 a 0.15 listen was the current version's,
// so its poll's cursor is kept under its key without a version. On 0.16 the
// same listen is carried, and its key names version 0.15, which renames the
// cursor. Its first carried poll takes the old cursor over and fires what was
// stored after it (here a `Release Applied` the deploy check stored), instead
// of arming past it. The old row is left as it was; a cursor under the new
// name always wins; with neither, the first poll still only arms.

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
import { saveMovement } from '../../translation_graph/movement/provision';
import { registerDispatchWork } from '../../translation_graph/triggers/dispatch_event';
import { automationsUrl, recordSystemEvent } from '../../translation_graph/adapters/system/events';
import { pollEdgeHandler, pollSubscriptionId, sharedPolls, type SharedPoll } from '../../poll_source/worker';
import { listenEdgeDigest } from '../listen_edge';

const SYSTEM_015 =
  'import { system } from adapters\nsys = connect system\n' +
  'function released(e: <sys-[:Events]->>) {\n  said = e.Reason\n  return said\n}\n' +
  'listen to sys-[e:Events WHERE e.Kind == "Release Applied"]-> fire released\n';

const teams: TeamId[] = [];
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A team with one 0.15 listen on the platform's `Release Applied`, its poll,
 *  and the two names its cursor may be kept under: its own, which names
 *  version 0.15, and the one it polled under while 0.15 was current. */
async function carriedReleaseListen() {
  const teamId = randomUUID() as TeamId;
  teams.push(teamId);
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `carried-place-${teamId.slice(0, 8)}` }).execute();
  await ProvisioningService.provisionUser({ teamId, email: `ada+${teamId.slice(0, 8)}@example.com`, access: 'admin' });
  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'releases', source: SYSTEM_015, description: '', language_version: '0.15.3' }).execute();
  const saved = await saveMovement({ audience: { for: 'run' }, teamId, id: movementId, source: SYSTEM_015 });
  if (!saved.ok) throw new Error(`test: the 0.15 automation did not save: ${JSON.stringify(saved)}`);
  const triggerId = saved.listeners[0]!.triggerId as TriggerId;

  const poll = (await sharedPolls({ teamId })).find((shared) => shared.carried.some((listen) => listen.triggerId === triggerId));
  if (poll === undefined) throw new Error('test: the 0.15 listen shares no poll');
  // The key as 0.15.3 built it for the then current listen, written out: the
  // filter part 0.15's planner hands the module, as the row keeps it.
  const taken = { type: 'compare', op: 'eq', left: { type: 'edge_property', propertyTypeId: 'Kind', fieldOnly: true }, right: { type: 'static', value: 'Release Applied' } };
  const asCurrent = { teamId, adapterType: 'system', credentialsId: null, constructionArgs: undefined, edge: 'Events', taken };
  expect(poll.key).toEqual({ ...asCurrent, version: '0.15' });
  const ownId = pollSubscriptionId(poll.digest);
  const oldId = pollSubscriptionId(listenEdgeDigest(asCurrent));
  expect(oldId).not.toBe(ownId);
  return { teamId, triggerId, poll, ownId, oldId };
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
  it('a 0.15 listen whose cursor 0.15.3 kept under its unversioned key fires what was stored after it on its first 0.16 poll', async () => {
    const { teamId, triggerId, poll, ownId, oldId } = await carriedReleaseListen();
    // As v0.15.3 left it: the 0.15 module's cursor under the unversioned key.
    const left = { releases: { at: minutesAgo(10), version: '' } };
    await keep(teamId, oldId, left);
    const oldBefore = await kept(teamId, oldId);
    // The deploy check stored the release between the last 0.15.3 poll and the first 0.16 one.
    const at = minutesAgo(5);
    await released(teamId, '0.16.0', at);

    await pollOnce(poll);

    expect(await receiptsOf(triggerId)).toEqual([{ status: 'received' }]);
    // The cursor moved on under the new name; the old row is as it was.
    // (A poll marks every other kind its cursor lacks, as 0.15's module arms them.)
    expect((await kept(teamId, ownId))?.checkpoint).toEqual(expect.objectContaining({ releases: { at, version: '0.16.0' } }));
    expect(await kept(teamId, oldId)).toEqual(oldBefore);

    // Adopted once: the next poll reads its own row, and fires nothing again.
    await pollOnce(poll);
    expect(await receiptsOf(triggerId)).toEqual([{ status: 'received' }]);
  });

  it('a carried listen with a cursor under its own name never reads the old one, even an armed one', async () => {
    const { teamId, triggerId, poll, ownId, oldId } = await carriedReleaseListen();
    await keep(teamId, oldId, { releases: { at: minutesAgo(10), version: '' } });
    // Its own first poll armed after the release was stored.
    const armed = { releases: { at: minutesAgo(2), version: '' } };
    await keep(teamId, ownId, armed);
    await released(teamId, '0.16.0', minutesAgo(5));

    await pollOnce(poll);

    expect(await receiptsOf(triggerId)).toEqual([]);
    expect((await kept(teamId, ownId))?.checkpoint).toEqual(expect.objectContaining(armed));
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
