// Access statements against a REAL database: the table keeps a verb's list
// whole, refuses what the decision would refuse, and the decision reads
// memberships from core beside it.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { userPrincipal } from '../../principal';
import { ProvisioningService } from '../../provisioning';
import { accessTo, readableIds, setStatement } from '../decide';
import { StatementStore, type Grantee, type Target } from '../statement';

async function makeTeam(): Promise<TeamId> {
  const teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    .values({ id: teamId, name: `access-${teamId.slice(0, 8)}` })
    .execute();
  return teamId;
}

async function makeUser(teamId: TeamId, access: 'read' | 'write'): Promise<UserId> {
  const email = `access-${randomUUID().slice(0, 8)}@example.com`;
  return (await ProvisioningService.provisionUser({ teamId, email, access })).userId;
}

const user = (userId: string): Grantee => ({ kind: 'user', userId });
const team: Grantee = { kind: 'team' };

describe('access statements — one table, one decision', () => {
  let teamId: TeamId;
  let alice: UserId;
  let bob: UserId;
  let carol: UserId;
  let deals: Target<'automation'>;
  let finance: Target<'connection'>;

  const as = (userId: UserId) => userPrincipal({ userId, teamId, access: userId === carol ? 'read' : 'write' });

  beforeEach(async () => {
    teamId = await makeTeam();
    alice = await makeUser(teamId, 'write');
    bob = await makeUser(teamId, 'write');
    carol = await makeUser(teamId, 'read');
    deals = { thing: 'automation', id: randomUUID() };
    finance = { thing: 'connection', id: randomUUID() };
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: deals.id as MovementId, team_id: teamId, name: 'Deals', source: '' })
      .execute();
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({
        id: finance.id as ExternalServiceCredentialsId,
        team_id: teamId,
        type: ExternalServiceType.AIRTABLE,
        name: 'Finance',
        credentials: Buffer.from('x'),
      })
      .execute();
  });

  afterEach(async () => {
    await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId).execute();
    await cleanupTeam(teamId);
  });

  it('states an automation, decides from it, and lists by it', async () => {
    await setStatement(as(alice), deals, 'write', [user(alice)]);
    await setStatement(as(alice), deals, 'read', [team]);

    expect(await accessTo(as(alice), deals, 'write')).toBe(true);
    expect(await accessTo(as(bob), deals, 'write')).toBe(false);
    expect(await accessTo(as(carol), deals, 'read')).toBe(true);
    expect(await readableIds(as(carol), 'automation', [teamId])).toEqual(new Set([deals.id]));

    await setStatement(as(alice), deals, 'read', [user(alice), user(bob)]);
    expect(await accessTo(as(carol), deals, 'read')).toBe(false);
    expect(await readableIds(as(carol), 'automation', [teamId])).toEqual(new Set());
    const read = await StatementStore.grantsOf(deals, { teamId, verb: 'read' });
    expect(read).toHaveLength(2);
    expect(read).toEqual(expect.arrayContaining([user(alice), user(bob)]));
  });

  it('decides a connection by its use list', async () => {
    await setStatement(as(alice), finance, 'use', [user(carol)]);
    expect(await accessTo(as(carol), finance, 'use')).toBe(true);
    expect(await accessTo(as(bob), finance, 'use')).toBe(false);
    expect(await readableIds(as(bob), 'connection', [teamId])).toEqual(new Set());
  });

  it('keeps a list whole when its replacement fails partway', async () => {
    await setStatement(as(alice), deals, 'write', [user(alice)]);
    await expect(
      StatementStore.replaceGrants(deals, { teamId, verb: 'write', grantees: [team, { kind: 'domain', domain: 'acme.com' }] }),
    ).rejects.toThrow(/access_statement_members_only_check/);
    expect(await StatementStore.grantsOf(deals, { teamId, verb: 'write' })).toEqual([user(alice)]);
  });

  it('finds the lists that name a member', async () => {
    await setStatement(as(alice), deals, 'write', [user(alice)]);
    await setStatement(as(alice), finance, 'use', [user(alice), user(bob)]);
    const lists = await StatementStore.listsNaming({ teamId, userId: bob });
    expect(lists).toEqual([{ target: finance, verb: 'use' }]);
  });
});
