// What a connection carries for the settings its module declares: which it is
// written with, which a call reads, and which it may be asked to change.

const mockRows: { table: string; rows: unknown[] }[] = [];
const mockQueries: string[] = [];

jest.mock('../../../lib/kysely', () => {
  const stub = (): unknown => {
    let rows: unknown[] = [];
    const chain: object = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') return undefined;
          if (prop === 'selectFrom') {
            return (name: string) => {
              mockQueries.push(name);
              rows = mockRows.find((entry) => entry.table === name)?.rows ?? [];
              return chain;
            };
          }
          if (prop === 'execute') return async () => rows;
          if (prop === 'executeTakeFirst') return async () => rows[0];
          return () => chain;
        },
      },
    );
    return chain;
  };
  return { getQb: stub, getCoreQb: stub, getAutomationsQb: stub };
});

import type { TeamId } from '../../../generated/kysely/core/Team';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { DROP_OWN_MESSAGES, dropsOwnMessagesOn, moduleSettingsFor, settingsAtCreation } from '../module_settings';

const TEAM = '11111111-1111-4111-8111-111111111111' as TeamId;
const CONNECTION = 'c0000000-0000-4000-8000-000000000001';

beforeEach(() => {
  mockRows.length = 0;
  mockQueries.length = 0;
});

describe('the settings a new connection is written with', () => {
  it('has Slack drop its own messages, and every other connection carry none', () => {
    expect(settingsAtCreation(ExternalServiceType.SLACK)).toEqual({ [DROP_OWN_MESSAGES]: 'on' });
    expect(settingsAtCreation(ExternalServiceType.ATTIO)).toEqual({});
    expect(settingsAtCreation(ExternalServiceType.TELEGRAM)).toEqual({});
  });
});

describe('the settings a call of a connection is made with', () => {
  it('are the connection’s own, for a module that declares them', async () => {
    mockRows.push({ table: 'external_service_credentials', rows: [{ module_settings: { drop_own_messages: 'on' } }] });
    expect(await moduleSettingsFor({ adapterType: 'slack', teamId: TEAM, credentialsId: CONNECTION })).toEqual({ drop_own_messages: 'on' });
  });

  it('leave out what the module does not declare', async () => {
    mockRows.push({ table: 'external_service_credentials', rows: [{ module_settings: { drop_own_messages: 'off', stale: 'x' } }] });
    expect(await moduleSettingsFor({ adapterType: 'slack', teamId: TEAM, credentialsId: CONNECTION })).toEqual({ drop_own_messages: 'off' });
  });

  it('are none for a connection that is gone', async () => {
    expect(await moduleSettingsFor({ adapterType: 'slack', teamId: TEAM, credentialsId: CONNECTION })).toEqual({});
  });

  it('cost no read for a module that declares none, or a call that names no connection', async () => {
    expect(await moduleSettingsFor({ adapterType: 'attio', teamId: TEAM, credentialsId: CONNECTION })).toBeUndefined();
    expect(await moduleSettingsFor({ adapterType: 'slack', teamId: TEAM })).toBeUndefined();
    expect(mockQueries).toEqual([]);
  });

  it('refuse a stored cell that is not a map of strings, rather than run without it', async () => {
    mockRows.push({ table: 'external_service_credentials', rows: [{ module_settings: { drop_own_messages: true } }] });
    await expect(moduleSettingsFor({ adapterType: 'slack', teamId: TEAM, credentialsId: CONNECTION })).rejects.toThrow(/module_settings/);
  });
});

describe('the connections an automation listens on that drop the app’s own messages', () => {
  const slackListen = { kind: 'slack', credentials_id: CONNECTION };

  it('say whether each does', async () => {
    mockRows.push(
      { table: 'trigger', rows: [slackListen, slackListen] },
      { table: 'external_service_credentials', rows: [{ id: CONNECTION, name: 'Team Slack', module_settings: { drop_own_messages: 'on' } }] },
    );
    expect(await dropsOwnMessagesOn('a')).toEqual([{ connectionId: CONNECTION, name: 'Team Slack', on: true }]);

    mockRows[1] = { table: 'external_service_credentials', rows: [{ id: CONNECTION, name: 'Team Slack', module_settings: { drop_own_messages: 'off' } }] };
    expect(await dropsOwnMessagesOn('a')).toEqual([{ connectionId: CONNECTION, name: 'Team Slack', on: false }]);
  });

  it('count a connection with no setting as one that hears the app', async () => {
    mockRows.push(
      { table: 'trigger', rows: [slackListen] },
      { table: 'external_service_credentials', rows: [{ id: CONNECTION, name: 'Team Slack', module_settings: {} }] },
    );
    expect(await dropsOwnMessagesOn('a')).toEqual([{ connectionId: CONNECTION, name: 'Team Slack', on: false }]);
  });

  it('are none for listens on other modules, or on no connection', async () => {
    mockRows.push({
      table: 'trigger',
      rows: [
        { kind: 'attio', credentials_id: CONNECTION },
        { kind: 'slack', credentials_id: null },
        { kind: 'cron', credentials_id: null },
      ],
    });
    expect(await dropsOwnMessagesOn('a')).toEqual([]);
    expect(mockQueries).toEqual(['trigger']);
  });
});
