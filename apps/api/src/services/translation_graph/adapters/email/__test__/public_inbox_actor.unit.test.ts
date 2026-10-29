// Who a run of an email listener acts as when its key is a public inbox: the
// sender when they are on the team (the chain's own originator step, first),
// otherwise whoever claimed the key while they may still act for the team.
// Any other listener, or a key that is not this team's public inbox, resolves
// exactly as before: to nobody.

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { ActorCandidate } from 'movement-engine/public/adapter';
import type { ActingUserTriggerContext } from '../../acting_user_shared';

const state: {
  inboxes: { key: string; team_id: string; claimed_by_user_id: string; created_at: Date }[];
  teamUsers: Record<string, { id: string; email: string; name: string }>;
  users: Record<string, { id: string; email: string; name: string }>;
  access: Record<string, boolean>;
} = { inboxes: [], teamUsers: {}, users: {}, access: {} };

jest.mock('../../../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    selectFrom: () => {
      let key = '';
      const chain = {
        where: (_column: string, _op: string, value: string) => {
          key = value;
          return chain;
        },
        select: () => chain,
        executeTakeFirst: async () => state.inboxes.find((row) => row.key.toLowerCase() === key.toLowerCase()),
      };
      return chain;
    },
  }),
}));

jest.mock('../../acting_user_shared', () => ({
  applyCreatorOverride: async () => ({ overridden: false }),
  readCreatorFallbackConfig: () => false,
  lookupTeamUserByPhone: async () => null,
  lookupTeamUserByEmail: async ({ email, requireServiceEmail }: { email: string; requireServiceEmail: boolean }) =>
    requireServiceEmail ? null : (state.teamUsers[email] ?? null),
  loadActingUserById: async (id: string) => state.users[id] ?? null,
}));

jest.mock('../../../../principal', () => ({
  principalDirectory: () => ({
    async userById({ id, teamId }: { id: string; teamId: string }) {
      const key = `${id} ${teamId}`;
      return key in state.access ? { id, hasAccess: state.access[key] } : null;
    },
  }),
}));

import { resolveActingUser } from '../../acting_user/resolve';

const TEAM = 'team-1';
const OTHER_TEAM = 'team-2';
const CLAIMANT = { id: 'claimant-1', email: 'claimant@team.com', name: 'claimant' };

function sender(email: string): ActorCandidate {
  return { identity: { identifier: email, scheme: 'email', email }, source: 'originator' };
}

function emailTrigger(key: string, kind = 'email'): ActingUserTriggerContext {
  return { id: 'trigger-1', kind, config: { key }, createdByUserId: 'author-1' };
}

function resolve(trigger: ActingUserTriggerContext, from: string) {
  return resolveActingUser({ teamId: TEAM as TeamId, trigger, getCandidates: async () => [sender(from)] });
}

beforeEach(() => {
  state.inboxes = [{ key: 'deals', team_id: TEAM, claimed_by_user_id: CLAIMANT.id, created_at: new Date(0) }];
  state.teamUsers = {};
  state.users = { [CLAIMANT.id]: CLAIMANT };
  state.access = { [`${CLAIMANT.id} ${TEAM}`]: true };
});

describe('a run on a public inbox', () => {
  it('acts as whoever claimed the key when the sender is nobody on the team', async () => {
    await expect(resolve(emailTrigger('deals'), 'founder@startup.com')).resolves.toEqual(CLAIMANT);
  });

  it('acts as the sender when they are on the team', async () => {
    const ada = { id: 'user-1', email: 'ada@team.com', name: 'ada' };
    state.teamUsers['ada@team.com'] = ada;

    await expect(resolve(emailTrigger('deals'), 'ada@team.com')).resolves.toEqual(ada);
  });

  it('holds for a listener stored under a legacy email kind', async () => {
    await expect(resolve(emailTrigger('deals', 'CUSTOM_EMAIL'), 'founder@startup.com')).resolves.toEqual(CLAIMANT);
  });

  it('acts as nobody once the claimant may no longer act for the team', async () => {
    state.access[`${CLAIMANT.id} ${TEAM}`] = false;

    await expect(resolve(emailTrigger('deals'), 'founder@startup.com')).resolves.toBeNull();
  });

  it('acts as nobody on a key another team holds', async () => {
    state.inboxes[0].team_id = OTHER_TEAM;

    await expect(resolve(emailTrigger('deals'), 'founder@startup.com')).resolves.toBeNull();
  });

  it('leaves a key nobody claimed, and any other adapter, as before', async () => {
    await expect(resolve(emailTrigger('private'), 'founder@startup.com')).resolves.toBeNull();
    await expect(resolve(emailTrigger('deals', 'slack'), 'founder@startup.com')).resolves.toBeNull();
  });
});
