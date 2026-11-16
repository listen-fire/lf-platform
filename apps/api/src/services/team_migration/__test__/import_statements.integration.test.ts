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
import { stateWhatIsUnstated } from '../../access/state_unstated';

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

const listOf = (target: Target, verb: 'read' | 'write' | 'use') => StatementStore.grantsOf(target, { teamId, verb });

describe('an imported team', () => {
  it('the backfill states read, write and use and parses no source', async () => {
    const slack = await connection('Slack');
    // Sources that no parser could read: the backfill states the same lists whatever the file says.
    const onSlack = await automation('On Slack', 'chat = slack(credentials: `Slack`)');
    const unreadable = await automation('Unreadable', 'movement broken( {', '4');
    const carried = await automation('Carried', 'inbox = email()', '0.12.13');

    const stated = await stateWhatIsUnstated(client, teamId);
    expect(stated.automations).toHaveLength(3);
    expect(stated.connections).toEqual([slack]);

    const team = [{ kind: 'team' }];
    for (const id of [onSlack, unreadable, carried]) {
      expect(await listOf({ thing: 'automation', id }, 'read')).toEqual(team);
      expect(await listOf({ thing: 'automation', id }, 'write')).toEqual(team);
    }
    expect(await listOf({ thing: 'connection', id: slack }, 'use')).toEqual(team);
  });

  it('keeps what arrived with its statements as it was', async () => {
    const stated = await automation('Stated');
    const alice = randomUUID();
    await StatementStore.replaceGrants({ thing: 'automation', id: stated }, { teamId, verb: 'write', grantees: [{ kind: 'user', userId: alice }] });

    expect(await stateWhatIsUnstated(client, teamId)).toEqual({ automations: [], connections: [], libraries: [] });
    expect(await listOf({ thing: 'automation', id: stated }, 'write')).toEqual([{ kind: 'user', userId: alice }]);
    expect(await listOf({ thing: 'automation', id: stated }, 'read')).toEqual([]);
  });
});
