// The team admin migration makes every member who could manage the team an
// admin (the public identity excepted), keeps a read member reading, and from
// then on the table holds only the three levels. Run against a throwaway database on the test server: a
// minimal table as it stood before the migration, its rows, the migration
// file itself, then the inserts it must refuse and allow.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Client } from 'pg';

const MIGRATIONS = path.resolve(__dirname, '../../db/migrations');

function urlFor(database: string): string {
  const url = new URL(process.env.DATABASE_URL_TEST ?? '');
  url.pathname = `/${database}`;
  return url.toString();
}

describe('the team admin migration', () => {
  const database = `team_admin_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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

  it('turns every write membership into admin, keeps read and the public identity at write, and then holds only read, write and admin', async () => {
    await db.query(`
      CREATE SCHEMA core;
      CREATE TABLE core.team_membership (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id uuid NOT NULL,
        team_id uuid NOT NULL,
        access text NOT NULL
      );
      INSERT INTO core.team_membership (user_id, team_id, access) VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'write'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'read'),
        ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '22222222-2222-4222-8222-222222222222', 'write'),
        ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '3c556453-82b3-4314-ab78-67d843aaa7da', 'write');
    `);

    const file = readdirSync(MIGRATIONS).find((name) => name.endsWith('_team-admin.sql'));
    expect(file).toBeDefined();
    await db.query(readFileSync(path.join(MIGRATIONS, file ?? ''), 'utf-8'));

    const { rows } = await db.query<{ user_id: string; access: string }>(
      'SELECT user_id, access FROM core.team_membership ORDER BY user_id',
    );
    expect(rows).toEqual([
      { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', access: 'admin' },
      { user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', access: 'read' },
      { user_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', access: 'admin' },
      // The public identity stays write, as a new install creates it.
      { user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', access: 'write' },
    ]);

    const insert = (access: string) =>
      db.query('INSERT INTO core.team_membership (user_id, team_id, access) VALUES (gen_random_uuid(), gen_random_uuid(), $1)', [access]);
    await expect(insert('write')).resolves.toBeDefined();
    await expect(insert('MANAGE')).rejects.toThrow(/team_membership_access_check/);
  });
});
