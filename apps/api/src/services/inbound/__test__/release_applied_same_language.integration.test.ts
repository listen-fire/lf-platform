// Two platform releases of one language version are two Release Applied
// events (real Postgres, the real upgrade and the real poll worker): a listen
// keeps one receipt per arrival, so were the events named by the language
// version alone, the second release would be swallowed as the first heard again.

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
import { pollEdgeHandler, pollSubscriptionId, sharedPolls } from '../../poll_source/worker';
import { listenEdgeKeysOf } from '../listen_edge';
import { fireRowSchema, savedListens } from '../listen_door';

const SYSTEM_015 =
  'import { system } from adapters\nsys = connect system\n' +
  'function released(e: <sys-[:Events]->>) {\n  said = e.Reason\n  return said\n}\n' +
  'listen to sys-[e:Events WHERE e.Kind == "Release Applied"]-> fire released\n';

const teams: TeamId[] = [];
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function newTeam(): Promise<TeamId> {
  const teamId = randomUUID() as TeamId;
  teams.push(teamId);
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `release-applied-${teamId.slice(0, 8)}` }).execute();
  await ProvisioningService.provisionUser({ teamId, email: `ada+${teamId.slice(0, 8)}@example.com`, access: 'admin' });
  return teamId;
}

/** A listen on Release Applied of this release, polling from a place a while back. */
async function releaseListen(teamId: TeamId) {
  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'releases', source: SYSTEM_015, description: '', language_version: '0.15.3' }).execute();
  const saved = await saveMovement({ audience: { for: 'run' }, teamId, id: movementId, source: SYSTEM_015 });
  if (!saved.ok) throw new Error(`test: the automation did not save: ${JSON.stringify(saved)}`);
  const upgraded = await upgradeMovement({ teamId, id: movementId, acknowledge: true });
  expect(upgraded).toEqual(expect.objectContaining({ status: 'upgraded' }));
  const [listen] = await savedListens({ teamId, movementId });
  const [keyed] = listen === undefined ? [] : listenEdgeKeysOf(listen, ['polled']);
  if (listen === undefined || keyed === undefined) throw new Error('test: the upgraded automation has no polled listen');
  await sql`insert into automations.inbound_checkpoint (team_id, subscription_id, checkpoint, updated_at)
    values (${teamId}::uuid, ${pollSubscriptionId(keyed.digest)}::text, ${JSON.stringify({ releases: { at: minutesAgo(60), version: '' } })}::text::jsonb, now() - interval '1 hour')`.execute(getAutomationsQb(['inbound_checkpoint']));
  return listen.triggerId as TriggerId;
}

/** A release as the deploy check records it. */
async function released(teamId: TeamId, input: { tag: string; version: string; at: string }): Promise<void> {
  await recordSystemEvent({
    teamId,
    kind: RELEASE_APPLIED,
    payload: { automation: '', automationId: '', runId: '', version: input.version, release: input.tag, reason: `Release ${input.tag} applied.`, url: automationsUrl(), at: input.at },
  });
}

/** The identities fired for the listen, sorted: the work rows come back in no order. */
async function firedFor(teamId: TeamId, triggerId: TriggerId): Promise<string[]> {
  const rows = await getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('kind', '=', 'fire_event').select('payload').execute();
  return rows
    .flatMap(({ payload }) => {
      const fire = fireRowSchema.parse(payload);
      return fire.triggerId === triggerId ? [String(fire.arrival.identity)] : [];
    })
    .sort();
}

async function pollOnce(teamId: TeamId, triggerId: TriggerId): Promise<void> {
  const poll = (await sharedPolls({ teamId })).find((shared) => shared.listens.some((listen) => listen.triggerId === triggerId));
  if (poll === undefined) throw new Error('test: the listen shares no poll');
  await pollEdgeHandler.run({ teamId, digest: poll.digest }, { now: new Date(), owner: 'release-applied', attempts: 1, heartbeat: async () => {} });
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

describe('a listen on Release Applied (real Postgres)', () => {
  it('hears a second release of the same language version, each named by its tag', async () => {
    const teamId = await newTeam();
    const triggerId = await releaseListen(teamId);

    await released(teamId, { tag: 'v0.16.1', version: '0.16.0', at: minutesAgo(30) });
    await pollOnce(teamId, triggerId);
    expect(await firedFor(teamId, triggerId)).toEqual(['release_applied:v0.16.1']);

    await released(teamId, { tag: 'v0.16.2', version: '0.16.0', at: minutesAgo(25) });
    await pollOnce(teamId, triggerId);
    expect(await firedFor(teamId, triggerId)).toEqual(['release_applied:v0.16.1', 'release_applied:v0.16.2']);

    await pollOnce(teamId, triggerId);
    expect(await firedFor(teamId, triggerId)).toHaveLength(2);
  });
});
