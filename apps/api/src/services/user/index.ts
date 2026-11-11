import * as db from '@prisma/client';

import { currentContext } from '../context';
import { ModelService } from '../utils';
import { PermissionService } from '../permission';
import { findManyByFkDataloader, findByUniqueDataloader } from '../../lib/datasources/dataloaders';
import { TeamService } from '../team';
import { LegalEntity } from '../../lib/datasources/legal_entity';
import { mq } from '../../lib/message_queue';
import { getAutomationsQb, getCoreQb, getValuationsQb } from '../../lib/kysely';
import LegalEntityType from '../../generated/kysely/valuations/LegalEntityType';

interface UserCreateArgs {
  email: string;
  teamId: string;
  publicProfileId?: string | null;
  username?: string | null;
}

function normalisePhoneNumber(phoneNumber: string): string {
  return phoneNumber.replace(/^whatsapp:/, '');
}

class User extends ModelService<'user'> {
  protected readonly objectName = 'user';

  dataloaders = this.getDataloaderGetters({
    findByEmail: findByUniqueDataloader('userEmail', 'email', { caseInsensitive: true }),
    findManyByTeamId: findManyByFkDataloader('user', 'defaultTeamId'),
  });

  async createInTeam({ email, teamId, publicProfileId, username }: UserCreateArgs) {
    const user = await this.getOrCreateByEmail({ email, teamId, publicProfileId, username });
    await this.addToTeamAsAdmin({ userId: user.id, teamId });
    return user;
  }

  async addToTeamAsAdmin({ userId, teamId }: { userId: string; teamId: string }): Promise<void> {
    await PermissionService.grantMembership({ userId, teamId, access: 'admin' });
  }

  async create({ email, teamId, publicProfileId, username }: UserCreateArgs): Promise<db.User> {
    const ctx = currentContext();
    const user = await this.model.create({
      data: {
        isPlatformAdmin: false,
        defaultTeamId: teamId,
        publicProfileId,
        username: (username ?? email.split('@')[0]).toLowerCase(),
        userEmails: { create: { email: email.toLowerCase(), isPrimary: true } },
      },
    });

    ctx.onChangesCommitted(() => mq.users.created.publish(user));

    return user;
  }

  async getById(id: string): Promise<db.User & { email: string }> {
    const record = await currentContext().dataloaders.userById.load(id);
    if (!record) {
      throw new Error(`Could not find ${this.objectName} ${id}`);
    }
    return record;
  }

  async getByEmail(email: string) {
    const userEmail = await this.dataloaders.findByEmail.load(email.toLowerCase());
    if (!userEmail) {
      throw new Error('Could not find user.');
    }
    return this.getById(userEmail.userId);
  }

  async findByEmail(email: string) {
    const userEmail = await this.dataloaders.findByEmail.load(email);
    if (!userEmail) {
      return null;
    }
    return this.getById(userEmail.userId);
  }

  async getByPhoneNumber(phoneNumber: string): Promise<db.User> {
    const normalisedNumber = normalisePhoneNumber(phoneNumber);

    const { prisma } = currentContext();
    // Two reads: the number lives in automations' channel-identity table, the
    // user in core's, and the carve forbids a query that spans both (D3/D28).
    const link = await prisma.phoneNumber.findFirstOrThrow({
      where: { phoneNumber: normalisedNumber, userId: { not: null } },
      select: { userId: true },
    });
    return prisma.user.findFirstOrThrow({ where: { id: link.userId as string } });
  }

  async getByProfileId(profileId: string): Promise<db.User> {
    const { prisma } = currentContext();
    return prisma.user.findFirstOrThrow({
      where: { publicProfileId: profileId },
    });
  }

  async findByProfileId(profileId: string): Promise<db.User | null> {
    const { prisma } = currentContext();
    return prisma.user.findFirst({
      where: { publicProfileId: profileId },
    });
  }

