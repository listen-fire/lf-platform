// A connection carries its module's settings, against a real database and the
// real Slack module: a Slack connection drops its app's own messages from the
// door on, from the day it is made; whoever may use it turns that off and on
// again; and the automation's access view says so.

import { randomUUID } from 'node:crypto';

import { SecretsListed, SecretsRecord } from 'engine-contracts/slots';
import { runWithPrincipal } from 'principal';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

// Connecting and replacing a connection run Attio-only lifecycle hooks that are not the subject here.
jest.mock('../../credentials/credential_lifecycle', () => ({ credentialLifecycle: () => undefined }));

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { connectionsRouter } from '../../../interfaces/trpc/views/connections';
import { credentialsRouter } from '../../../interfaces/trpc/views/credentials';
import { trpc } from '../../../interfaces/trpc/trpc';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { FAKE_SLACK_APP_USER, fakeSlackIdentity } from '../../../test/harness/fake_slack_identity';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen } from '../../../test/harness/listens';
import { Context } from '../../context';
import { StatementStore, type Grantee } from '../../access/statement';
import { persistCredential } from '../../credentials/persist_credential';
import { platformSecretsModule } from '../../lf_secrets/module';
import { userPrincipal } from '../../principal';
import { ProvisioningService } from '../../provisioning';
import { handleSlackEventsInbound } from '../../webhook_sync/slack_events';
import { resolveAdapter } from '../../translation_graph/adapters/resolve';
import { DROP_OWN_MESSAGES, dropsOwnMessagesOn, moduleSettingsFor, setModuleSetting } from '../module_settings';

let slack: Awaited<ReturnType<typeof fakeSlackIdentity>>;
let teamId: TeamId;

beforeAll(async () => {
  slack = await fakeSlackIdentity();
});

afterAll(async () => {
  await slack.close();
});

beforeEach(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `settings-${teamId.slice(0, 8)}` }).execute();
});

