// The inbound email door's sender gate reads who sent a message the way every
// run of it does: the platform's parse of the arrival's fields (the email
// module names no sender from 0.16).

import type { TeamId } from '../../../../../generated/kysely/core/Team';

const seen: unknown[] = [];
jest.mock('../../acting_user/resolve', () => ({
  resolveActingUser: async (input: { getCandidates: () => Promise<unknown[]> }) => {
    const candidates = await input.getCandidates();
    seen.push(...candidates);
    return null;
  },
}));

import { emailActingUser, inboundEmailArrival } from '../arrival';

const TEAM = '11111111-2222-3333-4444-555555555555' as TeamId;

beforeEach(() => {
  seen.length = 0;
});

describe('emailActingUser: who an inbound email is from', () => {
  it('names the sender as the originator, read off the arrival`s fields', async () => {
    const arrival = inboundEmailArrival({
      payload: { sender: 'ada@example.com', From: 'Ada <ada@example.com>', recipient: 'inbox+deals@example.com', subject: 'Intro', messageId: '<m1@example.com>' },
      fallbackIdentity: 'request-1',
    });

    await emailActingUser({ teamId: TEAM, arrival });

    expect(seen).toContainEqual(expect.objectContaining({ source: 'originator', identity: expect.objectContaining({ email: 'ada@example.com' }) }));
  });
});
