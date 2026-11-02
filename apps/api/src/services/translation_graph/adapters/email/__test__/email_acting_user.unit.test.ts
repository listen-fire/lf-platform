// The inbound email door's sender gate reads who sent a message the way every
// run of it does: the email module's candidates for the run trigger the
// email's arrival makes. Under adapter protocol 2.7 (listen-fire 0.13.1) the
// sender rides on the arrival (`actor`) and the trigger copies it; under
// 0.13.0 the module reads a 0.12 trigger payload no arrival trigger carries,
// so the gate finds no sender. Flip to `it` once the platform takes 0.13.1
// and its email arrival carries the module's actor.

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
  it.failing('names the sender as the originator, read off the arrival the door delivers', async () => {
    const arrival = inboundEmailArrival({
      payload: { sender: 'ada@example.com', From: 'Ada <ada@example.com>', recipient: 'inbox+deals@example.com', subject: 'Intro', messageId: '<m1@example.com>' },
      fallbackIdentity: 'request-1',
    });

    await emailActingUser({ teamId: TEAM, arrival });

    expect(seen).toContainEqual(expect.objectContaining({ source: 'originator', identity: expect.objectContaining({ email: 'ada@example.com' }) }));
  });
});
