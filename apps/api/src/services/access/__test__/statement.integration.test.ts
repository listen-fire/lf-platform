// Access statements against a REAL database: the table keeps a verb's list
// whole, refuses what the decision would refuse, and the decision reads
// memberships from core beside it.

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { userPrincipal } from '../../principal';
import { ProvisioningService } from '../../provisioning';
import { accessTo, readableIds, seenOnlyBy, setStatement } from '../decide';
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
    await setStatement(as(alice), { target: deals, verb: 'write', grantees: [user(alice)] });
    await setStatement(as(alice), { target: deals, verb: 'read', grantees: [team] });

    expect(await accessTo(as(alice), { target: deals, verb: 'write' })).toBe(true);
    expect(await accessTo(as(bob), { target: deals, verb: 'write' })).toBe(false);
    expect(await accessTo(as(carol), { target: deals, verb: 'read' })).toBe(true);
    expect(await readableIds(as(carol), { thing: 'automation', teamIds: [teamId] })).toEqual(new Set([deals.id]));

    await setStatement(as(alice), { target: deals, verb: 'read', grantees: [user(alice), user(bob)] });
    expect(await accessTo(as(carol), { target: deals, verb: 'read' })).toBe(false);
    expect(await readableIds(as(carol), { thing: 'automation', teamIds: [teamId] })).toEqual(new Set());
    const read = await StatementStore.grantsOf(deals, { teamId, verb: 'read' });
    expect(read).toHaveLength(2);
    expect(read).toEqual(expect.arrayContaining([user(alice), user(bob)]));
  });

  it('keeps an automation on a carried language version to firing by anyone, until it is upgraded', async () => {
    await setStatement(as(alice), { target: deals, verb: 'write', grantees: [user(alice)] });
    // The row was saved with no pin, which reads as legacy id '1': a carried version.
    await expect(setStatement(as(alice), { target: deals, verb: 'fire', grantees: [team] })).rejects.toMatchObject({
      refusal: 'carried_pin',
    });
    await setStatement(as(alice), { target: deals, verb: 'fire', grantees: [{ kind: 'anyone' }] });

    await getAutomationsQb(['movement'])
      .updateTable('movement')
      .set({ language_version: LANGUAGE_VERSION })
      .where('id', '=', deals.id as MovementId)
      .execute();
    // Upgrading changes the pin and nothing stated, so the person narrows it afterwards.
    expect(await StatementStore.grantsOf(deals, { teamId, verb: 'fire' })).toEqual([{ kind: 'anyone' }]);
    await setStatement(as(alice), { target: deals, verb: 'fire', grantees: [team] });
    expect(await StatementStore.grantsOf(deals, { teamId, verb: 'fire' })).toEqual([team]);
  });

  it('decides a connection by its use list', async () => {
    await setStatement(as(alice), { target: finance, verb: 'use', grantees: [user(carol)] });
    expect(await accessTo(as(carol), { target: finance, verb: 'use' })).toBe(true);
    expect(await accessTo(as(bob), { target: finance, verb: 'use' })).toBe(false);
    expect(await readableIds(as(bob), { thing: 'connection', teamIds: [teamId] })).toEqual(new Set());
  });

  it('keeps a list whole when its replacement fails partway', async () => {
    await setStatement(as(alice), { target: deals, verb: 'write', grantees: [user(alice)] });
    await expect(
      StatementStore.replaceGrants(deals, { teamId, verb: 'write', grantees: [team, { kind: 'domain', domain: 'acme.com' }] }),
    ).rejects.toThrow(/access_statement_members_only_check/);
    expect(await StatementStore.grantsOf(deals, { teamId, verb: 'write' })).toEqual([user(alice)]);
  });

  it('names write members only on the write list, stores ids lowercase, and opens creation only once', async () => {
    await setStatement(as(alice), { target: deals, verb: 'write', grantees: [user(alice)] });
    await expect(
      setStatement(as(alice), { target: deals, verb: 'write', grantees: [user(carol)] }),
    ).rejects.toMatchObject({ refusal: 'not_a_writer' });

    await setStatement(as(alice), { target: deals, verb: 'read', grantees: [user(bob.toUpperCase())] });
    expect(await StatementStore.grantsOf(deals, { teamId, verb: 'read' })).toEqual([user(bob)]);
    expect(await accessTo(as(bob), { target: deals, verb: 'read' })).toBe(true);

    await StatementStore.replaceGrants(finance, { teamId, verb: 'use', grantees: [user(carol)] });
    expect(await StatementStore.hasAnyStatement(finance)).toBe(true);
    await expect(
      setStatement(as(bob), { target: finance, verb: 'use', grantees: [user(bob)] }),
    ).rejects.toMatchObject({ refusal: 'not_allowed' });
  });

  it('reads several things’ lists at once, and finds what only one member may see', async () => {
    const notes: Target<'automation'> = { thing: 'automation', id: randomUUID() };
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: notes.id as MovementId, team_id: teamId, name: 'Notes', source: '' })
      .execute();
    await setStatement(as(alice), { target: deals, verb: 'write', grantees: [user(alice)] });
    await setStatement(as(alice), { target: deals, verb: 'read', grantees: [user(alice)] });
    await setStatement(as(alice), { target: deals, verb: 'fire', grantees: [{ kind: 'anyone' }] });
    await setStatement(as(alice), { target: notes, verb: 'write', grantees: [user(alice)] });
    await setStatement(as(alice), { target: notes, verb: 'read', grantees: [team] });

    const lists = await StatementStore.grantsAmong({ thing: 'automation', teamId, ids: [deals.id, notes.id, 'not-a-uuid'], verbs: ['read', 'write'] });
    expect(lists.get(deals.id)).toEqual(expect.arrayContaining([{ verb: 'read', grantee: user(alice) }, { verb: 'write', grantee: user(alice) }]));
    expect(lists.get(deals.id)).toHaveLength(2);
    expect(lists.get(notes.id)).toEqual(expect.arrayContaining([{ verb: 'read', grantee: team }]));

    expect(await seenOnlyBy(as(alice), { thing: 'automation', teamId, ids: [deals.id, notes.id] })).toEqual(new Set([deals.id]));
    expect(await seenOnlyBy(as(bob), { thing: 'automation', teamId, ids: [deals.id, notes.id] })).toEqual(new Set());
  });

  it('finds the lists that name a member', async () => {
    await setStatement(as(alice), { target: deals, verb: 'write', grantees: [user(alice)] });
    await setStatement(as(alice), { target: finance, verb: 'use', grantees: [user(alice), user(bob)] });
    const lists = await StatementStore.listsNaming({ teamId, userId: bob });
    expect(lists).toEqual([{ target: finance, verb: 'use' }]);
  });
});
