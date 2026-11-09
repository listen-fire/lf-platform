// The team's own member management against a REAL DB: the three rules that
// keep a team manageable from its settings page.
//
//   • a per-member act only reaches people on the acting team;
//   • the last write-access member cannot be demoted, as they cannot be removed;
//   • adding an address that already has an account adds THAT account;
//   • no address or number this team writes can open a door to another team.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { StatementStore, type Target } from '../../../../services/access/statement';
import { Context } from '../../../../services/context';
import { userPrincipal } from '../../../../services/principal';
import { ProvisioningService } from '../../../../services/provisioning';
import { TeamInviteService } from '../../../../services/team_invite';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { trpc } from '../../trpc';
import { teamMembersRouter } from '../teamMembers';

async function makeTeam(): Promise<TeamId> {
  const teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    .values({ id: teamId, name: `members-${teamId.slice(0, 8)}` })
    .execute();
  return teamId;
}

async function makeUser(
  teamId: TeamId,
  access: 'read' | 'write',
): Promise<{ userId: UserId; email: string }> {
  const email = `member-${randomUUID().slice(0, 8)}@example.com`;
  const { userId } = await ProvisioningService.provisionUser({ teamId, email, access });
  return { userId, email };
}

function asMember<T>(
  actor: { userId: UserId; teamId: TeamId },
  fn: (caller: ReturnType<typeof callerFor>) => Promise<T>,
): Promise<T> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: actor.userId, teamId: actor.teamId }));
  return ctx.runAsync(() => fn(callerFor()));
}

/**
 * The refusal a call ends in. Caught INSIDE the context: a Context that ends in
 * an error re-emits it as an unhandled 'error' event, hiding the tRPC code.
 */
function refusalOf(
  actor: { userId: UserId; teamId: TeamId },
  fn: (caller: ReturnType<typeof callerFor>) => Promise<unknown>,
): Promise<unknown> {
  return asMember(actor, (c) =>
    fn(c).then(
      () => {
        throw new Error('expected the call to be refused');
      },
      (err: unknown) => err,
    ),
  );
}

function callerFor() {
  return teamMembersRouter(trpc.procedure).createCaller({ authorise: async () => {} });
}

async function accessOn(teamId: TeamId, userId: UserId): Promise<string | undefined> {
  const row = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select('access')
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row?.access;
}

