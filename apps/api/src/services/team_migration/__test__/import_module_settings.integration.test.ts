// A team bundle cut before a module declared a setting carries the connection
// with none; the import gives it the module's default, and a setting the bundle
// does carry (a person turned it off) stays as it was.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from 'pg';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { DROP_OWN_MESSAGES } from '../../connections/module_settings';
import { deleteTeam } from '../delete';
import { exportTeam } from '../export';
import { importTeam } from '../import';

let teamId: TeamId;
let bundleDir: string;
let client: Client;

beforeEach(async () => {
  teamId = randomUUID() as TeamId;
  bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-import-settings-'));
  client = new Client({ connectionString: process.env.DATABASE_URL_TEST });
  await client.connect();
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `import-settings-${teamId.slice(0, 8)}` }).execute();
});

afterEach(async () => {
  await client.end();
  await fs.rm(bundleDir, { recursive: true, force: true });
  await cleanupTeam(teamId);
});

async function connection(options: { name: string; type: ExternalServiceType; settings: Record<string, string> }): Promise<ExternalServiceCredentialsId> {
  const id = randomUUID() as ExternalServiceCredentialsId;
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({ id, team_id: teamId, type: options.type, name: options.name, credentials: null, module_settings: options.settings })
    .execute();
  return id;
}

const settingsOf = async (id: ExternalServiceCredentialsId) =>
  (
    await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', id)
      .select('module_settings')
      .executeTakeFirstOrThrow()
  ).module_settings;

describe('importing connections', () => {
  it('stamps the default on a Slack connection that carries none, keeps one turned off, and gives another module nothing', async () => {
    const bare = await connection({ name: 'Old Slack', type: ExternalServiceType.SLACK, settings: {} });
    const off = await connection({ name: 'Quiet Slack', type: ExternalServiceType.SLACK, settings: { [DROP_OWN_MESSAGES]: 'off' } });
    const other = await connection({ name: 'Deals', type: ExternalServiceType.GOOGLE, settings: {} });

    await exportTeam(client, { teamId, products: ['automations'], outDir: bundleDir, withHistory: false });
    await deleteTeam(client, { teamId, confirm: true });
    await importTeam(client, { bundleDir });

    expect(await settingsOf(bare)).toEqual({ [DROP_OWN_MESSAGES]: 'on' });
    expect(await settingsOf(off)).toEqual({ [DROP_OWN_MESSAGES]: 'off' });
    expect(await settingsOf(other)).toEqual({});
  });
});
