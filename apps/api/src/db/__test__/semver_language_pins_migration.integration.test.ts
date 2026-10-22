// The semver pins migration turns the integer pin into text: the integer 5 (the
// installed language, which is the 0.12 line) reads '0.12.0', a legacy id reads
// as itself. Run against a throwaway database on the test server: the two
// tables as they stood before the migration, rows at 4 and 5, then the
// migration file itself.

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

describe('the semver language pins migration', () => {
  const database = `semver_pins_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let db: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    db = new Client({ connectionString: urlFor(database) });
    await db.connect();
  });

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin?.end();
  });

  it('reads a row at 5 as "0.12.0" and a row at 4 as "4"', async () => {
    await db.query(`
      CREATE SCHEMA automations;
      CREATE TABLE automations.movement (
        id text PRIMARY KEY,
        validity_checked_against integer,
        language_version integer DEFAULT 1 NOT NULL,
        upgrade_checked_against integer
      );
      CREATE TABLE automations.movement_version (
        id text PRIMARY KEY,
        language_version integer NOT NULL
      );
      INSERT INTO automations.movement VALUES ('legacy', 4, 4, NULL), ('current', 5, 5, 5);
      INSERT INTO automations.movement_version VALUES ('legacy', 4), ('current', 5);
    `);

    const file = readdirSync(MIGRATIONS).find((name) => name.endsWith('_semver_language_pins.sql'));
    expect(file).toBeDefined();
    await db.query(readFileSync(path.join(MIGRATIONS, file ?? ''), 'utf-8'));

    await db.query(`INSERT INTO automations.movement (id) VALUES ('unstamped')`);

    const movements = await db.query(
      'SELECT id, validity_checked_against, language_version, upgrade_checked_against FROM automations.movement ORDER BY id',
    );
    expect(movements.rows).toEqual([
      { id: 'current', validity_checked_against: '0.12.0', language_version: '0.12.0', upgrade_checked_against: '0.12.0' },
      { id: 'legacy', validity_checked_against: '4', language_version: '4', upgrade_checked_against: null },
      { id: 'unstamped', validity_checked_against: null, language_version: '1', upgrade_checked_against: null },
    ]);
    const versions = await db.query('SELECT id, language_version FROM automations.movement_version ORDER BY id');
    expect(versions.rows).toEqual([
      { id: 'current', language_version: '0.12.0' },
      { id: 'legacy', language_version: '4' },
    ]);
  });
});
