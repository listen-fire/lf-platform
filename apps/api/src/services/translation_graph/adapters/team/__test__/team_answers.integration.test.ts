// `team.isMember` and `team.userFor` over the platform's real tables, and the
// kept answers they feed: a membership that ends is gone from the next answer,
// whichever process ended it, because the database says so on its change channel.

import { randomUUID } from 'node:crypto';

import type { PluginQuestion } from 'engine-contracts';
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../../generated/kysely/core/User';

import { getAutomationsQb, getCoreQb } from '../../../../../lib/kysely';
import { cleanupTeam } from '../../../../../test/harness/cleanup';
import { ProvisioningService } from '../../../../provisioning';
import { platformPluginAnswers, startTeamAnswerFeed } from '../../../../inbound/platform_plugin_answers';
import { PluginAnswerCache, type PluginAnswer } from '../../../../inbound/plugin_answers';
import { builtinPluginModule } from '../../builtin_modules';

const IS_MEMBER = '@lf-platform/team/is_member';
const USER_FOR = '@lf-platform/team/user_for';

let team: TeamId;
let elsewhere: TeamId;
const phones: string[] = [];

function suffix(): string {
  return randomUUID().slice(0, 8);
}

async function makeTeam(label: string): Promise<TeamId> {
  const id = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id, name: `team-answers-${label}-${suffix()}` }).execute();
  return id;
}

async function member(input: { in: TeamId; email: string; access?: 'read' | 'write' | 'admin'; name?: string }): Promise<UserId> {
  const provisioned = await ProvisioningService.provisionUser({
    teamId: input.in,
    email: input.email,
    access: input.access ?? 'write',
    ...(input.name !== undefined ? { name: input.name } : {}),
  });
  return provisioned.userId;
}

async function link(input: { userId: UserId; phone: string; verified?: boolean }): Promise<void> {
  phones.push(input.phone);
  await getAutomationsQb(['phone_number'])
    .insertInto('phone_number')
    .values({ user_id: input.userId, phone_number: input.phone, verified_at: input.verified === false ? null : new Date() })
    .execute();
}

async function invoke(plugin: string, forTeam: TeamId, claim: string): Promise<unknown> {
  const loaded = builtinPluginModule(plugin, { teamId: forTeam });
  if (loaded === undefined) throw new Error(`test: no module serves ${plugin}`);
  const answered = await loaded.invoke({ name: plugin.split('/').pop() ?? plugin, config: { claim }, extractedContext: {} });
  return answered.data?.value;
}

const isMember = (claim: string, forTeam: TeamId = team) => invoke(IS_MEMBER, forTeam, claim);
const userFor = (claim: string, forTeam: TeamId = team) => invoke(USER_FOR, forTeam, claim);

beforeEach(async () => {
  team = await makeTeam('a');
  elsewhere = await makeTeam('b');
});

afterEach(async () => {
  for (const phone of phones.splice(0)) await getAutomationsQb(['phone_number']).deleteFrom('phone_number').where('phone_number', '=', phone).execute();
  // A user may belong to a team they do not prefer, which would block removing the one they do.
  await getCoreQb(['team_membership']).deleteFrom('team_membership').where('team_id', 'in', [team, elsewhere]).execute();
  await cleanupTeam(team);
  await cleanupTeam(elsewhere);
});

