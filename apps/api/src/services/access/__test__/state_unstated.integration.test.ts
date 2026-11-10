// What already exists keeps the reach it has today: the deploy step that states
// every automation and connection with no statement, run over a seeded team on
// a real database. Driven through the script a deployment runs, then the listing
// a person widens a mixed file by.

import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen } from '../../../test/harness/listens';
import { mixedFilesOf } from '../../../scripts/list_mixed_fire_reach';
import { stateUnstatedMain } from '../../../scripts/state_unstated';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { StatementStore, type Grantee, type Target } from '../statement';

const TEAM: Grantee[] = [{ kind: 'team' }];
const ANYONE: Grantee[] = [{ kind: 'anyone' }];

let teamId: TeamId;
let client: Client;
let databaseUrl: string | undefined;

beforeEach(async () => {
  teamId = randomUUID() as TeamId;
  client = new Client({ connectionString: process.env.DATABASE_URL_TEST });
  await client.connect();
  databaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
  await client.end();
  await cleanupTeam(teamId);
});

async function automation(name: string): Promise<MovementId> {
  const id = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    .values({ id, team_id: teamId, name, source: '' })
    .execute();
  return id;
}

/** A connection saved with no user, as one created before connections recorded who made them. */
async function connection(name: string): Promise<ExternalServiceCredentialsId> {
  const id = randomUUID() as ExternalServiceCredentialsId;
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({
      id,
      team_id: teamId,
      type: ExternalServiceType.SLACK,
      name,
      credentials: null,
      user_id: null,
    })
    .execute();
  return id;
}

const listOf = (target: Target, verb: 'read' | 'write' | 'fire' | 'use') =>
  StatementStore.grantsOf(target, { teamId, verb });

const stateTheTeam = () => stateUnstatedMain(['--team', teamId]);

async function seed() {
  const slack = await connection('Slack');
  const onSlack = await automation('On Slack');
  const onEmail = await automation('On email');
  const mixed = await automation('Mixed');
  await insertTestListen({
    teamId,
    movementId: onSlack,
    adapterType: 'SLACK',
    edge: 'Messages',
    delivery: 'connection',
    credentialsId: slack,
  });
  await insertTestListen({
    teamId,
    movementId: onEmail,
    adapterType: 'email',
    edge: 'Emails',
    delivery: 'connection',
  });
  await insertTestListen({
    teamId,
    movementId: mixed,
    adapterType: 'email',
    edge: 'Emails',
    delivery: 'connection',
  });
  await insertTestListen({
    teamId,
    movementId: mixed,
    adapterType: 'slack',
    edge: 'Messages',
    delivery: 'connection',
    credentialsId: slack,
  });
  return { slack, onSlack, onEmail, mixed };
}

/** How many writes to this team's statements the audit log holds. */
async function statementAudits(): Promise<number> {
  const { rows } = await client.query(
    `SELECT count(*)::int AS count FROM automations.audit_log WHERE table_name = 'access_statement' AND "new"->>'team_id' = $1`,
    [teamId],
  );
  return rows[0].count;
}

async function everythingStated(ids: {
  slack: string;
  onSlack: string;
  onEmail: string;
  mixed: string;
}) {
  const read = async (thing: 'automation' | 'connection', id: string) =>
    (
      await client.query(
        `SELECT verb, grantee, value FROM automations.access_statement WHERE thing = $1 AND thing_id = $2::uuid ORDER BY verb, grantee, value`,
        [thing, id],
      )
    ).rows;
  return {
    slack: await read('connection', ids.slack),
    onSlack: await read('automation', ids.onSlack),
    onEmail: await read('automation', ids.onEmail),
    mixed: await read('automation', ids.mixed),
  };
}

describe('stating what exists', () => {
  it('gives the team the connection, and each file the team plus the narrowest of its listens', async () => {
    const { slack, onSlack, onEmail, mixed } = await seed();

    await stateTheTeam();

    expect(await listOf({ thing: 'connection', id: slack }, 'use')).toEqual(TEAM);
    for (const id of [onSlack, onEmail, mixed]) {
      expect(await listOf({ thing: 'automation', id }, 'read')).toEqual(TEAM);
      expect(await listOf({ thing: 'automation', id }, 'write')).toEqual(TEAM);
    }
    expect(await listOf({ thing: 'automation', id: onSlack }, 'fire')).toEqual(TEAM);
    expect(await listOf({ thing: 'automation', id: onEmail }, 'fire')).toEqual(ANYONE);
    expect(await listOf({ thing: 'automation', id: mixed }, 'fire')).toEqual(TEAM);
  });

  it('changes nothing on a second run', async () => {
    const ids = await seed();
    await stateTheTeam();
    const first = await everythingStated(ids);
    const audited = await statementAudits();

    await stateTheTeam();

    expect(await everythingStated(ids)).toEqual(first);
    expect(await statementAudits()).toBe(audited);
  });

  it('leaves a thing that already has a statement as it was, even a partial one', async () => {
    const { slack, onEmail, mixed } = await seed();
    const alice = randomUUID();
    await StatementStore.replaceGrants(
      { thing: 'automation', id: onEmail },
      { teamId, verb: 'write', grantees: [{ kind: 'user', userId: alice }] },
    );
    await StatementStore.replaceGrants(
      { thing: 'connection', id: slack },
      { teamId, verb: 'use', grantees: [{ kind: 'user', userId: alice }] },
    );

    await stateTheTeam();

    expect(await listOf({ thing: 'automation', id: onEmail }, 'write')).toEqual([
      { kind: 'user', userId: alice },
    ]);
    expect(await listOf({ thing: 'automation', id: onEmail }, 'read')).toEqual([]);
    expect(await listOf({ thing: 'automation', id: onEmail }, 'fire')).toEqual([]);
    expect(await listOf({ thing: 'connection', id: slack }, 'use')).toEqual([
      { kind: 'user', userId: alice },
    ]);
    expect(await listOf({ thing: 'automation', id: mixed }, 'fire')).toEqual(TEAM);
  });

  it('only reports, and writes nothing, with --check', async () => {
    const { slack, onSlack } = await seed();

    await expect(stateUnstatedMain(['--team', teamId, '--check'])).resolves.toBeUndefined();

    expect(await listOf({ thing: 'connection', id: slack }, 'use')).toEqual([]);
    expect(await listOf({ thing: 'automation', id: onSlack }, 'read')).toEqual([]);
  });
});

describe('listing the files that mix who may fire', () => {
  it('names the mixed file with each listen, and no other', async () => {
    const { mixed } = await seed();
    await stateTheTeam();

    const files = await mixedFilesOf(client, teamId);

    expect(files).toEqual([
      {
        teamId,
        automationId: mixed,
        name: 'Mixed',
        listens: expect.arrayContaining([
          { module: 'email', viaConnection: false, firedBy: 'anyone' },
          { module: 'slack', viaConnection: true, firedBy: 'team' },
        ]),
        fireList: ['team'],
      },
    ]);
    expect(files[0].listens).toHaveLength(2);
  });
});
