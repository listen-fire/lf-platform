// A public inbox's mail through the door, against the real tables.
//
// The claim is written "Deals" and the listen "deals": keys are
// case-insensitive across the feature, so the door still finds the listener.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../../generated/kysely/core/User';
import type { TriggerId } from '../../../../../generated/kysely/automations/Trigger';

import { getAutomationsQb, getCoreQb } from '../../../../../lib/kysely';
import { cleanupTeam } from '../../../../../test/harness/cleanup';
import { routeInboundEmail } from '../inbound_door';
import { claimPublicInbox } from '../public_inbox';

const TEAM = randomUUID() as TeamId;
// Keys are deployment-wide; a run's own suffix keeps reruns apart.
const RUN = randomUUID().slice(0, 8);
const CLAIMED_AS = `Deals-${RUN}`;
const LISTENED_AS = `deals-${RUN}`;
const ADDRESS = `inbox+${LISTENED_AS}@example.com`;

const AUTHOR = randomUUID() as UserId;
const CLAIMANT = randomUUID() as UserId;
const MEMBER = randomUUID() as UserId;
const MEMBER_EMAIL = `member-${RUN}@team.example`;
const FOUNDER_EMAIL = `founder-${RUN}@startup.example`;

let triggerId: TriggerId;
let previousAddress: string | undefined;

async function person(id: UserId, email: string): Promise<void> {
  await getCoreQb(['user'])
    .insertInto('user')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id, default_team_id: TEAM, username: `inbox-${id.slice(0, 8)}`, granted_access_at: new Date() } as any)
    .execute();
  await getCoreQb(['team_membership'])
    .insertInto('team_membership')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ user_id: id, team_id: TEAM, access: 'write' } as any)
    .execute();
  await getCoreQb(['user_email'])
    .insertInto('user_email')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ user_id: id, email, is_primary: true } as any)
    .execute();
}

beforeAll(async () => {
  previousAddress = process.env.INBOUND_EMAIL_ADDRESS;
  process.env.INBOUND_EMAIL_ADDRESS = 'inbox@example.com';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await getCoreQb(['team']).insertInto('team').values({ id: TEAM, name: `public-inbox-${RUN}` } as any).execute();
  // The author joins first: today's fallback would pick them, so a run that
  // acts as anyone else proves the message decided it.
  await person(AUTHOR, `author-${RUN}@team.example`);
  await person(CLAIMANT, `claimant-${RUN}@team.example`);
  await person(MEMBER, MEMBER_EMAIL);

  await expect(claimPublicInbox({ teamId: TEAM, key: CLAIMED_AS, claimedByUserId: CLAIMANT })).resolves.toMatchObject({
    status: 'claimed',
  });
  const trigger = await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    .values({
      team_id: TEAM,
      name: 'deal inbox',
      kind: 'email',
      config: JSON.stringify({ key: LISTENED_AS }),
      created_by_user_id: AUTHOR,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .returning('id')
    .executeTakeFirstOrThrow();
  triggerId = trigger.id;
});

afterAll(async () => {
  if (previousAddress === undefined) delete process.env.INBOUND_EMAIL_ADDRESS;
  else process.env.INBOUND_EMAIL_ADDRESS = previousAddress;
  await getAutomationsQb(['public_inbox']).deleteFrom('public_inbox').where('team_id', '=', TEAM).execute();
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', TEAM).execute();
  await cleanupTeam(TEAM);
});

/** The trigger the door finds for this mail, if any. */
async function deliver(sender: string): Promise<string | undefined> {
  const decision = await routeInboundEmail({ recipients: [ADDRESS], senderCandidates: [sender] });
  if (decision.outcome !== 'routed') throw new Error(`the door refused mail from ${sender}`);
  return decision.route?.trigger?.id;
}

describe('a public inbox’s mail', () => {
  it('finds the listener whatever case the claim and the listen spell the key in', async () => {
    await expect(deliver(FOUNDER_EMAIL)).resolves.toBe(triggerId);
  });
});
