// What a team import says of who may reach the automations and connections it
// brings, on a real database. A bundle cut before statements existed carries
// none, and a thing with none admits nobody, so the import gives each the reach
// a creation with no person gets; one that arrived with its statements keeps them.

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang';
import { Client } from 'pg';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';

import { getAutomationsQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { StatementStore, type Target } from '../../access/statement';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import { anyoneWhereFireIsNotKeptTo, stateWhatIsUnstated } from '../../access/state_unstated';

let teamId: TeamId;
let client: Client;

beforeEach(async () => {
  teamId = randomUUID() as TeamId;
  client = new Client({ connectionString: process.env.DATABASE_URL_TEST });
  await client.connect();
});

afterEach(async () => {
  await client.end();
  await cleanupTeam(teamId);
});

async function automation(name: string, source = '', languageVersion: LanguageVersion = LANGUAGE_VERSION): Promise<MovementId> {
  const id = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    .values({ id, team_id: teamId, name, source, language_version: languageVersion })
    .execute();
  return id;
}

async function connection(name: string): Promise<ExternalServiceCredentialsId> {
  const id = randomUUID() as ExternalServiceCredentialsId;
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({ id, team_id: teamId, type: ExternalServiceType.SLACK, name, credentials: null })
    .execute();
  return id;
}

const listOf = (target: Target, verb: 'read' | 'write' | 'fire' | 'use') => StatementStore.grantsOf(target, { teamId, verb });

describe('an imported team', () => {
  it('gives an automation with no statement the team, and fire by its listens; a connection or shell, use for the team', async () => {
    const slack = await connection('Slack');
    const onSlack = await automation('On Slack', 'chat = slack(credentials: `Slack`)');
    const onEmail = await automation('On email', 'inbox = email()');
    const mixed = await automation('Mixed', 'inbox = email()\nchat = slack(credentials: `Slack`)');

    const stated = await stateWhatIsUnstated(client, teamId);
    expect(stated.automations).toHaveLength(3);
    expect(stated.connections).toEqual([slack]);

    const team = [{ kind: 'team' }];
    for (const id of [onSlack, onEmail, mixed]) {
      expect(await listOf({ thing: 'automation', id }, 'read')).toEqual(team);
      expect(await listOf({ thing: 'automation', id }, 'write')).toEqual(team);
    }
    expect(await listOf({ thing: 'automation', id: onSlack }, 'fire')).toEqual(team);
    expect(await listOf({ thing: 'automation', id: onEmail }, 'fire')).toEqual([{ kind: 'anyone' }]);
    expect(await listOf({ thing: 'automation', id: mixed }, 'fire')).toEqual(team);
    expect(await listOf({ thing: 'connection', id: slack }, 'use')).toEqual(team);
  });

  it('says anyone may fire an automation pinned to a carried version, whatever its listens', async () => {
    const slack = 'chat = slack(credentials: `Slack`)';
    const carried = await automation('Carried', slack, '0.12.13');
    const unstamped = await automation('Unstamped', slack, '1');

    await stateWhatIsUnstated(client, teamId);
    expect(await listOf({ thing: 'automation', id: carried }, 'fire')).toEqual([{ kind: 'anyone' }]);
    expect(await listOf({ thing: 'automation', id: unstamped }, 'fire')).toEqual([{ kind: 'anyone' }]);
  });

  it('keeps what arrived with its statements as it was', async () => {
    const stated = await automation('Stated');
    const alice = randomUUID();
    await StatementStore.replaceGrants({ thing: 'automation', id: stated }, { teamId, verb: 'write', grantees: [{ kind: 'user', userId: alice }] });

    expect(await stateWhatIsUnstated(client, teamId)).toEqual({ automations: [], connections: [] });
    expect(await listOf({ thing: 'automation', id: stated }, 'write')).toEqual([{ kind: 'user', userId: alice }]);
    expect(await listOf({ thing: 'automation', id: stated }, 'read')).toEqual([]);
  });

  it('makes anyone a fire list a set would refuse there, and says which automations it changed', async () => {
    const team = [{ kind: 'team' as const }];
    const carried = await automation('Carried', 'chat = slack(credentials: `Slack`)', '0.12.13');
    const current = await automation('Current', 'chat = slack(credentials: `Slack`)');
    const open = await automation('Open', 'inbox = email()', '0.12.13');
    for (const id of [carried, current]) {
      await StatementStore.replaceGrants({ thing: 'automation', id }, { teamId, verb: 'fire', grantees: team });
    }
    await StatementStore.replaceGrants({ thing: 'automation', id: open }, { teamId, verb: 'fire', grantees: [{ kind: 'anyone' }] });

    expect(await anyoneWhereFireIsNotKeptTo(client, teamId)).toEqual([{ id: carried, name: 'Carried' }]);
    expect(await listOf({ thing: 'automation', id: carried }, 'fire')).toEqual([{ kind: 'anyone' }]);
    expect(await listOf({ thing: 'automation', id: current }, 'fire')).toEqual(team);
    expect(await listOf({ thing: 'automation', id: open }, 'fire')).toEqual([{ kind: 'anyone' }]);

    await getAutomationsQb(['team_engine']).insertInto('team_engine').values({ team_id: teamId, engine: 'lf' }).execute();
    expect(await anyoneWhereFireIsNotKeptTo(client, teamId)).toEqual([{ id: current, name: 'Current' }]);
    expect(await listOf({ thing: 'automation', id: current }, 'fire')).toEqual([{ kind: 'anyone' }]);
  });

  it('says anyone may fire on a team whose automations run on lf', async () => {
    const onSlack = await automation('On Slack', 'chat = slack(credentials: `Slack`)');
    await getAutomationsQb(['team_engine']).insertInto('team_engine').values({ team_id: teamId, engine: 'lf' }).execute();

    await stateWhatIsUnstated(client, teamId);
    expect(await listOf({ thing: 'automation', id: onSlack }, 'fire')).toEqual([{ kind: 'anyone' }]);
  });
});
