// Which parked runs a team export carries live, through the real export on a
// real database. A run parked on a 0.13+ wait cannot wake on the target (its
// wait reads the source's arrival log), so it is carried failed with its leaf
// closed. A run parked under 0.12 on a correlation (`adapter_await`, no wait)
// is carried live with its correlation, and a timer park is carried as it is.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from 'pg';
import { sql } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { readTableFile } from '../bundle';
import { exportTeam } from '../export';

const ADDRESS = 'root/0';

let teamId: TeamId;
let outDir: string;
let client: Client;

beforeEach(async () => {
  teamId = randomUUID() as TeamId;
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-export-'));
  client = new Client({ connectionString: process.env.DATABASE_URL_TEST });
  await client.connect();
});

afterEach(async () => {
  await client.end();
  await fs.rm(outDir, { recursive: true, force: true });
  await cleanupTeam(teamId);
});

async function parkedRun(reason: 'await' | 'timer'): Promise<TriggerRunId> {
  const run = await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    .values({ team_id: teamId, trigger_id: randomUUID(), trigger_type: 'webhook', status: 'parked' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await getAutomationsQb(['parked_run'])
    .insertInto('parked_run')
    .values({
      run_id: run.id,
      address: ADDRESS,
      status: 'parked',
      park_reason: reason,
      wake_at: reason === 'timer' ? new Date(Date.now() + 60 * 60 * 1000) : null,
      state: sql`'{"version": 2}'::jsonb`,
    })
    .execute();
  return run.id;
}

type Exported = Record<string, string | null>;

async function exported(table: string): Promise<Exported[]> {
  const { manifest } = await exportTeam(client, { teamId, products: ['automations'], outDir, withHistory: true });
  const entry = manifest.tables.find((t) => t.table === table);
  if (!entry) throw new Error(`the export did not carry ${table}`);
  const rows = await readTableFile(outDir, entry);
  return rows.map((row) => Object.fromEntries(entry.columns.map((c, i) => [c, row[i] ?? null])));
}

async function exportedRuns(): Promise<Map<string, Exported>> {
  return new Map((await exported('automations.trigger_run')).map((r) => [r.id!, r]));
}

async function exportedLeaves(): Promise<Map<string, Exported>> {
  return new Map((await exported('automations.parked_run')).map((r) => [r.run_id!, r]));
}

describe('a team export carries parked runs by what they wait on', () => {
  it('a 0.12 correlation park (an adapter_await, no wait) is carried live, with its correlation', async () => {
    const run = await parkedRun('await');
    await getAutomationsQb(['adapter_await'])
      .insertInto('adapter_await')
      .values({ adapter_type: 'ask', correlation_key: `ask:${randomUUID()}`, run_id: run, team_id: teamId, address: ADDRESS })
      .execute();

    expect((await exportedRuns()).get(run)).toMatchObject({ status: 'parked', failure_reason: null });
    const leaf = (await exportedLeaves()).get(run);
    expect(leaf).toMatchObject({ status: 'parked', park_reason: 'await' });
    expect(leaf?.state).not.toBeNull();
    expect((await exported('automations.adapter_await')).map((r) => r.run_id)).toEqual([run]);
  });

  it("a run with a wait at its park's address is carried failed, with its leaf closed", async () => {
    const run = await parkedRun('await');
    await getAutomationsQb(['wait_row'])
      .insertInto('wait_row')
      .values({ run_id: run, team_id: teamId, adapter_type: 'ask', edge: 'Answer', since: '0', address: ADDRESS })
      .execute();

    const carried = (await exportedRuns()).get(run);
    expect(carried).toMatchObject({ status: 'failed' });
    expect(carried?.failed_at).not.toBeNull();
    expect(carried?.failure_reason).toMatch(/waited on an arrival/);
    expect((await exportedLeaves()).get(run)).toMatchObject({ status: 'completed', state: null });
  });

  it("a wait at another address does not close the park: it is not this leaf's wait", async () => {
    const run = await parkedRun('await');
    await getAutomationsQb(['wait_row'])
      .insertInto('wait_row')
      .values({ run_id: run, team_id: teamId, adapter_type: 'ask', edge: 'Answer', since: '0', address: 'root/1' })
      .execute();

    expect((await exportedRuns()).get(run)).toMatchObject({ status: 'parked' });
    expect((await exportedLeaves()).get(run)).toMatchObject({ status: 'parked' });
  });

  it('a timer park is carried unchanged', async () => {
    const run = await parkedRun('timer');

    expect((await exportedRuns()).get(run)).toMatchObject({ status: 'parked', failure_reason: null });
    const leaf = (await exportedLeaves()).get(run);
    expect(leaf).toMatchObject({ status: 'parked', park_reason: 'timer' });
    expect(leaf?.wake_at).not.toBeNull();
    expect(leaf?.state).not.toBeNull();
  });
});