describe('team members — managing the team from its own settings', () => {
  let teamId: TeamId;
  let otherTeamId: TeamId;
  let admin: { userId: UserId; email: string };

  beforeEach(async () => {
    teamId = await makeTeam();
    otherTeamId = await makeTeam();
    admin = await makeUser(teamId, 'write');
  });
  afterEach(async () => {
    // Memberships of a user homed on the other team go with that team's users,
    // so clear this team's memberships of them first.
    await getCoreQb(['team_membership'])
      .deleteFrom('team_membership')
      .where('team_id', '=', teamId)
      .execute();
    await cleanupTeam(teamId);
    await cleanupTeam(otherTeamId);
  });

  it('refuses a per-member act on someone outside the team as NOT_FOUND', async () => {
    const stranger = await makeUser(otherTeamId, 'write');

    expect(
      await refusalOf({ userId: admin.userId, teamId }, (c) =>
        c.setAccess({ userId: stranger.userId, access: 'read' }),
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await refusalOf({ userId: admin.userId, teamId }, (c) =>
        c.rename({ userId: stranger.userId, username: 'hijacked' }),
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });

    expect(
      await refusalOf({ userId: admin.userId, teamId }, (c) =>
        c.addEmail({ userId: stranger.userId, email: `x-${randomUUID().slice(0, 8)}@example.com` }),
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await refusalOf({ userId: admin.userId, teamId }, (c) =>
        c.addPhone({ userId: stranger.userId, phoneNumber: '+447700900123' }),
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });

    expect(await accessOn(otherTeamId, stranger.userId)).toBe('write');
  });

  it('refuses to change the sign-in details of a member who also belongs to another team', async () => {
    const shared = await makeUser(otherTeamId, 'write');
    await asMember({ userId: admin.userId, teamId }, (c) =>
      c.addMember({ email: shared.email, username: 'ignored', access: 'read' }),
    );

    const address = `takeover-${randomUUID().slice(0, 8)}@example.com`;
    expect(
      await refusalOf({ userId: admin.userId, teamId }, (c) =>
        c.addEmail({ userId: shared.userId, email: address }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });
    const written = await getCoreQb(['user_email'])
      .selectFrom('user_email')
      .select('id')
      .where('email', '=', address)
      .executeTakeFirst();
    expect(written).toBeUndefined();

    const overview = await asMember({ userId: admin.userId, teamId }, (c) => c.overview());
    const soleTeam = new Map(overview.members.map((m) => [m.userId, m.soleTeam]));
    expect(soleTeam.get(shared.userId)).toBe(false);
    expect(soleTeam.get(admin.userId)).toBe(true);
  });

  it('refuses to change the sign-in details of a platform admin, even on their sole team', async () => {
    const platformAdmin = await makeUser(teamId, 'read');
    await getCoreQb(['user'])
      .updateTable('user')
      .set({ is_platform_admin: true })
      .where('id', '=', platformAdmin.userId)
      .execute();

    expect(
      await refusalOf({ userId: admin.userId, teamId }, (c) =>
        c.addEmail({ userId: platformAdmin.userId, email: `x-${randomUUID().slice(0, 8)}@example.com` }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });

    const overview = await asMember({ userId: admin.userId, teamId }, (c) => c.overview());
    const row = overview.members.find((m) => m.userId === platformAdmin.userId);
    expect(row).toMatchObject({ soleTeam: true, platformAdmin: true });
  });

  it('refuses an address another team has a pending invite for', async () => {
    const member = await makeUser(teamId, 'read');
    const inviter = await makeUser(otherTeamId, 'write');
    const invited = `invited-${randomUUID().slice(0, 8)}@example.com`;
    await asMember({ userId: inviter.userId, teamId: otherTeamId }, () =>
      TeamInviteService.addInvite({ teamId: otherTeamId, email: invited, invitedBy: inviter.userId }),
    );

    expect(
      await refusalOf({ userId: admin.userId, teamId }, (c) =>
        c.addEmail({ userId: member.userId, email: invited.toUpperCase() }),
      ),
    ).toMatchObject({ code: 'CONFLICT' });
    expect(
      await refusalOf({ userId: admin.userId, teamId }, (c) =>
        c.addMember({ email: invited, username: 'Squatter', access: 'read' }),
      ),
    ).toMatchObject({ code: 'CONFLICT' });
    expect(
      await refusalOf({ userId: admin.userId, teamId }, (c) =>
        c.createServiceAccount({ email: invited, access: 'read' }),
      ),
    ).toMatchObject({ code: 'CONFLICT' });

    const written = await getCoreQb(['user_email'])
      .selectFrom('user_email')
      .select('id')
      .where('email', '=', invited)
      .executeTakeFirst();
    expect(written).toBeUndefined();
  });

  it('refuses a phone number another person already has, as CONFLICT', async () => {
    const holder = await makeUser(teamId, 'read');
    const member = await makeUser(teamId, 'read');
    const number = `+4477009${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
    try {
      await asMember({ userId: admin.userId, teamId }, (c) =>
        c.addPhone({ userId: holder.userId, phoneNumber: number }),
      );
      expect(
        await refusalOf({ userId: admin.userId, teamId }, (c) =>
          c.addPhone({ userId: member.userId, phoneNumber: number }),
        ),
      ).toMatchObject({ code: 'CONFLICT' });
      // The holder setting their own number again is not a conflict.
      await asMember({ userId: admin.userId, teamId }, (c) =>
        c.addPhone({ userId: holder.userId, phoneNumber: number }),
      );
    } finally {
      // Phone numbers live in automations, keyed on the user; team cleanup misses them.
      await getAutomationsQb(['phone_number'])
        .deleteFrom('phone_number')
        .where('user_id', 'in', [holder.userId, member.userId])
        .execute();
    }
  });

  it('refuses to remove the last write-access member as PRECONDITION_FAILED', async () => {
    expect(
      await refusalOf({ userId: admin.userId, teamId }, (c) => c.remove({ userId: admin.userId })),
    ).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await accessOn(teamId, admin.userId)).toBe('write');
  });

  it('passes what a removed member alone held to the team’s write members', async () => {
    const leaver = await makeUser(teamId, 'write');
    // On the team but not a write member, so never an heir.
    await makeUser(teamId, 'read');
    const deals: Target<'automation'> = { thing: 'automation', id: randomUUID() };
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: deals.id as MovementId, team_id: teamId, name: 'Deals', source: '' })
      .execute();
    await StatementStore.replaceGrants(deals, { teamId, verb: 'read', grantees: [{ kind: 'user', userId: leaver.userId }] });
    await StatementStore.replaceGrants(deals, {
      teamId,
      verb: 'write',
      grantees: [
        { kind: 'user', userId: leaver.userId },
        { kind: 'user', userId: admin.userId },
      ],
    });

    try {
      await asMember({ userId: admin.userId, teamId }, (c) => c.remove({ userId: leaver.userId }));

      expect(await StatementStore.grantsOf(deals, { teamId, verb: 'read' })).toEqual([
        { kind: 'user', userId: admin.userId },
      ]);
      const write = await StatementStore.grantsOf(deals, { teamId, verb: 'write' });
      expect(write).toHaveLength(2);
      expect(write).toEqual(
        expect.arrayContaining([
          { kind: 'user', userId: leaver.userId },
          { kind: 'user', userId: admin.userId },
        ]),
      );
    } finally {
      await getAutomationsQb(['movement']).deleteFrom('movement').where('id', '=', deals.id as MovementId).execute();
    }
  });

  it('passes a write list a demoted member alone held to the team’s write members, and keeps their read', async () => {
    const demoted = await makeUser(teamId, 'write');
    const deals: Target<'automation'> = { thing: 'automation', id: randomUUID() };
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: deals.id as MovementId, team_id: teamId, name: 'Deals', source: '' })
      .execute();
    const theirs = [{ kind: 'user' as const, userId: demoted.userId }];
    await StatementStore.replaceGrants(deals, { teamId, verb: 'write', grantees: theirs });
    await StatementStore.replaceGrants(deals, { teamId, verb: 'read', grantees: theirs });

    try {
      await asMember({ userId: admin.userId, teamId }, (c) => c.setAccess({ userId: demoted.userId, access: 'read' }));

      expect(await accessOn(teamId, demoted.userId)).toBe('read');
      expect(await StatementStore.grantsOf(deals, { teamId, verb: 'write' })).toEqual([
        { kind: 'user', userId: admin.userId },
      ]);
      expect(await StatementStore.grantsOf(deals, { teamId, verb: 'read' })).toEqual(theirs);
    } finally {
      await getAutomationsQb(['movement']).deleteFrom('movement').where('id', '=', deals.id as MovementId).execute();
    }
  });

  it('tells a read-only member they are read-only, and refuses their writes as FORBIDDEN', async () => {
    const reader = await makeUser(teamId, 'read');
    const overview = await asMember({ userId: reader.userId, teamId }, (c) => c.overview());
    expect(overview.viewer).toEqual({ userId: reader.userId, access: 'read' });
    expect(
      await refusalOf({ userId: reader.userId, teamId }, (c) => c.remove({ userId: admin.userId })),
    ).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to demote the last write-access member, and allows it once there is another', async () => {
    expect(
      await refusalOf({ userId: admin.userId, teamId }, (c) =>
        c.setAccess({ userId: admin.userId, access: 'read' }),
      ),
    ).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await accessOn(teamId, admin.userId)).toBe('write');

    // Re-adding an existing member is an access change, under the same rule.
    expect(
      await refusalOf({ userId: admin.userId, teamId }, (c) =>
        c.addMember({ email: admin.email, username: 'ignored', access: 'read' }),
      ),
    ).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await accessOn(teamId, admin.userId)).toBe('write');

    const second = await makeUser(teamId, 'read');
    await asMember({ userId: admin.userId, teamId }, (c) =>
      c.setAccess({ userId: second.userId, access: 'write' }),
    );
    await asMember({ userId: admin.userId, teamId }, (c) =>
      c.setAccess({ userId: admin.userId, access: 'read' }),
    );
    expect(await accessOn(teamId, admin.userId)).toBe('read');
  });

  it('adds an existing account by its address instead of creating a second one', async () => {
    const existing = await makeUser(otherTeamId, 'write');

    const added = await asMember({ userId: admin.userId, teamId }, (c) =>
      c.addMember({ email: existing.email.toUpperCase(), username: 'ignored', access: 'read' }),
    );

    expect(added.id).toBe(existing.userId);
    expect(await accessOn(teamId, existing.userId)).toBe('read');
    expect(await accessOn(otherTeamId, existing.userId)).toBe('write');

    // A second add is an upsert of the same membership, not a duplicate.
    await asMember({ userId: admin.userId, teamId }, (c) =>
      c.addMember({ email: existing.email, username: 'ignored', access: 'write' }),
    );
    expect(await accessOn(teamId, existing.userId)).toBe('write');

    const overview = await asMember({ userId: admin.userId, teamId }, (c) => c.overview());
    expect(overview.members.map((m) => m.userId)).toEqual([admin.userId, existing.userId]);
  });

  it('creates a brand-new member and a service account on the team', async () => {
    const email = `new-${randomUUID().slice(0, 8)}@example.com`;
    const serviceEmail = `svc-${randomUUID().slice(0, 8)}@example.com`;

    const added = await asMember({ userId: admin.userId, teamId }, (c) =>
      c.addMember({ email, username: 'Newbie McNew', access: 'read' }),
    );
    await asMember({ userId: admin.userId, teamId }, (c) =>
      c.createServiceAccount({ email: serviceEmail, access: 'write' }),
    );

    const overview = await asMember({ userId: admin.userId, teamId }, (c) => c.overview());
    const byEmail = new Map(overview.members.map((m) => [m.email, m]));
    expect(byEmail.get(email)).toMatchObject({
      userId: added.id,
      username: 'Newbie McNew',
      access: 'read',
      isServiceAccount: false,
    });
    expect(byEmail.get(serviceEmail)).toMatchObject({ access: 'write', isServiceAccount: true });
  });
});
