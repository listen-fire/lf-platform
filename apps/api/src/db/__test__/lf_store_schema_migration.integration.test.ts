// The lf store module migration marks whose row each run and work row is.
// Run against a throwaway database on the test server: the two tables as they
// stood before the migration, a row in each, then the migration file itself.
// Every existing row must read as the platform's, and a work key then names one
// row per host rather than one row in all.

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

describe('the lf store module migration', () => {
  const database = `lf_store_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let db: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    db = new Client({ connectionString: urlFor(database) });
    await db.connect();
    // The two tables the migration alters, as they stood before it (only the
    // columns this test reads, the constraint it drops, and the column the new
    // index covers).
    await db.query(`
      CREATE SCHEMA automations;
      CREATE TABLE automations.trigger_run (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id uuid NOT NULL,
        status text NOT NULL,
        started_at timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE automations.work (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind text NOT NULL,
        key text NOT NULL UNIQUE
      );
      INSERT INTO automations.trigger_run (team_id, status) VALUES (gen_random_uuid(), 'parked');
      INSERT INTO automations.work (kind, key) VALUES ('resume_timer', 'resume_timer:existing');
    `);
    const file = readdirSync(MIGRATIONS).find((name) => name.endsWith('_lf-store-module.sql'));
    expect(file).toBeDefined();
    await db.query(readFileSync(path.join(MIGRATIONS, file ?? ''), 'utf-8'));
  });

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin?.end();
  });

  it("reads every existing row as the platform's", async () => {
    expect((await db.query('SELECT host FROM automations.trigger_run')).rows).toEqual([{ host: 'platform' }]);
    expect((await db.query('SELECT host, key FROM automations.work')).rows).toEqual([
      { host: 'platform', key: 'resume_timer:existing' },
    ]);
  });

  it('keeps one key under both hosts as two rows, and one row per host', async () => {
    await db.query(`INSERT INTO automations.work (host, kind, key) VALUES ('lf', 'resume_timer', 'resume_timer:existing')`);
    const rows = await db.query(`SELECT host FROM automations.work WHERE key = 'resume_timer:existing' ORDER BY host`);
    expect(rows.rows).toEqual([{ host: 'lf' }, { host: 'platform' }]);

    await expect(
      db.query(`INSERT INTO automations.work (host, kind, key) VALUES ('lf', 'resume_timer', 'resume_timer:existing')`),
    ).rejects.toThrow(/work_host_key_unique/);
  });

  it('refuses a host that is neither', async () => {
    await expect(
      db.query(`INSERT INTO automations.work (host, kind, key) VALUES ('elsewhere', 'resume_timer', 'k')`),
    ).rejects.toThrow(/work_host_check/);
    await expect(
      db.query(`INSERT INTO automations.trigger_run (team_id, status, host) VALUES (gen_random_uuid(), 'parked', 'elsewhere')`),
    ).rejects.toThrow(/trigger_run_host_check/);
  });
});