  async getOrCreateByEmail({
    email,
    teamId,
    publicProfileId,
    username,
  }: UserCreateArgs): Promise<db.User> {
    try {
      return await this.getByEmail(email.toLowerCase());
    } catch {
      return await this.create({ email: email.toLowerCase(), teamId, publicProfileId, username });
    }
  }

  async createWithEmailAndName({ email, name }: { email: string; name: string }) {
    const ctx = currentContext();
    const { id: teamId } = await TeamService.getFirstByNameOrCreate(name);

    const user = await this.createInTeam({ email: email, teamId });

    // Create personal portfolio
    const legalEntityService = new LegalEntity({
      prisma: ctx.prisma,
      dataloaders: ctx.dataloaders,
      teamId,
    });

    const portfolioName = `${name}'s investments`;
    const portfolio = await legalEntityService.getByNameOrCreate({
      legalName: portfolioName,
      type: db.LegalEntityType.NATURAL_PERSON,
    });

    await legalEntityService.markAsPortfolio(portfolio);

    return user;
  }

  async createFromWhatsApp({
    email,
    name,
    phoneNumber,
  }: {
    email: string;
    name: string;
    phoneNumber: string;
  }) {
    const team = await getCoreQb(['team'])
      .insertInto('team')
      .values({
        name: `${name}+${phoneNumber.slice(-4)}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (!team) {
      throw new Error('Failed to create team for WhatsApp user');
    }
    const username = (name ?? 'WhatsApp User').toLowerCase();
    const user = await getCoreQb(['user'])
      .insertInto('user')
      .values({
        is_platform_admin: false,
        default_team_id: team.id,
        username: username,
      })
      .returning(['id', 'default_team_id', 'username'])
      .executeTakeFirstOrThrow();

    await getCoreQb(['user_email'])
      .insertInto('user_email')
      .values({
        email: email.toLowerCase(),
        user_id: user.id,
        is_primary: true,
      })
      .executeTakeFirstOrThrow();

    // The membership is what lets them act in the team they were just given,
    // as its founder; the column on `user` only says where they land (C-6).
    await PermissionService.grantMembership({
      userId: user.id,
      teamId: user.default_team_id,
      access: 'admin',
    });

    await getAutomationsQb(['phone_number'])
      .insertInto('phone_number')
      .values({
        phone_number: phoneNumber,
        user_id: user.id,
      })
      .executeTakeFirstOrThrow();

    // Create portfolio for the user
    await getValuationsQb(['legal_entity'])
      .insertInto('legal_entity')
      .values({
        name: `${username}'s investments`,
        type: LegalEntityType.NATURAL_PERSON,
        team_id: user.default_team_id,
        is_portfolio: true,
      })
      .executeTakeFirstOrThrow();

    const publicProfile = await getValuationsQb(['legal_entity'])
      .insertInto('legal_entity')
      .values({
        name: name ?? 'WhatsApp User',
        type: LegalEntityType.NATURAL_PERSON,
      })
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow();

    await getCoreQb(['user'])
      .updateTable('user')
      .set({ public_profile_id: publicProfile.id })
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();

    return {
      ...user,
      displayName: publicProfile.name,
    };
  }

  async findManyByTeamId(teamId: string): Promise<db.User[]> {
    return this.dataloaders.findManyByTeamId.load(teamId);
  }

  async setDefaultTeam({ user, team }: { user: db.User; team: db.Team }): Promise<void> {
    await this.model.update({
      where: { id: user.id },
      data: { defaultTeamId: team.id },
    });

    user.defaultTeamId = team.id;
  }

  async getAccessibleTeamIds(userId: string): Promise<string[]> {
    const memberships = await PermissionService.getMemberships(userId);

    const teamIds = new Set<string>();
    memberships.map((membership) => teamIds.add(membership.teamId));

    return Array.from(teamIds);
  }

  async setPlatformAdmin({
    userId,
    isAdmin,
  }: {
    userId: string;
    isAdmin: boolean;
  }): Promise<db.User> {
    return this.model.update({
      where: { id: userId },
      data: { isPlatformAdmin: isAdmin },
    });
  }

