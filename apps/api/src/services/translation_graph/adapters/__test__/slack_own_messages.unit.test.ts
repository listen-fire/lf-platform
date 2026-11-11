// A connection's Slack setting reaches the module: with `drop_own_messages`
// on, the app's own messages and reactions are never read as arrivals; with it
// off, or never written, they are. The module is the real one, behind a fake
// Slack that says who the app is.

const mockPayloads: Map<string, Record<string, unknown>> = new Map();
jest.mock('../../../credentials/secrets_postgres', () => {
  const actual = jest.requireActual('../../../credentials/secrets_postgres');
  const { payloadSecrets } = jest.requireActual('../../../credentials/__test__/payload_secrets');
  return {
    ...actual,
    postgresSecrets: (options: { shape?: unknown }) => payloadSecrets(mockPayloads, options.shape ?? actual.flatPayloadShape),
  };
});

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { FAKE_SLACK_APP_USER, fakeSlackIdentity } from '../../../../test/harness/fake_slack_identity';
import { moduleOnlyAdapterFactory } from '../builtin_modules';

const TEAM = 'team-slack' as TeamId;
const APP_USER = FAKE_SLACK_APP_USER;

const message = (user: string) => ({
  type: 'event_callback',
  team_id: 'T1',
  event_id: `Ev-${user}`,
  event: { type: 'message', user, channel: 'C1', ts: '1700000000.000100', event_ts: '1700000000.000100', text: 'hi' },
});

const reaction = (user: string) => ({
  type: 'event_callback',
  team_id: 'T1',
  event_id: `Ev-react-${user}`,
  event: {
    type: 'reaction_added',
    user,
    reaction: 'eyes',
    item: { type: 'message', channel: 'C1', ts: '1700000000.000100' },
    event_ts: '1700000000.000200',
  },
});

let slack: Awaited<ReturnType<typeof fakeSlackIdentity>>;
let connections = 0;

beforeAll(async () => {
  slack = await fakeSlackIdentity();
});

afterAll(async () => {
  await slack.close();
});

/** The Slack adapter for a connection carrying these settings, under a token of its own (the module caches by token). */
function slackWith(moduleSettings: Record<string, string> | undefined) {
  const credentialsId = `slack-connection-${(connections += 1)}`;
  mockPayloads.set(credentialsId, { accessToken: `xoxb-${credentialsId}`, baseUrl: slack.baseUrl, teamId: 'T1' });
  return moduleOnlyAdapterFactory('slack')({ teamId: TEAM, credentialsId, ...(moduleSettings !== undefined ? { moduleSettings } : {}) });
}

async function arrivalsOf(adapter: ReturnType<typeof slackWith>, raw: unknown): Promise<number> {
  if (adapter.preprocessInbound === undefined) throw new Error('the Slack module reads no inbound deliveries');
  return ((await adapter.preprocessInbound({ raw })).arrivals ?? []).length;
}

describe('a Slack connection that drops its own messages', () => {
  const dropping = { drop_own_messages: 'on' };

  it('hears a member and never the app itself', async () => {
    const adapter = slackWith(dropping);
    expect(await arrivalsOf(adapter, message('UMEMBER'))).toBe(1);
    expect(await arrivalsOf(adapter, message(APP_USER))).toBe(0);
  });

  it("never hears the app's own reaction", async () => {
    const adapter = slackWith(dropping);
    expect(await arrivalsOf(adapter, reaction('UMEMBER'))).toBe(1);
    expect(await arrivalsOf(adapter, reaction(APP_USER))).toBe(0);
  });

  it('hears the app again once the setting is off', async () => {
    expect(await arrivalsOf(slackWith({ drop_own_messages: 'off' }), message(APP_USER))).toBe(1);
  });

  it('hears the app when the connection carries no setting', async () => {
    expect(await arrivalsOf(slackWith(undefined), message(APP_USER))).toBe(1);
    expect(await arrivalsOf(slackWith({}), message(APP_USER))).toBe(1);
  });

  it("speaks over a program's own construction args, since the setting is the connection's", async () => {
    const credentialsId = `slack-connection-${(connections += 1)}`;
    mockPayloads.set(credentialsId, { accessToken: `xoxb-${credentialsId}`, baseUrl: slack.baseUrl, teamId: 'T1' });
    const adapter = moduleOnlyAdapterFactory('slack')({
      teamId: TEAM,
      credentialsId,
      constructionArgs: { drop_own_messages: 'off' },
      moduleSettings: dropping,
    });
    expect(await arrivalsOf(adapter, message(APP_USER))).toBe(0);
  });
});
