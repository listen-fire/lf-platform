// Who sent a Telegram message is the team-scoped claim its module publishes
// (`Sender Email`, a `claim:email/address`, listen-fire 0.16): the address the
// sender bound by handshake on THIS team. A same-email binding in another team
// is invisible from teamA's arrivals, so a filter's host function that takes
// the claim can never be handed another team's address.
//
// Path under test:
//   TelegramAdapter.preprocessInbound   (telegram_user_id → email, team-scoped, on the landing)
//
// The DB leaf is mocked: `getAutomationsQb` models `telegram_identity` (the
// team-scoped binding store), so the test exercises the real scope logic
// rather than asserting it abstractly.

import type { TeamId } from '../../../../../generated/kysely/core/Team';

jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

// ── telegram_identity store: (team_id, telegram_user_id) → email ──────────────
const identityStore = new Map<string, string>();
const identityKey = (teamId: string, tgUserId: string) => `${teamId}::${tgUserId}`;

jest.mock('../../../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    selectFrom: () => {
      const filters: Record<string, string> = {};
      const builder = {
        where: (column: string, _op: string, value: string) => {
          filters[column] = value;
          return builder;
        },
        select: () => ({
          executeTakeFirst: async () => {
            const email = identityStore.get(
              identityKey(filters['team_id'], filters['telegram_user_id']),
            );
            return email ? { email } : undefined;
          },
        }),
      };
      return builder;
    },
  }),
}));

import { TelegramAdapter } from '../index';

const TEAM_A = 'team-A' as TeamId;
const TEAM_B = 'team-B' as TeamId;
const TG_USER = '123';
const EMAIL = 'shared@example.com';

/** What a message from `TG_USER` lands as on `adapter`'s team: the door looks
 *  the sender's binding up and names the address as the claim. */
async function senderEmailOf(adapter: TelegramAdapter): Promise<unknown> {
  const { arrivals } = await adapter.preprocessInbound({
    raw: {
      update_id: 1,
      message: {
        message_id: 42,
        date: 1_762_084_800,
        chat: { id: 777, type: 'private' },
        from: { id: Number(TG_USER), is_bot: false, first_name: 'Ada', username: 'adas' },
        text: 'hi',
      },
    },
  });
  const [arrival] = arrivals;
  if (arrival === undefined || 'gone' in arrival) throw new Error('the update made no arrival');
  return arrival.landing.fields['Sender Email'];
}

beforeEach(() => {
  identityStore.clear();
});

describe('Telegram sender claim (team-scoped binding)', () => {
  it('a bound id lands with the address it bound on this team', async () => {
    identityStore.set(identityKey(TEAM_A, TG_USER), EMAIL);
    expect(await senderEmailOf(new TelegramAdapter(TEAM_A, 'cred-1'))).toBe(EMAIL);
  });

  it('a binding held by another team is invisible: no claim', async () => {
    identityStore.set(identityKey(TEAM_A, TG_USER), EMAIL);
    expect(await senderEmailOf(new TelegramAdapter(TEAM_B, 'cred-1'))).toBeNull();
  });

  it('an unbound sender lands with no claim', async () => {
    expect(await senderEmailOf(new TelegramAdapter(TEAM_A, 'cred-1'))).toBeNull();
  });
});