describe('team.isMember over the platform’s tables', () => {
  it('a_member_by_email_is_a_member', async () => {
    await member({ in: team, email: `ada-${suffix()}@acme.test` });
    const email = `grace-${suffix()}@acme.test`;
    await member({ in: team, email });
    expect(await isMember(email)).toBe(true);
    expect(await isMember(email.toUpperCase())).toBe(true);
    expect(await isMember(`nobody-${suffix()}@acme.test`)).toBe(false);
  });

  it('matches plus addressing only where the address accepts it, and never a service address', async () => {
    const base = `lin-${suffix()}`;
    const userId = await member({ in: team, email: `${base}@acme.test` });
    expect(await isMember(`${base}+notes@acme.test`)).toBe(false);
    await getCoreQb(['user_email']).updateTable('user_email').set({ accepts_plus_addressing: true }).where('user_id', '=', userId).execute();
    expect(await isMember(`${base}+notes@acme.test`)).toBe(true);
    await getCoreQb(['user_email']).updateTable('user_email').set({ is_service_email: true }).where('user_id', '=', userId).execute();
    expect(await isMember(`${base}@acme.test`)).toBe(false);
    expect(await isMember(`${base}+notes@acme.test`)).toBe(false);
  });

  it('a_member_of_another_team_is_not', async () => {
    const otherEmail = `bob-${suffix()}@acme.test`;
    await member({ in: elsewhere, email: otherEmail });
    expect(await isMember(otherEmail)).toBe(false);
    expect(await isMember(otherEmail, elsewhere)).toBe(true);

    // The team a user prefers says nothing: their membership rows do.
    const sharedEmail = `carol-${suffix()}@acme.test`;
    const carol = await member({ in: elsewhere, email: sharedEmail });
    await getCoreQb(['team_membership']).insertInto('team_membership').values({ user_id: carol, team_id: team, access: 'read', is_personal: false }).execute();
    expect(await isMember(sharedEmail)).toBe(true);

    const droppedEmail = `dana-${suffix()}@acme.test`;
    const dana = await member({ in: team, email: droppedEmail });
    await getCoreQb(['team_membership']).deleteFrom('team_membership').where('user_id', '=', dana).where('team_id', '=', team).execute();
    expect(await isMember(droppedEmail)).toBe(false);
  });

  it('an_email_without_granted_access_is_not', async () => {
    const email = `ora-${suffix()}@acme.test`;
    const userId = await member({ in: team, email });
    expect(await isMember(email)).toBe(true);

    await getCoreQb(['user']).updateTable('user').set({ granted_access_at: null }).where('id', '=', userId).execute();
    expect(await isMember(email)).toBe(false);
    expect(await userFor(email)).toBeNull();
  });

  it('a_phone_without_granted_access_is_not', async () => {
    const phone = `+4477009${Math.floor(10000 + Math.random() * 89999)}`;
    const userId = await member({ in: team, email: `eve-${suffix()}@acme.test` });
    await link({ userId, phone });
    expect(await isMember(phone)).toBe(true);

    await getCoreQb(['user']).updateTable('user').set({ granted_access_at: null }).where('id', '=', userId).execute();
    expect(await isMember(phone)).toBe(false);
  });

  it('does not trust a phone link that was never verified, or one of another team’s member', async () => {
    const unverified = `+4477008${Math.floor(10000 + Math.random() * 89999)}`;
    await link({ userId: await member({ in: team, email: `fay-${suffix()}@acme.test` }), phone: unverified, verified: false });
    expect(await isMember(unverified)).toBe(false);

    const theirs = `+4477007${Math.floor(10000 + Math.random() * 89999)}`;
    await link({ userId: await member({ in: elsewhere, email: `gus-${suffix()}@acme.test` }), phone: theirs });
    expect(await isMember(theirs)).toBe(false);
    expect(await isMember(theirs, elsewhere)).toBe(true);
  });
});

describe('team.userFor over the platform’s tables', () => {
  it('user_for_returns_the_level', async () => {
    const adminEmail = `hal-${suffix()}@acme.test`;
    const readerEmail = `ida-${suffix()}@acme.test`;
    const hal = await member({ in: team, email: adminEmail, access: 'admin', name: 'Hal Jones' });
    await member({ in: team, email: readerEmail, access: 'read' });

    expect(await userFor(adminEmail)).toEqual({ Id: hal, Email: adminEmail, Name: 'Hal Jones', Level: 'admin' });
    expect(await userFor(readerEmail)).toMatchObject({ Email: readerEmail, Level: 'read' });
    expect(await userFor(`nobody-${suffix()}@acme.test`)).toBeNull();
  });

  it('answers the level of the invoking team, not another’s', async () => {
    const email = `jo-${suffix()}@acme.test`;
    const jo = await member({ in: team, email, access: 'admin' });
    await getCoreQb(['team_membership']).insertInto('team_membership').values({ user_id: jo, team_id: elsewhere, access: 'read', is_personal: false }).execute();
    expect(await userFor(email)).toMatchObject({ Level: 'admin' });
    expect(await userFor(email, elsewhere)).toMatchObject({ Level: 'read' });
  });

  it('names a user by their username when they have no name', async () => {
    const email = `kit-${suffix()}@acme.test`;
    await member({ in: team, email });
    expect(await userFor(email)).toMatchObject({ Name: email.split('@')[0] });
  });
});

