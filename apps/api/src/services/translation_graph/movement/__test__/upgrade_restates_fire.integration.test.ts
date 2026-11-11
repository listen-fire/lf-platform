// Upgrading an automation off a carried pin restates its fire list (real
// Postgres, the real upgrade and move; the check and the chat module faked).
// On 0.12.13 its fire list said anyone because the pin forced it, and Slack's
// own check of registered users kept strangers out. On the current pin the
// fire list is the only check, so a Slack file's list becomes the team, the
// upgrade's answer says so, and a stranger's message is refused at the door
// afterwards while a member's still starts a run.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { LANGUAGE_VERSION } from 'movement-lang';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';

jest.mock('../../adapters/resolve', () => ({ resolveAdapter: jest.fn() }));

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { insertTestListen } from '../../../../test/harness/listens';
import { StatementStore, type Grantee, type Target } from '../../../access/statement';
import { keptPage } from '../../../inbound/captured_request';
import { deliverArrivals } from '../../../inbound/listen_door';
import { resolveAdapter as resolveAdapterImport } from '../../adapters/resolve';
import { advanceLive, upgradeMovement, type ValidateUnder } from '../language_upgrade';

const resolveAdapter = resolveAdapterImport as jest.Mock;

/** The module the listen's arrivals come through: who posted, by their address. */
const ADAPTER = 'chat_upgrade_test';
const ADDRESSES: Record<string, string> = { U1: 'ada@x.com', U9: 'eve@evil.com' };
const SLACK_LISTEN = 'chat = slack(credentials: `Slack`)';
const TEAM: Grantee[] = [{ kind: 'team' }];

const clean: ValidateUnder = async () => ({ diagnostics: [], gaps: [] });

let teamId: TeamId;
let movementId: MovementId;

const message = (user: string, key: string): Exclude<Arrival, { gone: true }> => ({
  edge: 'Things',
  key,
  identity: `${user}:${key}`,
  landing: { recordId: key, recordType: 'Thing', fields: { status: 'open' } },
  actor: { identifier: user, scheme: 'opaque', adapterType: ADAPTER, label: user, proven: true },
});

async function deliver(arrival: Exclude<Arrival, { gone: true }>) {
  return deliverArrivals({
    teamId,
    delivered: { adapterType: ADAPTER, credentialsId: null },
    subscriptionId: ADAPTER,
    externalId: null,
    source: 'webhook',
    arrivals: [arrival],
    request: keptPage({ adapterType: ADAPTER, credentialsId: null, arrivals: [arrival] }),
  });
}

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  movementId = randomUUID() as MovementId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `upfire-${teamId.slice(0, 8)}` }).execute();
  const ada = randomUUID() as UserId;
  await getCoreQb(['user']).insertInto('user').values({ id: ada, default_team_id: teamId, username: `ada-${teamId.slice(0, 8)}` }).execute();
  await getCoreQb(['user_email']).insertInto('user_email').values({ user_id: ada, email: 'ada@x.com' }).execute();
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    .values({ id: movementId, team_id: teamId, name: 'triage', source: SLACK_LISTEN, description: '', language_version: '0.12.13' })
    .execute();
  // As the backfill states a carried file: the team reads and writes it, and anyone fires it.
  const automation: Target<'automation'> = { thing: 'automation', id: movementId };
  await StatementStore.replaceGrants(automation, { teamId, verb: 'write', grantees: TEAM });
  await StatementStore.replaceGrants(automation, { teamId, verb: 'read', grantees: TEAM });
  await StatementStore.replaceGrants(automation, { teamId, verb: 'fire', grantees: [{ kind: 'anyone' }] });
  resolveAdapter.mockImplementation(async (input: { adapterType: string }) => {
    if (input.adapterType !== ADAPTER) throw new Error(`test: no module ${input.adapterType}`);
    return {
      getActorCandidates: async ({ event }: { event: { arrival?: { actor?: { identifier: string } } } }) => {
        const email = ADDRESSES[event.arrival?.actor?.identifier ?? ''];
        return email === undefined ? [] : [{ identity: { identifier: event.arrival?.actor?.identifier, scheme: 'email', adapterType: ADAPTER, email }, source: 'originator' }];
      },
    };
  });
});

afterAll(async () => {
  for (const table of ['work', 'trigger_run', 'event_receipt', 'arrival', 'arrival_identity', 'arrival_unjudged', 'arrival_refused', 'wait_row', 'delivery'] as const) {
    await sql`delete from ${sql.table(`automations.${table}`)} where team_id = ${teamId}::uuid`.execute(getAutomationsQb([table]));
  }
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

describe('upgrading a carried Slack automation', () => {
  it('says before it moves who may set it off once moved, and that setAccess changes it', async () => {
    const shown = await upgradeMovement({ teamId, id: movementId, acknowledge: false, validate: clean, advance: advanceLive });
    expect(shown).toMatchObject({ status: 'needs_acknowledgement' });
    if (shown.status === 'not_found') throw new Error('test: the automation is gone');
    expect(shown.changes?.fire).toMatch(/^Only the team's members may set it off through its listens on .*; setAccess changes who may\.$/);
    expect(await StatementStore.grantsOf({ thing: 'automation', id: movementId }, { teamId, verb: 'fire' })).toEqual([{ kind: 'anyone' }]);
  });

  it('restates its fire list as the team when it moves, and the answer names it', async () => {
    const moved = await upgradeMovement({ teamId, id: movementId, acknowledge: true, validate: clean, advance: advanceLive });
    expect(moved).toMatchObject({ status: 'upgraded', to: { version: LANGUAGE_VERSION } });
    if (moved.status === 'not_found') throw new Error('test: the automation is gone');
    expect(moved.changes?.fire).toContain("Only the team's members may set it off");
    expect(await StatementStore.grantsOf({ thing: 'automation', id: movementId }, { teamId, verb: 'fire' })).toEqual(TEAM);
    expect(await StatementStore.grantsOf({ thing: 'automation', id: movementId }, { teamId, verb: 'read' })).toEqual(TEAM);
  });

  it('then refuses a stranger at the door, and lets a member start a run', async () => {
    await insertTestListen({ teamId, movementId, adapterType: ADAPTER, edge: 'Things', delivery: 'connection', movement: 'triage' });

    const stranger = await deliver(message('U9', 'thing-1'));
    expect(stranger.fires).toEqual([]);
    const { rows: refused } = await sql<{ reason: string }>`
      select reason from automations.arrival_refused where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['arrival_refused']));
    expect(refused).toEqual([{ reason: 'who acted is not among who may fire this automation' }]);

    const member = await deliver(message('U1', 'thing-2'));
    expect(member.fires).toHaveLength(1);
  });
});
