// The connection settings migration's backfill: every Slack connection that
// exists is written to drop its app's own messages, and a connection of any
// other module carries nothing. Run against a throwaway database on the test
// server: the table as it was, then the migration file itself.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Client } from 'pg';

const MIGRATIONS = path.resolve(__dirname, '../migrations');

function urlFor(database: string): string {
  const url = new URL(process.env.DATABASE_URL_TEST ?? '');
  url.pathname = `/${database}`;
  return url.toString();
}

const TEAM = randomUUID();
const SLACK_LEGACY_APP = randomUUID();
const SLACK_MOVEMENTS_APP = randomUUID();
const SLACK_SHELL = randomUUID();
const ATTIO = randomUUID();
const TELEGRAM = randomUUID();

const BEFORE = `
  CREATE SCHEMA automations;
  CREATE TYPE automations."ExternalServiceType" AS ENUM ('SLACK', 'ATTIO', 'TELEGRAM');
  CREATE FUNCTION automations.audit() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RETURN NEW; END;
  $$;
  CREATE TABLE automations.external_service_credentials (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    team_id uuid NOT NULL,
    type automations."ExternalServiceType" NOT NULL,
    credentials bytea,
    app_id text
  );
  CREATE TRIGGER external_service_credentials_audit AFTER INSERT OR DELETE OR UPDATE
    ON automations.external_service_credentials FOR EACH ROW EXECUTE FUNCTION automations.audit();
`;

describe('the connection settings migration', () => {
  const database = `module_settings_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let db: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    db = new Client({ connectionString: urlFor(database) });
    await db.connect();
    await db.query(BEFORE);
    const insert = (id: string, type: string, appId: string | null, credentials: string | null) =>
      db.query(
        `INSERT INTO automations.external_service_credentials (id, name, team_id, type, credentials, app_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, `connection-${id.slice(0, 8)}`, TEAM, type, credentials === null ? null : Buffer.from(credentials), appId],
      );
    // The legacy app's connection (no app id), the movements app's, an imported shell with no credentials.
    await insert(SLACK_LEGACY_APP, 'SLACK', null, 'sealed');
    await insert(SLACK_MOVEMENTS_APP, 'SLACK', 'listen-fire', 'sealed');
    await insert(SLACK_SHELL, 'SLACK', 'listen-fire', null);
    await insert(ATTIO, 'ATTIO', null, 'sealed');
    await insert(TELEGRAM, 'TELEGRAM', null, null);

    const file = readdirSync(MIGRATIONS).find((name) => name.endsWith('_connection-module-settings.sql'));
    expect(file).toBeDefined();
    await db.query(readFileSync(path.join(MIGRATIONS, file ?? ''), 'utf-8'));
  });

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin?.end();
  });

  const settingsOf = async (id: string) =>
    (await db.query('SELECT module_settings FROM automations.external_service_credentials WHERE id = $1', [id])).rows[0]?.module_settings;

  it('writes every Slack connection to drop its own messages', async () => {
    for (const id of [SLACK_LEGACY_APP, SLACK_MOVEMENTS_APP, SLACK_SHELL]) {
      expect(await settingsOf(id)).toEqual({ drop_own_messages: 'on' });
    }
  });

  it('leaves a connection of any other module carrying nothing', async () => {
    expect(await settingsOf(ATTIO)).toEqual({});
    expect(await settingsOf(TELEGRAM)).toEqual({});
  });

  it('leaves the column at {} for a row inserted bare: the writers of a connection stamp the defaults, not the column', async () => {
    await db.query(
      `INSERT INTO automations.external_service_credentials (id, name, team_id, type) VALUES ($1, 'later', $2, 'SLACK')`,
      [randomUUID(), TEAM],
    );
    const { rows } = await db.query(`SELECT module_settings FROM automations.external_service_credentials WHERE name = 'later'`);
    expect(rows[0].module_settings).toEqual({});
  });
});