  /**
   * add an email address to a user.
   * Take care not to expose this to non-admins, as throwing due to the uniqueness constraint
   * could expose the existence of other emails in the system
   */
  async addEmail({
    email,
    userId,
    isPrimary = false,
  }: {
    email: string;
    userId: string;
    isPrimary?: boolean;
  }) {
    const { prisma } = currentContext();

    // A user has at most one primary address (a partial unique index), so a new
    // primary takes the role over rather than colliding with the old one.
    if (isPrimary) {
      await prisma.userEmail.updateMany({ where: { userId, isPrimary: true }, data: { isPrimary: false } });
    }
    await prisma.userEmail.create({ data: { email: email.toLowerCase(), userId, isPrimary } });
  }

  /**
   * add a phone number to a user.
   * Take care not to expose this to non-admins, as throwing due to the uniqueness constraint
   * could expose the existence of other phone numbers in the system
   */
  async addPhoneNumber({ phoneNumber, userId }: { phoneNumber: string; userId: string }) {
    const ctx = currentContext();
    const normalisedNumber = normalisePhoneNumber(phoneNumber);

    const existingPhoneNumber = await ctx.prisma.phoneNumber.findFirst({
      where: {
        userId,
      },
    });

    if (existingPhoneNumber) {
      return ctx.prisma.phoneNumber.update({
        where: { id: existingPhoneNumber.id },
        data: {
          phoneNumber: normalisedNumber,
        },
      });
    }
    return ctx.prisma.phoneNumber.create({ data: { phoneNumber: normalisedNumber, userId } });
  }

  /**
   * Whether this number already belongs to anyone other than this user. The
   * number is unique across all users, so `addPhoneNumber` would fail on it;
   * asking first lets a caller refuse in words instead.
   */
  async phoneNumberHeldByAnother({
    phoneNumber,
    userId,
  }: {
    phoneNumber: string;
    userId: string;
  }): Promise<boolean> {
    const { prisma } = currentContext();
    const held = await prisma.phoneNumber.findFirst({
      where: {
        phoneNumber: normalisePhoneNumber(phoneNumber),
        // A row nobody owns still holds the number.
        OR: [{ userId: null }, { userId: { not: userId } }],
      },
      select: { id: true },
    });
    return held !== null;
  }

  async updateUsername({ userId, newUsername }: { userId: string; newUsername: string }) {
    const trimmedUsername = newUsername.trim();
    if (trimmedUsername.length === 0) {
      throw new Error('Username cannot be empty or contain only whitespace');
    }
    return this.model.update({ where: { id: userId }, data: { username: trimmedUsername } });
  }

  async updateInvestorProfile({
    userId,
    publicProfileId,
  }: {
    userId: string;
    publicProfileId: string;
  }) {
    return this.model.update({ where: { id: userId }, data: { publicProfileId } });
  }

  async setAccessState({ userId, hasAccess }: { userId: string; hasAccess: boolean }) {
    return this.model.update({
      where: { id: userId },
      data: { grantedAccessAt: hasAccess ? new Date() : null },
    });
  }
  async setRegistrationComplete({ userId }: { userId: string }) {
    return this.model.update({
      where: { id: userId },
      data: { completedRegistrationAt: new Date() },
    });
  }
  async setLastRemindedAt({ userId }: { userId: string }) {
    return this.model.update({ where: { id: userId }, data: { lastRemindedAt: new Date() } });
  }

  async findManyEmailsByUserId(userId: string): Promise<db.UserEmail[]> {
    const { prisma } = currentContext();
    return prisma.userEmail.findMany({ where: { userId } });
  }

  async dangerousGetPrimaryEmailByUserId(userId: string): Promise<string | null> {
    const { prisma } = currentContext();
    const userEmail = await prisma.userEmail.findFirst({
      where: { userId, isPrimary: true },
    });
    return userEmail?.email ?? null;
  }
}

const UserService = new User();

export { UserService };
