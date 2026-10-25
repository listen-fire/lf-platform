// The dev-loop token names only an email, so the user who owns that email is
// the one who must be a member of the team. A database seeded before the email
// was claimed holds the seed's user and the email's owner as two people.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';

import { getCoreQb } from '../../../lib/kysely';
import { ensureDevLoopLogin } from '../_lib';

const qb = () => getCoreQb(['team', 'user', 'user_email', 'team_membership']);
const teamId = randomUUID() as TeamId;
const emailOwner = randomUUID() as UserId;
const seededUser = randomUUID() as UserId;
const email = `dev-login-${teamId}@listen-fire.local`;

beforeAll(async () => {
  await qb().insertInto('team').values({ id: teamId, name: `dev-login-${teamId.slice(0, 8)}` } as never).execute();
  // The seed's user: of this team, by the seed's username, already a member.
  await qb()
    .insertInto('user')
    .values({ id: seededUser, default_team_id: teamId, username: 'dev-loop', granted_access_at: new Date() } as never)
    .execute();
  await qb().insertInto('team_membership').values({ id: randomUUID(), user_id: seededUser, team_id: teamId, access: 'write' } as never).execute();
  // The email belongs to someone else, with no membership.
  await qb()
    .insertInto('user')
    .values({ id: emailOwner, default_team_id: teamId, username: `owner-${emailOwner.slice(0, 8)}`, granted_access_at: new Date() } as never)
    .execute();
  await qb().insertInto('user_email').values({ id: randomUUID(), user_id: emailOwner, email, is_primary: true } as never).execute();
});

afterAll(async () => {
  await qb().deleteFrom('team_membership').where('team_id', '=', teamId).execute();
  await qb().deleteFrom('user_email').where('email', '=', email).execute();
  await qb().deleteFrom('user').where('default_team_id', '=', teamId).execute();
  await qb().deleteFrom('team').where('id', '=', teamId).execute();
});

describe('ensureDevLoopLogin', () => {
  it("makes the email's owner the team member when the seed's user and the owner differ", async () => {
    const login = await ensureDevLoopLogin({ teamId, email });

    expect(login.userId).toBe(emailOwner);
    const member = await qb()
      .selectFrom('team_membership')
      .where('user_id', '=', emailOwner)
      .where('team_id', '=', teamId)
      .select('access')
      .executeTakeFirst();
    expect(member?.access).toBe('write');
  });

  it('is idempotent', async () => {
    const again = await ensureDevLoopLogin({ teamId, email });
    expect(again.userId).toBe(emailOwner);
    const rows = await qb().selectFrom('team_membership').where('user_id', '=', emailOwner).where('team_id', '=', teamId).select('id').execute();
    expect(rows).toHaveLength(1);
  });
});
