// Who, in one team, an email address or a phone number names: the records
// `@lf-platform/team` answers from. A member is a user with a membership row in
// THIS team; the team a user prefers (`default_team_id`) says nothing here.
//
// Email matches as the platform's inbound has always matched a sender: the
// exact address on a non service `user_email`, else the address without its
// `+tag` on a row that accepts plus addressing. Phone matches the number of a
// verified link, for a user who has been granted access (the grant is the
// boundary an invited or revoked user must not cross).
//
// Two queries rather than a join wherever the number lives in automations and
// the person in core: the carve forbids a query that spans both.

import { z } from 'zod';
import { TEAM_LEVELS } from '@lf-platform/team';

import type { ModuleContext } from 'module-kit';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';
import type { TeamLevel, TeamMember, TeamRecords } from '@lf-platform/team';


import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { teamIdSchema } from '../../../../lib/team_id';

/** `phone_number.user_id` is an opaque id (no foreign key across the carve): read as a user's id where it is used to look one up. */
const userIdSchema = z.custom<UserId>((value) => z.guid().safeParse(value).success);

function levelOf(access: string): TeamLevel {
  const level = TEAM_LEVELS.find((candidate) => candidate === access);
  if (level === undefined) throw new Error(`a membership holds access "${access}", which is not one of ${TEAM_LEVELS.join(', ')}`);
  return level;
}

/** `ada+notes@example.com` as `ada@example.com`; the same text when there is no tag. */
function withoutPlusTag(email: string): string {
  return email.replace(/\+[^@]*@/, '@');
}

/** The member `userId` is in `teamId`, shown by their primary email (their
 *  username when they have none) and name (their username when unnamed). */
async function memberRow(teamId: TeamId, userId: UserId, options: { requireGrantedAccess: boolean }): Promise<TeamMember | null> {
  let query = getCoreQb(['user', 'team_membership', 'user_email'])
    .selectFrom('user as u')
    .innerJoin('team_membership as tm', (join) => join.onRef('tm.user_id', '=', 'u.id').on('tm.team_id', '=', teamId))
    .leftJoin('user_email as ue', (join) => join.onRef('ue.user_id', '=', 'u.id').on('ue.is_primary', '=', true))
    .where('u.id', '=', userId);
  if (options.requireGrantedAccess) query = query.where('u.granted_access_at', 'is not', null);
  const row = await query.select(['u.id', 'u.username', 'u.name', 'ue.email', 'tm.access']).executeTakeFirst();
  if (row === undefined) return null;
  return {
    id: row.id,
    email: row.email ?? row.username,
    name: row.name ?? row.username,
    level: levelOf(row.access),
  };
}

async function userWithEmail(input: { email: string; acceptsPlusOnly: boolean }): Promise<UserId[]> {
  let query = getCoreQb(['user_email'])
    .selectFrom('user_email as ue')
    .where('ue.email', '=', input.email)
    .where('ue.is_service_email', '=', false);
  if (input.acceptsPlusOnly) query = query.where('ue.accepts_plus_addressing', '=', true);
  return (await query.select('ue.user_id').execute()).map((row) => row.user_id);
}

/** The first of `candidates` that is a member of `teamId`: an address is one
 *  user's, but a user of another team may hold the same text before this
 *  team's member does, so each candidate is asked in turn. */
async function firstMember(teamId: TeamId, candidates: readonly UserId[], options: { requireGrantedAccess: boolean }): Promise<TeamMember | null> {
  for (const userId of candidates) {
    const member = await memberRow(teamId, userId, options);
    if (member !== null) return member;
  }
  return null;
}

export function teamRecordsFor(tenant: string): TeamRecords {
  const teamId = teamIdSchema.parse(tenant);
  return {
    async memberByEmail(email) {
      const direct = await firstMember(teamId, await userWithEmail({ email, acceptsPlusOnly: false }), { requireGrantedAccess: false });
      if (direct !== null) return direct;
      const stripped = withoutPlusTag(email);
      if (stripped === email) return null;
      return firstMember(teamId, await userWithEmail({ email: stripped, acceptsPlusOnly: true }), { requireGrantedAccess: false });
    },
    async memberByPhone(phone) {
      const links = await getAutomationsQb(['phone_number'])
        .selectFrom('phone_number')
        .where('phone_number', '=', phone)
        .where('verified_at', 'is not', null)
        .where('user_id', 'is not', null)
        .select('user_id')
        .execute();
      const users = links.flatMap((link) => (link.user_id === null ? [] : [userIdSchema.parse(link.user_id)]));
      return firstMember(teamId, users, { requireGrantedAccess: true });
    },
  };
}

/** What `teamModuleWith` takes: the records of the tenant a call's module is loaded for. */
export function platformTeamRecords(ctx: ModuleContext): TeamRecords {
  return teamRecordsFor(ctx.config.tenant);
}
