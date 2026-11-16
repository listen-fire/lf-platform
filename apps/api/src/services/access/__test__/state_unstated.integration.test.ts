// What already exists keeps the reach it has today: the deploy step that states
// every automation and connection with no statement, run over a seeded team on
// a real database. Driven through the script a deployment runs.

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang';
import { Client } from 'pg';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { stateUnstatedMain } from '../../../scripts/state_unstated';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { StatementStore, type Grantee, type Target } from '../statement';

const TEAM: Grantee[] = [{ kind: 'team' }];

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
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
  await client.end();
  await cleanupTeam(teamId);
});

async function automation(
  name: string,
  source = '',
  languageVersion: LanguageVersion = LANGUAGE_VERSION,
): Promise<MovementId> {
  const id = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    .values({ id, team_id: teamId, name, source, language_version: languageVersion })
    .execute();
  return id;
}

const SLACK_LISTEN = 'chat = slack(credentials: `Slack`)';
const EMAIL_LISTEN = 'inbox = email()';

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

const listOf = (target: Target, verb: 'read' | 'write' | 'use') =>
  StatementStore.grantsOf(target, { teamId, verb });

const stateTheTeam = () => stateUnstatedMain(['--team', teamId]);

async function seed() {
  const slack = await connection('Slack');
  const onSlack = await automation('On Slack', SLACK_LISTEN);
  const onEmail = await automation('On email', EMAIL_LISTEN);
  const mixed = await automation('Mixed', `${EMAIL_LISTEN}\n${SLACK_LISTEN}`);
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
  it('the backfill states read, write and use, and reads no source that does not say export', async () => {
    const { slack, onSlack, onEmail, mixed } = await seed();
    // A source no parser can read, under a pin only a legacy parser knows: it is stated the same, and never read (it exports nothing).
    const unreadable = await automation('Unreadable', 'movement broken( {', '4');
    const carried = await automation('Carried', SLACK_LISTEN, '0.12.13');

    await stateTheTeam();

    expect(await listOf({ thing: 'connection', id: slack }, 'use')).toEqual(TEAM);
    for (const id of [onSlack, onEmail, mixed, unreadable, carried]) {
      expect(await listOf({ thing: 'automation', id }, 'read')).toEqual(TEAM);
      expect(await listOf({ thing: 'automation', id }, 'write')).toEqual(TEAM);
    }
    expect(console.warn).not.toHaveBeenCalled();
    const verbs = await client.query(`SELECT DISTINCT verb FROM automations.access_statement WHERE team_id = $1 ORDER BY verb`, [teamId]);
    expect(verbs.rows.map((r) => r.verb)).toEqual(['read', 'use', 'write']);
  });

  it('logs each thing it states, and warns only once the team already has statements', async () => {
    const { onSlack, slack } = await seed();

    await stateTheTeam();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`automation ${onSlack}`));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`connection ${slack}`));
    expect(console.warn).not.toHaveBeenCalled();

    const late = await automation('Created without saying', EMAIL_LISTEN);
    await stateTheTeam();

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`automation ${late}`));
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
    expect(await listOf({ thing: 'connection', id: slack }, 'use')).toEqual([
      { kind: 'user', userId: alice },
    ]);
  });

  it('only reports, and writes nothing, with --check', async () => {
    const { slack, onSlack } = await seed();

    await expect(stateUnstatedMain(['--team', teamId, '--check'])).resolves.toBeUndefined();

    expect(await listOf({ thing: 'connection', id: slack }, 'use')).toEqual([]);
    expect(await listOf({ thing: 'automation', id: onSlack }, 'read')).toEqual([]);
  });
});

describe('deploy_sets_use_equal_to_read: a file that exports gets the use list its readers imply', () => {
  const LIBRARY = 'export function tally(t: <text>) {\n  return t\n}\n';
  const named = (id: string, verb: 'read' | 'write' | 'use') =>
    client
      .query(`SELECT grantee, value FROM automations.access_statement WHERE thing = 'automation' AND thing_id = $1::uuid AND verb = $2 ORDER BY grantee, value`, [id, verb])
      .then((r) => r.rows);

  async function stateList(id: string, verb: 'read' | 'write', grantees: Grantee[]): Promise<void> {
    await StatementStore.replaceGrants({ thing: 'automation', id }, { teamId, verb, grantees });
  }

  it('gives use equal to who may read it, writers included since writing implies reading, and leaves other files alone', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const library = await automation('Library', LIBRARY);
    await stateList(library, 'write', [{ kind: 'user', userId: alice }]);
    await stateList(library, 'read', [{ kind: 'user', userId: bob }]);
    const plain = await automation('Plain', EMAIL_LISTEN);
    await stateList(plain, 'write', TEAM);
    await stateList(plain, 'read', TEAM);
    // A word that only looks like an export is not one.
    const lookalike = await automation('Lookalike', '# export function nothing\nx = 1\n');
    await stateList(lookalike, 'write', TEAM);
    await stateList(lookalike, 'read', TEAM);

    await stateTheTeam();

    expect(await named(library, 'use')).toEqual(
      [alice, bob].sort().map((value) => ({ grantee: 'user', value })),
    );
    expect(await named(plain, 'use')).toEqual([]);
    expect(await named(lookalike, 'use')).toEqual([]);
  });

  it('states a library an unstated team arrives with from the lists the same run gives it, and a second run changes nothing', async () => {
    const library = await automation('Library', LIBRARY);
    await stateTheTeam();
    expect(await named(library, 'use')).toEqual([{ grantee: 'team', value: null }]);

    const before = await statementAudits();
    await stateTheTeam();
    expect(await statementAudits()).toBe(before);
  });

  it('finds a team whose only gap is a library without a use list', async () => {
    const library = await automation('Library', LIBRARY);
    await stateList(library, 'write', TEAM);
    await stateList(library, 'read', TEAM);
    const { teamsWithUnstated } = await import('../state_unstated');
    expect(await teamsWithUnstated(client)).toContain(teamId);
    await stateTheTeam();
    expect(await named(library, 'use')).toEqual([{ grantee: 'team', value: null }]);
  });
});