afterEach(async () => {
  await getAutomationsQb(['external_service_credentials']).deleteFrom('external_service_credentials').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

const TEAM_GRANT: Grantee[] = [{ kind: 'team' }];

/** A Slack connection of this team, made the way a connect flow makes one, under a workspace of its own. */
async function slackConnection(options: { name: string; workspace: string }): Promise<string> {
  return persistCredential({
    teamId,
    userId: null,
    name: options.name,
    type: ExternalServiceType.SLACK,
    credentials: { accessToken: `xoxb-${options.workspace}`, teamId: options.workspace, baseUrl: slack.baseUrl },
    use: TEAM_GRANT,
  });
}

const settingsOf = async (id: string) =>
  (
    await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', id as ExternalServiceCredentialsId)
      .select('module_settings')
      .executeTakeFirstOrThrow()
  ).module_settings;

async function member(access: 'read' | 'write'): Promise<UserId> {
  return (await ProvisioningService.provisionUser({ teamId, email: `settings-${randomUUID().slice(0, 8)}@example.com`, access })).userId;
}

const message = (workspace: string, user: string) => ({
  type: 'event_callback',
  team_id: workspace,
  event_id: `Ev-${randomUUID()}`,
  event: { type: 'message', user, channel: 'C1', ts: '1700000000.000100', event_ts: '1700000000.000100', text: 'hi' },
});

describe('a new connection', () => {
  it('is written with Slack dropping its own messages, and any other module carrying nothing', async () => {
    const id = await slackConnection({ name: 'Team Slack', workspace: `T-${randomUUID().slice(0, 8)}` });
    expect(await settingsOf(id)).toEqual({ [DROP_OWN_MESSAGES]: 'on' });

    const other = await persistCredential({
      teamId,
      userId: null,
      name: 'Deals',
      type: ExternalServiceType.GOOGLE,
      credentials: { access_token: 'token' },
      use: TEAM_GRANT,
    });
    expect(await settingsOf(other)).toEqual({});
  });

  it('keeps how it was set when it is reconnected with a new key', async () => {
    const workspace = `T-${randomUUID().slice(0, 8)}`;
    const first = await slackConnection({ name: 'Team Slack', workspace });
    expect(await setModuleSetting({ connectionId: first, name: DROP_OWN_MESSAGES, on: false })).toBe('set');

    const second = await persistCredential({
      teamId,
      userId: null,
      name: 'Team Slack',
      type: ExternalServiceType.SLACK,
      credentials: { accessToken: 'xoxb-new', teamId: workspace, baseUrl: slack.baseUrl },
      use: TEAM_GRANT,
      replaceExisting: true,
    });
    expect(second).not.toBe(first);
    expect(await settingsOf(second)).toEqual({ [DROP_OWN_MESSAGES]: 'off' });
  });
});

const writeSettings = (id: string, settings: Record<string, string>) =>
  getAutomationsQb(['external_service_credentials'])
    .updateTable('external_service_credentials')
    .set({ module_settings: settings })
    .where('id', '=', id as ExternalServiceCredentialsId)
    .execute();

describe('a connection filled in place', () => {
  // A row written before its module declared the setting carries {}; filling it must not leave it hearing the app.
  it('gets the default when the person pastes a new token, and a stored "off" stays off', async () => {
    const workspace = `T-${randomUUID().slice(0, 8)}`;
    const id = await slackConnection({ name: 'Team Slack', workspace });
    const writer = await member('write');
    const credentials = { accessToken: 'xoxb-pasted', teamId: workspace, baseUrl: slack.baseUrl };
    // updateCredential reads the request's Context, which a bare principal does not stand in for.
    const update = () => {
      const context = new Context();
      context.bindPrincipal(userPrincipal({ userId: writer, teamId, access: 'write' }));
      return context.runAsync(() =>
        credentialsRouter(trpc.procedure)
          .createCaller({ authorise: async () => {} })
          .updateCredential({ id, name: 'Team Slack', type: ExternalServiceType.SLACK, credentials }),
      );
    };
    await StatementStore.replaceGrants({ thing: 'connection', id }, { teamId, verb: 'use', grantees: [{ kind: 'user', userId: writer }] });

    await writeSettings(id, {});
    await update();
    expect(await settingsOf(id)).toEqual({ [DROP_OWN_MESSAGES]: 'on' });

    await writeSettings(id, { [DROP_OWN_MESSAGES]: 'off' });
    await update();
    expect(await settingsOf(id)).toEqual({ [DROP_OWN_MESSAGES]: 'off' });
  });

  it('gets the default when lf fills it through the secrets module, and a stored "off" stays off', async () => {
    const workspace = `T-${randomUUID().slice(0, 8)}`;
    const id = await slackConnection({ name: 'Team Slack', workspace });
    const lf = platformSecretsModule({ teamId, userId: null, audience: { for: 'run' } });
    const [entry] = SecretsListed.array().parse(await lf['secrets.list']({}));
    if (entry === undefined) throw new Error('the secrets module served no Slack connection');
    const record = SecretsRecord.parse(await lf['secrets.resolve']({ ref: entry.ref }));
    const replace = () => lf['secrets.replace']({ ref: entry.ref, external: entry.external, binding: entry.binding, fields: record.fields });

    await writeSettings(id, {});
    await replace();
    expect(await settingsOf(id)).toEqual({ [DROP_OWN_MESSAGES]: 'on' });

    await writeSettings(id, { [DROP_OWN_MESSAGES]: 'off' });
    await replace();
    expect(await settingsOf(id)).toEqual({ [DROP_OWN_MESSAGES]: 'off' });
  });
});

describe('the door', () => {
  it('never lets the app’s own message through while the connection drops it, and lets it through once the line is removed', async () => {
    const workspace = `T-${randomUUID().slice(0, 8)}`;
    const id = await slackConnection({ name: 'Team Slack', workspace });

    const own = message(workspace, FAKE_SLACK_APP_USER);
    expect(await handleSlackEventsInbound(own)).toMatchObject({ classification: 'no_events' });

    // A member's message still arrives.
    expect(await handleSlackEventsInbound(message(workspace, 'UMEMBER'))).toMatchObject({ classification: 'dispatched' });

    await setModuleSetting({ connectionId: id, name: DROP_OWN_MESSAGES, on: false });
    expect(await handleSlackEventsInbound(message(workspace, FAKE_SLACK_APP_USER))).toMatchObject({ classification: 'dispatched' });

    await setModuleSetting({ connectionId: id, name: DROP_OWN_MESSAGES, on: true });
    expect(await handleSlackEventsInbound(message(workspace, FAKE_SLACK_APP_USER))).toMatchObject({ classification: 'no_events' });
  });

  it('drops the app’s own message on a connection whose cell lacks the key, as its module declares, and a stored "off" stays off', async () => {
    const workspace = `T-${randomUUID().slice(0, 8)}`;
    const id = await slackConnection({ name: 'Team Slack', workspace });
    await writeSettings(id, {});
    expect(await moduleSettingsFor({ adapterType: 'slack', teamId, credentialsId: id })).toEqual({ [DROP_OWN_MESSAGES]: 'on' });
    expect(await handleSlackEventsInbound(message(workspace, FAKE_SLACK_APP_USER))).toMatchObject({ classification: 'no_events' });

    await writeSettings(id, { [DROP_OWN_MESSAGES]: 'off' });
    expect(await moduleSettingsFor({ adapterType: 'slack', teamId, credentialsId: id })).toEqual({ [DROP_OWN_MESSAGES]: 'off' });
  });

  it('reads the connection’s setting when the module is resolved, and none for a module that declares none', async () => {
    const id = await slackConnection({ name: 'Team Slack', workspace: `T-${randomUUID().slice(0, 8)}` });
    expect(await moduleSettingsFor({ adapterType: 'slack', teamId, credentialsId: id })).toEqual({ [DROP_OWN_MESSAGES]: 'on' });
    expect(await moduleSettingsFor({ adapterType: 'attio', teamId, credentialsId: id })).toBeUndefined();
    const adapter = await resolveAdapter({ adapterType: 'slack', teamId, credentialsId: id });
    expect(adapter.preprocessInbound).toBeDefined();
  });
});

describe('changing a setting', () => {
  it('refuses a setting the connection’s module does not declare, and a connection that is gone', async () => {
    const other = await persistCredential({
      teamId,
      userId: null,
      name: 'Deals',
      type: ExternalServiceType.GOOGLE,
      credentials: { access_token: 'token' },
      use: TEAM_GRANT,
    });
    expect(await setModuleSetting({ connectionId: other, name: DROP_OWN_MESSAGES, on: true })).toBe('not_a_setting');
    expect(await settingsOf(other)).toEqual({});
    expect(await setModuleSetting({ connectionId: randomUUID(), name: DROP_OWN_MESSAGES, on: true })).toBe('not_found');
  });

  it('is the route’s to allow: whoever may use the connection with write on the team, and no one else', async () => {
    const id = await slackConnection({ name: 'Team Slack', workspace: `T-${randomUUID().slice(0, 8)}` });
    const [writer, other, reader] = [await member('write'), await member('write'), await member('read')];
    await StatementStore.replaceGrants({ thing: 'connection', id }, { teamId, verb: 'use', grantees: [{ kind: 'user', userId: writer }, { kind: 'user', userId: reader }] });

    const call = (userId: UserId, access: 'read' | 'write', on: boolean) =>
      runWithPrincipal(userPrincipal({ userId, teamId, access }), () =>
        connectionsRouter(trpc.procedure).createCaller({ authorise: async () => {} }).setModuleSetting({ id, setting: DROP_OWN_MESSAGES, on }),
      );

    await expect(call(other, 'write', false)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await settingsOf(id)).toEqual({ [DROP_OWN_MESSAGES]: 'on' });
    await expect(call(reader, 'read', false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await settingsOf(id)).toEqual({ [DROP_OWN_MESSAGES]: 'on' });

    expect(await call(writer, 'write', false)).toEqual({ ok: true });
    expect(await settingsOf(id)).toEqual({ [DROP_OWN_MESSAGES]: 'off' });
    expect(await call(writer, 'write', true)).toEqual({ ok: true });
    expect(await settingsOf(id)).toEqual({ [DROP_OWN_MESSAGES]: 'on' });
  });
});

describe('the automation that listens on it', () => {
  it('finds each Slack connection it listens on, and whether it drops the app’s own messages', async () => {
    const id = await slackConnection({ name: 'Team Slack', workspace: `T-${randomUUID().slice(0, 8)}` });
    const movementId = randomUUID() as MovementId;
    await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'Deals', source: '' }).execute();
    await insertTestListen({ teamId, movementId, adapterType: 'slack', edge: 'Messages', delivery: 'connection', credentialsId: id });

    expect(await dropsOwnMessagesOn(movementId)).toEqual([{ connectionId: id, name: 'Team Slack', on: true }]);
    await writeSettings(id, {});
    expect(await dropsOwnMessagesOn(movementId)).toEqual([{ connectionId: id, name: 'Team Slack', on: true }]);

    await setModuleSetting({ connectionId: id, name: DROP_OWN_MESSAGES, on: false });
    expect(await dropsOwnMessagesOn(movementId)).toEqual([{ connectionId: id, name: 'Team Slack', on: false }]);
  });
});
