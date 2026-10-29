// The public inbox migration's backfill: a fork's saved automations opened an
// address from the program (`listen to inbox { key: "nemo", from: "anyone" }`),
// and each such key becomes a claim for its team so the mail keeps arriving.
// Run against a throwaway database on the test server: the tables the backfill
// reads, as small as it needs them, then the migration file itself.

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

const TEAM_A = randomUUID();
const TEAM_B = randomUUID();
const AUTHOR = randomUUID();
const SAVER = randomUUID();
const LATER_SAVER_WHO_LEFT = randomUUID();
const KEY_OWNER = randomUUID();
const API_KEY = randomUUID();

/** What existed before the migration, as much of it as the backfill reads. */
const BEFORE = `
  CREATE EXTENSION IF NOT EXISTS citext;
  CREATE SCHEMA automations;
  CREATE SCHEMA core;
  CREATE FUNCTION automations.audit() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RETURN NEW; END;
  $$;
  CREATE TABLE core.team_membership (user_id uuid NOT NULL, team_id uuid NOT NULL);
  CREATE TABLE core.api_key (id uuid PRIMARY KEY, created_by uuid NOT NULL);
  CREATE TABLE automations.movement (
    id uuid PRIMARY KEY,
    team_id uuid NOT NULL,
    created_by_user_id uuid,
    updated_at timestamptz DEFAULT now() NOT NULL
  );
  CREATE TABLE automations.trigger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL,
    kind text NOT NULL,
    config jsonb NOT NULL,
    movement_id uuid
  );
  CREATE TABLE automations.audit_log (
    version bigserial,
    created_by text,
    op text NOT NULL,
    table_name text NOT NULL,
    model_id uuid
  );
`;

async function movement(db: Client, row: { team: string; author: string | null }): Promise<string> {
  const id = randomUUID();
  await db.query('INSERT INTO automations.movement (id, team_id, created_by_user_id) VALUES ($1, $2, $3)', [
    id,
    row.team,
    row.author,
  ]);
  return id;
}

async function listen(
  db: Client,
  row: { team: string; movement: string | null; config: Record<string, string>; kind?: string },
): Promise<void> {
  await db.query('INSERT INTO automations.trigger (team_id, kind, config, movement_id) VALUES ($1, $2, $3, $4)', [
    row.team,
    row.kind ?? 'email',
    JSON.stringify(row.config),
    row.movement,
  ]);
}

async function saved(db: Client, movementId: string, by: string): Promise<void> {
  await db.query(
    `INSERT INTO automations.audit_log (created_by, op, table_name, model_id) VALUES ($1, 'UPDATE', 'movement', $2)`,
    [by, movementId],
  );
}

describe('the public inbox migration', () => {
  const database = `public_inbox_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let db: Client;
  let notices: string[];

  beforeAll(async () => {
    admin = new Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    db = new Client({ connectionString: urlFor(database) });
    await db.connect();
    notices = [];
    db.on('notice', (notice) => notices.push(notice.message ?? ''));
    await db.query(BEFORE);

    for (const user of [AUTHOR, SAVER, KEY_OWNER]) {
      await db.query('INSERT INTO core.team_membership VALUES ($1, $2)', [user, TEAM_A]);
    }
    await db.query('INSERT INTO core.api_key VALUES ($1, $2)', [API_KEY, KEY_OWNER]);

    // An author on record: they claim it.
    const authored = await movement(db, { team: TEAM_A, author: AUTHOR });
    await listen(db, { team: TEAM_A, movement: authored, config: { key: 'nemo', from: 'anyone' } });

    // No recorded author (an agent's save before saves stamped one): the last
    // save by someone still on the team claims it, not a later one by someone
    // who has since left.
    const authorless = await movement(db, { team: TEAM_A, author: null });
    await saved(db, authorless, SAVER);
    await saved(db, authorless, LATER_SAVER_WHO_LEFT);
    await listen(db, { team: TEAM_A, movement: authorless, config: { key: 'Deals', from: 'anyone' } });

    // Saved through an api key: the key's creator is the saver.
    const viaKey = await movement(db, { team: TEAM_A, author: null });
    await saved(db, viaKey, API_KEY);
    await listen(db, { team: TEAM_A, movement: viaKey, kind: 'CUSTOM_EMAIL', config: { key: 'pitches', from: 'anyone' } });

    // Nobody on record at all: left closed, as the fork left it.
    const nobody = await movement(db, { team: TEAM_A, author: null });
    await listen(db, { team: TEAM_A, movement: nobody, config: { key: 'orphan', from: 'anyone' } });

    // Two teams opened the same key (in any case): the fork refused that mail
    // as ambiguous, so neither team gets it.
    const first = await movement(db, { team: TEAM_A, author: AUTHOR });
    await listen(db, { team: TEAM_A, movement: first, config: { key: 'shared', from: 'anyone' } });
    await db.query('INSERT INTO core.team_membership VALUES ($1, $2)', [AUTHOR, TEAM_B]);
    const second = await movement(db, { team: TEAM_B, author: AUTHOR });
    await listen(db, { team: TEAM_B, movement: second, config: { key: 'SHARED', from: 'anyone' } });

    // Not open, not live, not email: none of these is a claim.
    const plain = await movement(db, { team: TEAM_A, author: AUTHOR });
    await listen(db, { team: TEAM_A, movement: plain, config: { key: 'private' } });
    await listen(db, { team: TEAM_A, movement: plain, config: { key: 'known-only', from: 'known' } });
    await listen(db, { team: TEAM_A, movement: null, config: { key: 'orphaned-row', from: 'anyone' } });
    await listen(db, { team: TEAM_A, movement: plain, kind: 'slack', config: { key: 'not-mail', from: 'anyone' } });

    const file = readdirSync(MIGRATIONS).find((name) => name.endsWith('_public-inbox.sql'));
    expect(file).toBeDefined();
    await db.query(readFileSync(path.join(MIGRATIONS, file ?? ''), 'utf-8'));
  });

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin?.end();
  });

  it('claims each key a single team opened, for who the run should act as', async () => {
    const claims = await db.query(
      'SELECT key::text AS key, team_id, claimed_by_user_id FROM automations.public_inbox ORDER BY lower(key)',
    );
    expect(claims.rows).toEqual([
      { key: 'Deals', team_id: TEAM_A, claimed_by_user_id: SAVER },
      { key: 'nemo', team_id: TEAM_A, claimed_by_user_id: AUTHOR },
      { key: 'pitches', team_id: TEAM_A, claimed_by_user_id: KEY_OWNER },
    ]);
  });

  it('says what it left unclaimed and why', () => {
    expect(notices.join('\n')).toMatch(
      /3 key\(s\) claimed.*1 opened by more than one team and 1 with nobody on the team to act as/,
    );
  });

  it('holds a key to one team in any case', async () => {
    await expect(
      db.query('INSERT INTO automations.public_inbox (key, team_id, claimed_by_user_id) VALUES ($1, $2, $3)', [
        'NEMO',
        TEAM_B,
        AUTHOR,
      ]),
    ).rejects.toThrow(/public_inbox_key_key/);
  });
});
