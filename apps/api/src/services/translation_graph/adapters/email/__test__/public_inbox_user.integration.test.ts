// What a public inbox's run reads as its user (`@user_*`), from the door to
// the engine, against the real tables: the door routes the mail to the listen
// naming its key, the mail's arrival is kept as a delivery judged by that
// listen, and a worker drains its `fire_event` row through the real firing and
// engine, whose `@user_*` asks the host's acting-user resolution. A founder writing in reads as whoever claimed the key — the same
// person the run executes as — and a colleague reads as themselves.
//
// The movement says who it read by failing with it: the run's failure reason
// is the one value a credential-less movement can hand back.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../../generated/kysely/core/User';
import type { TriggerId } from '../../../../../generated/kysely/automations/Trigger';

import { getAutomationsQb, getCoreQb } from '../../../../../lib/kysely';
import { cleanupTeam } from '../../../../../test/harness/cleanup';
import { saveMovement } from '../../../movement/provision';
import { registerFireEventWork } from '../../../../inbound/fire_event';
import { deliverArrivals } from '../../../../inbound/listen_door';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../../../work/drain';
import { normaliseInboundEmailPayload } from '..';
import { inboundEmailArrival } from '../arrival';
import { routeInboundEmail } from '../inbound_door';
import { claimPublicInbox } from '../public_inbox';

jest.mock('../../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

const TEAM = randomUUID() as TeamId;
// Keys are deployment-wide; a run's own suffix keeps reruns apart.
const RUN = randomUUID().slice(0, 8);
const KEY = `deals-${RUN}`;
const ADDRESS = `inbox+${KEY}@example.com`;

const CLAIMANT = randomUUID() as UserId;
const CLAIMANT_EMAIL = `claimant-${RUN}@team.example`;
const MEMBER = randomUUID() as UserId;
const MEMBER_EMAIL = `member-${RUN}@team.example`;
const FOUNDER_EMAIL = `founder-${RUN}@startup.example`;

const SOURCE = `import { email } from adapters

inbox = connect email

function intake(m: <inbox-[:Emails]->>) {
  fail("read as \${@user_email}")
}

listen to inbox-[e:Emails WHERE e.Key == "${KEY}"]-> fire intake
`;

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
  resetWorkHandlersForTests();
  registerFireEventWork();
  setWorkNotifier({ notify() {} });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await getCoreQb(['team']).insertInto('team').values({ id: TEAM, name: `public-inbox-user-${RUN}` } as any).execute();
  await person(CLAIMANT, CLAIMANT_EMAIL);
  await person(MEMBER, MEMBER_EMAIL);
  await expect(claimPublicInbox({ teamId: TEAM, key: KEY, claimedByUserId: CLAIMANT })).resolves.toMatchObject({
    status: 'claimed',
  });

  const saved = await saveMovement({ audience: { for: 'run' }, teamId: TEAM as string, source: SOURCE, name: 'deal-intake' });
  if (!saved.ok) throw new Error(`test: the movement did not save: ${JSON.stringify(saved)}`);
  const trigger = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('movement_id', '=', saved.movementId as never)
    .select('id')
    .executeTakeFirstOrThrow();
  triggerId = trigger.id as TriggerId;
});

afterAll(async () => {
  if (previousAddress === undefined) delete process.env.INBOUND_EMAIL_ADDRESS;
  else process.env.INBOUND_EMAIL_ADDRESS = previousAddress;
  setWorkNotifier(inProcessNotifier);
  resetWorkHandlersForTests();
  await getAutomationsQb(['public_inbox']).deleteFrom('public_inbox').where('team_id', '=', TEAM).execute();
  await cleanupTeam(TEAM);
});

/** Deliver mail from `sender` as the inbound handler keeps it, and drain it;
 *  what the run read as its user. */
async function readAs(sender: string): Promise<string | null> {
  const decision = await routeInboundEmail({ recipients: [ADDRESS], senderCandidates: [sender] });
  if (decision.outcome !== 'routed' || decision.route?.trigger?.id !== triggerId) {
    throw new Error(`the door did not route mail from ${sender} to the listener`);
  }
  const messageId = `<${randomUUID()}@startup.example>`;
  const payload = normaliseInboundEmailPayload({
    sender,
    from: sender,
    recipient: ADDRESS,
    subject: 'Our seed round',
    'body-plain': 'Deck attached.',
    'Message-Id': messageId,
  });
  const { fires } = await deliverArrivals({
    teamId: TEAM,
    delivered: { adapterType: 'email', credentialsId: null },
    subscriptionId: 'email',
    externalId: `email:${messageId}`,
    source: 'webhook',
    arrivals: [inboundEmailArrival({ payload, fallbackIdentity: messageId })],
  });
  const fired = fires[0];
  if (fired === undefined) throw new Error(`no listen took mail from ${sender}`);
  await drainUntilIdle({ owner: 'test', teamId: TEAM });

  const run = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', fired.runId as never)
    .select(['status', 'failure_reason'])
    .executeTakeFirstOrThrow();
  expect(run.status).toBe('failed');
  return run.failure_reason?.match(/read as (\S*)/)?.[1] ?? null;
}

describe('the user a public inbox’s run reads', () => {
  it('is whoever claimed the key, for a stranger’s mail', async () => {
    await expect(readAs(FOUNDER_EMAIL)).resolves.toBe(CLAIMANT_EMAIL);
  });

  it('is the member, for a member’s mail', async () => {
    await expect(readAs(MEMBER_EMAIL)).resolves.toBe(MEMBER_EMAIL);
  });
});
