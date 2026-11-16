// A WhatsApp sender, by phone, through Listen-Fire's `resolveActingUser`: the
// phone twin of `adapter-email-acting-user.unit.test.ts`. 0.16's WhatsApp
// module names no actor (it publishes the `Sender Phone` claim), so the
// candidate is the one a module from before 0.16 named, as a carried run hands
// it to the platform (`RunPlatform.actingUser`).
//
// The auth chain:
//   1. Sender (`From`) as a `scheme: 'phone'` `originator` → the
//      `automations.phone_number` link, then the owning user in core —
//      two reads since the carve (D3/D28), scoped to the team and gated on
//      granted access.
//   2. Otherwise → null. Dispatcher rejects.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ActingUserTriggerContext } from '../adapters/acting_user_shared';
import type { ActorCandidate } from '../adapters/acting_user/actor';

// DB mock: each `where` chain ends in an `executeTakeFirst` that returns
// the next queued row. Tests queue rows in the order the resolver looks
// them up. Every `where(...)` call is recorded into `whereCalls` so tests
// can assert the *predicates* a query issued — the row is returned
// regardless of predicates, so without this the mock would green-light a
// query that dropped its auth gate (the exact false-positive we're guarding
// against).
const dbQueue: Array<unknown> = [];
const whereCalls: unknown[][] = [];
function setDbRow(row: unknown) {
  dbQueue.push(row);
}
function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_t: object, prop: string | symbol): unknown {
      if (prop === 'executeTakeFirst') return async () => dbQueue.shift() ?? null;
      if (prop === 'execute') return async () => [];
      if (prop === 'then') return undefined;
      return (...args: unknown[]) => {
        if (prop === 'where') whereCalls.push(args);
        return mockChainable();
      };
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

import { resolveActingUser } from '../adapters/acting_user/resolve';

const TEAM_ID = 'team-1' as TeamId;

function identify(input: {
  sender?: { phone: string; name?: string };
  trigger?: ActingUserTriggerContext;
}) {
  return resolveActingUser({
    teamId: TEAM_ID,
    trigger: input.trigger,
    getCandidates: async () => (input.sender === undefined ? [] : [whatsappSender(input.sender)]),
  });
}

/** A WhatsApp sender as a module from before 0.16 named them: the phone
 *  without its `whatsapp:` prefix, the profile name as label. */
function whatsappSender(sender: { phone: string; name?: string }): ActorCandidate {
  return {
    identity: {
      identifier: sender.phone,
      scheme: 'phone',
      adapterType: 'whatsapp',
      ...(sender.name !== undefined ? { name: sender.name } : {}),
      label: sender.name ?? sender.phone,
    },
    source: 'originator',
  };
}

beforeEach(() => {
  dbQueue.length = 0;
  whereCalls.length = 0;
});

describe('WhatsApp acting-user — creator override (T6)', () => {
  it('overrides to creator when overrideActingUserToCreator is set (skips sender chain)', async () => {
    setDbRow({ id: 'creator-1', email: 'creator@example.com', username: 'creator' });
    const user = await identify({
      sender: { phone: '+15551234567' },
      trigger: {
        id: 't-1',
        kind: 'TWILIO',
        config: { overrideActingUserToCreator: true },
        createdByUserId: 'creator-1',
      },
    });
    expect(user).toEqual({ id: 'creator-1', email: 'creator@example.com', name: 'creator' });
  });

  it('rejects when override is on but the trigger has no creator', async () => {
    const user = await identify({
      sender: { phone: '+15551234567' },
      trigger: {
        id: 't-1',
        kind: 'TWILIO',
        config: { overrideActingUserToCreator: true },
        createdByUserId: null,
      },
    });
    expect(user).toBeNull();
  });
});

describe('WhatsApp acting-user', () => {
  it('authenticates as sender when the phone matches a team phone_number', async () => {
    setDbRow({ user_id: 'u-1' });
    setDbRow({ id: 'u-1', email: 'ada@example.com', username: 'ada' });
    const user = await identify({
      sender: { phone: '+15551234567', name: 'Ada' },
    });
    expect(user).toEqual({
      id: 'u-1',
      email: 'ada@example.com',
      name: 'ada',
    });
  });

  it('falls back to username for display email when the user has no primary email', async () => {
    setDbRow({ user_id: 'u-3' });
    setDbRow({ id: 'u-3', email: null, username: 'svcuser' });
    const user = await identify({
      sender: { phone: '+15559999999' },
    });
    expect(user).toEqual({ id: 'u-3', email: 'svcuser', name: 'svcuser' });
  });

  it('rejects when the sender phone maps to no team user', async () => {
    // The number is linked, but the user fails the team + granted-access gate.
    setDbRow({ user_id: 'u-9' });
    setDbRow(null);
    const user = await identify({
      sender: { phone: '+15550000000' },
    });
    expect(user).toBeNull();
  });

  it('gates phone resolution on the granted-access predicate (auth boundary)', async () => {
    // Parity with v3 `unauthorisedGetUserByPhone`, which requires
    // `grantedAccessAt: { not: null }`. Without this predicate an
    // invited/pending/revoked user whose number is on the team would
    // authenticate. We assert the query actually issues the gate rather
    // than trusting the (predicate-blind) row mock.
    setDbRow({ user_id: 'u-1' });
    setDbRow({ id: 'u-1', email: 'ada@example.com', username: 'ada' });
    await identify({
      sender: { phone: '+15551234567' },
    });
    expect(whereCalls).toContainEqual(['u.granted_access_at', 'is not', null]);
  });

  it('rejects when the sender phone is not linked at all', async () => {
    setDbRow(null);
    const user = await identify({
      sender: { phone: '+15550000000' },
    });
    expect(user).toBeNull();
  });

  it('returns null when nobody is named', async () => {
    const user = await identify({});
    expect(user).toBeNull();
  });
});
