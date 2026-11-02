// resolveActorEmail / getActorCandidates — genuine misses (no actor, no
// client, no email on the profile) swallow to an empty candidate list; a
// `users.info` call that itself FAILS (missing scope, rate limit, network
// outage) must not be swallowed the same way, since a caller can't tell
// "actor unregistered" apart from "couldn't check" once both read as `[]`.
// The Slack web client is mocked by overriding the adapter's private
// getter — no network, no DB.

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import { arrivalTriggerOf, type TriggerEvent } from 'movement-engine/public/inbound';

import { SlackAdapter } from '../index';

const TEAM = 'team-1' as TeamId;

function adapterWithClient(client: unknown): SlackAdapter {
  const adapter = new SlackAdapter(TEAM, 'cred-1');
  (adapter as unknown as { getSlackApiClient: () => Promise<unknown> }).getSlackApiClient =
    async () => client;
  return adapter;
}

/** The run trigger a Slack message's arrival makes, naming `user` as who
 *  acted when it is given, as the module's door does. */
const event = ({ user }: { user?: string }): TriggerEvent =>
  arrivalTriggerOf({
    pipelineInputId: 'listen:test:t1',
    adapterType: 'slack',
    now: new Date(),
    arrival: {
      edge: 'Messages',
      identity: 'C1:1.0',
      landing: { recordId: 'C1:1.0', fields: {} },
      ...(user !== undefined ? { actor: { identifier: user, scheme: 'opaque', adapterType: 'slack', label: user } } : {}),
    },
  });

describe('SlackAdapter#getActorCandidates — lookup failure vs genuine miss', () => {
  it('resolves an empty candidate list when the profile carries no email (genuine miss)', async () => {
    const adapter = adapterWithClient({
      api: { users: { info: async () => ({ user: { profile: {} } }) } },
    });
    await expect(
      adapter.getActorCandidates({ event: event({ user: 'U123' }) }),
    ).resolves.toEqual([]);
  });

  it('resolves an empty candidate list when the event has no actor at all', async () => {
    const adapter = adapterWithClient({
      api: { users: { info: async () => ({ user: { profile: { email: 'ada@example.com' } } }) } },
    });
    await expect(adapter.getActorCandidates({ event: event({}) })).resolves.toEqual([]);
  });

  it('REJECTS (does not swallow to []) when users.info itself fails — a Slack outage', async () => {
    const adapter = adapterWithClient({
      api: {
        users: {
          info: async () => {
            throw new Error('missing_scope');
          },
        },
      },
    });
    await expect(
      adapter.getActorCandidates({ event: event({ user: 'U123' }) }),
    ).rejects.toThrow('missing_scope');
  });
});
