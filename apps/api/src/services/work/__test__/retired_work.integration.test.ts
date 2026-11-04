// A new drain beside a 0.12.13 service (real Postgres): what that service can
// write survives this build's startup, and a row no build since writes does not.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import { getAutomationsQb } from '../../../lib/kysely';
import { ensureAutomationsPeriodicWork } from '../register';

const WRITTEN_BY_012_13 = ['dispatch_event', 'fire_callback', 'fire_cron', 'cron_reconcile', 'poll_source'];

async function queue(kind: string): Promise<string> {
  const key = `${kind}:${randomUUID()}`;
  await sql`
    insert into automations.work (host, kind, key, payload, due_at, updated_at)
    values ('platform', ${kind}, ${key}, '{}'::jsonb, now(), now())`.execute(getAutomationsQb(['work']));
  return key;
}

const kept = async (key: string) =>
  (await getAutomationsQb(['work']).selectFrom('work').where('host', '=', 'platform').where('key', '=', key).select('id').execute()).length === 1;

describe("a new drain's startup", () => {
  const keys: string[] = [];
  afterAll(async () => {
    await getAutomationsQb(['work']).deleteFrom('work').where('key', 'in', keys).execute();
  });

  it.each(WRITTEN_BY_012_13)('leaves a queued %s row for the 0.12.13 service that wrote it', async (kind) => {
    const key = await queue(kind);
    keys.push(key);

    await ensureAutomationsPeriodicWork();

    expect(await kept(key)).toBe(true);
  });

  it('still deletes the rows of a kind 0.12.13 retired itself', async () => {
    const key = await queue('ask_expiry_sweep');
    keys.push(key);

    await ensureAutomationsPeriodicWork();

    expect(await kept(key)).toBe(false);
  });
});