describe('the answers kept for team.isMember', () => {
  let stopFeed: () => Promise<void>;
  let lastForgotten = 0;

  beforeAll(() => {
    // Creating a member is itself a membership change the feed delivers a moment
    // later; a test sets its member up, waits for that to pass, and only then asks.
    const invalidateTeam = PluginAnswerCache.prototype.invalidateTeam;
    jest.spyOn(PluginAnswerCache.prototype, 'invalidateTeam').mockImplementation(function (this: PluginAnswerCache, teamId: string) {
      lastForgotten = Date.now();
      return invalidateTeam.call(this, teamId);
    });
    stopFeed = startTeamAnswerFeed();
  });

  afterAll(async () => {
    await stopFeed();
    jest.restoreAllMocks();
  });

  /** Returns once the feed has said nothing for a while. */
  async function settled(): Promise<void> {
    lastForgotten = Date.now();
    while (Date.now() - lastForgotten < 300) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /** The judge's question, answered by the platform's module and kept by its cache. */
  function questionFor(claim: string) {
    const asked: PluginQuestion[] = [];
    const ask = async (question: PluginQuestion): Promise<PluginAnswer> => {
      asked.push(question);
      return { value: await isMember(String(question.args[0])) };
    };
    const question: PluginQuestion = { plugin: IS_MEMBER, args: [claim] };
    return { asked, answer: async () => (await platformPluginAnswers().answers(team, [question], ask))[0] };
  }

  async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const value = await read();
      if (done(value) || Date.now() > deadline) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it('removing_a_member_clears_their_cached_answer', async () => {
    const email = `lou-${suffix()}@acme.test`;
    const lou = await member({ in: team, email });
    await settled();
    const { asked, answer } = questionFor(email);

    expect(await answer()).toMatchObject({ value: true });
    expect(await answer()).toMatchObject({ value: true });
    expect(asked).toHaveLength(1);

    await getCoreQb(['team_membership']).deleteFrom('team_membership').where('user_id', '=', lou).where('team_id', '=', team).execute();

    const next = await until(answer, (a) => 'value' in a && a.value === false);
    expect(next).toMatchObject({ value: false });
    expect(asked).toHaveLength(2);
  });

  it('forgets a person’s answers in every team they belong to when their email changes', async () => {
    const email = `max-${suffix()}@acme.test`;
    const max = await member({ in: team, email });
    await settled();
    const { answer } = questionFor(email);
    expect(await answer()).toMatchObject({ value: true });

    await getCoreQb(['user_email']).deleteFrom('user_email').where('user_id', '=', max).execute();

    expect(await until(answer, (a) => 'value' in a && a.value === false)).toMatchObject({ value: false });
  });

  it('forgets a phone’s answer when its access is revoked', async () => {
    const phone = `+4477006${Math.floor(10000 + Math.random() * 89999)}`;
    const nat = await member({ in: team, email: `nat-${suffix()}@acme.test` });
    await link({ userId: nat, phone });
    await settled();
    const { answer } = questionFor(phone);
    expect(await answer()).toMatchObject({ value: true });

    await getCoreQb(['user']).updateTable('user').set({ granted_access_at: null }).where('id', '=', nat).execute();

    expect(await until(answer, (a) => 'value' in a && a.value === false)).toMatchObject({ value: false });
  });

  it('forgets an email’s answer when its access is revoked', async () => {
    const email = `pam-${suffix()}@acme.test`;
    const pam = await member({ in: team, email });
    await settled();
    const { answer } = questionFor(email);
    expect(await answer()).toMatchObject({ value: true });

    await getCoreQb(['user']).updateTable('user').set({ granted_access_at: null }).where('id', '=', pam).execute();

    expect(await until(answer, (a) => 'value' in a && a.value === false)).toMatchObject({ value: false });
  });
});
