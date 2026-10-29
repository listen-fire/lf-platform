// What a public inbox's run reads as its user (`@user_*`), from the door to
// the engine, against the real tables: the door routes the mail, the receive
// door stores the event and queues it, and a worker drains it through the real
// router, firing and engine, whose `@user_*` asks the host's acting-user
// resolution. A founder writing in reads as whoever claimed the key — the same
// person the run executes as — and a colleague reads as themselves.
//
// The movement says who it read by failing with it: the run's failure reason
// is the one value a credential-less movement can hand back.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../../generated/kysely/core/User';
import type { TriggerId } from '../../../../../generated/kysely/automations/Trigger';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { getAutomationsQb, getCoreQb } from '../../../../../lib/kysely';
import { cleanupTeam } from '../../../../../test/harness/cleanup';
import { saveMovement } from '../../../movement/provision';
import { receiveTriggerEvent, registerDispatchWork } from '../../../triggers/dispatch_event';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../../../work/drain';
import { EMAIL_RECORD_TYPE_ID, normaliseInboundEmailPayload } from '..';
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

function intake(m: <inbox-[:Email]->>) {
  fail("read as \${@user_email}")
}

listen to inbox { key: "${KEY}" } fire intake
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
  registerDispatchWork();
  setWorkNotifier({ notify() {} });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await getCoreQb(['team']).insertInto('team').values({ id: TEAM, name: `public-inbox-user-${RUN}` } as any).execute();
  await person(CLAIMANT, CLAIMANT_EMAIL);
  await person(MEMBER, MEMBER_EMAIL);
  await expect(claimPublicInbox({ teamId: TEAM, key: KEY, claimedByUserId: CLAIMANT })).resolves.toMatchObject({
    status: 'claimed',
  });

  const saved = await saveMovement({ teamId: TEAM as string, source: SOURCE, name: 'deal-intake' });
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

/** The event the inbound handler stores for this mail, as it builds it. */
function storedEvent(sender: string, messageId: string): TriggerEvent {
  return {
    pipelineInputId: `trigger:${triggerId}`,
    adapterType: 'email',
    triggerType: 'webhook',
    payload: normaliseInboundEmailPayload({
      sender,
      from: sender,
      recipient: ADDRESS,
      subject: 'Our seed round',
      'body-plain': 'Deck attached.',
      'Message-Id': messageId,
    }),
    changeType: 'create',
    rootRecordType: EMAIL_RECORD_TYPE_ID,
    idempotencyKey: messageId,
    externalRecordRef: { adapterType: 'email', externalId: messageId, recordType: EMAIL_RECORD_TYPE_ID },
    occurredAt: new Date().toISOString(),
  };
}

/** Deliver mail from `sender` and drain it; what the run read as its user. */
async function readAs(sender: string): Promise<string | null> {
  const decision = await routeInboundEmail({ recipients: [ADDRESS], senderCandidates: [sender] });
  if (decision.outcome !== 'routed' || decision.route?.trigger?.id !== triggerId) {
    throw new Error(`the door did not route mail from ${sender} to the listener`);
  }
  const messageId = `<${randomUUID()}@startup.example>`;
  const received = await receiveTriggerEvent({ teamId: TEAM, triggerId, event: storedEvent(sender, messageId) });
  await drainUntilIdle({ owner: 'test', teamId: TEAM });

  const run = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('trigger_event_id', '=', received.eventId as never)
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
