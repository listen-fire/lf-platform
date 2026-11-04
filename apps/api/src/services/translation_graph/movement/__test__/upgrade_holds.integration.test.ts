// What holds an automation where it is at an upgrade, whatever its diagnostics
// say, over rows production's own code wrote (`movement_engine/__test__/fixtures`):
// a run waiting on a callback or an await under its version, and an edit waiting
// for confirmation. A run waiting on a timer holds nothing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'kysely';
import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { upgradeMovement, type Advance, type ValidateUnder } from '../language_upgrade';
import { getMovementRow } from '../store';

const FIXTURES = join(__dirname, '../../../movement_engine/__test__/fixtures/production-0.12.13');
const TEAM = '00000000-0000-4000-8000-0000000012a1' as TeamId;

const clean: ValidateUnder = async () => ({ diagnostics: [], gaps: [] }) as never;
const moved: Advance = async () => async () => ({ ok: true });
const together = async (_team: string, moves: () => Promise<void>) => moves();

async function load(name: string): Promise<{ movementId: string; runId: string; name: string }> {
  const { rows, runId } = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as { runId: string; rows: Record<string, Record<string, unknown>[]> };
  const db = getAutomationsQb(['trigger_run']);
  for (const table of ['movement', 'movement_version', 'trigger', 'trigger_run', 'parked_run', 'adapter_await', 'callback']) {
    for (const row of rows[table] ?? []) {
      const columns = Object.keys(row).filter((column) => !(table === 'movement' && column === 'current_version_id'));
      await sql`
        INSERT INTO ${sql.table(`automations.${table}`)} (${sql.join(columns.map((c) => sql.ref(c)))})
        SELECT ${sql.join(columns.map((c) => sql.ref(c)))}
        FROM jsonb_populate_record(null::${sql.table(`automations.${table}`)}, ${JSON.stringify(row)}::jsonb)
      `.execute(db);
    }
  }
  const movement = rows.movement?.[0];
  if (movement === undefined) throw new Error('test: the fixture has no movement');
  await sql`UPDATE automations.movement SET current_version_id = ${String(movement.current_version_id)}::uuid WHERE id = ${String(movement.id)}::uuid`.execute(db);
  return { movementId: String(movement.id), runId, name: String(movement.name) };
}

const upgrade = (id: string) => upgradeMovement({ teamId: TEAM, id, acknowledge: true, validate: clean, advance: moved, together });

describe('an upgrade held where it is', () => {
  beforeAll(async () => {
    await getCoreQb(['team']).insertInto('team').values({ id: TEAM, name: 'upgrade holds' } as never).onConflict((oc) => oc.column('id').doNothing()).execute();
  });

  afterEach(async () => {
    await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', TEAM).execute();
    await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('team_id', '=', TEAM).execute();
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', TEAM).execute();
    await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', TEAM).execute();
  });

  afterAll(() => cleanupTeam(TEAM));

  it.each(['callback', 'ask'])('a run parked on a %s refuses by name, with the run', async (fixture) => {
    const { movementId, runId, name } = await load(fixture);
    const result = await upgrade(movementId);
    expect(result).toMatchObject({ status: 'blocked' });
    if (result.status !== 'blocked') return;
    expect(result.detail).toContain(name);
    expect(result.detail).toContain(runId);
    expect((await getMovementRow({ teamId: TEAM, id: movementId }))?.languageVersion).toBe('0.12.8');
  });

  it('a legacy 4 run parked on an ask holds its automation too', async () => {
    const { movementId } = await load('legacy-4-ask');
    expect(await upgrade(movementId)).toMatchObject({ status: 'blocked' });
  });

  it('a run parked on a timer holds nothing: it finishes on its own version', async () => {
    const { movementId } = await load('timer');
    expect(await upgrade(movementId)).toMatchObject({ status: 'upgraded' });
  });

  it("a member of the import group's parked run holds the whole group, named", async () => {
    const { name } = await load('callback');
    const importer = '00000000-0000-4000-8000-00000000abcd';
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: importer, team_id: TEAM, name: 'importer', source: `import { tap } from "${name}"\nfunction go(run: <manual-[:Invocation]->>) {\n  return tap(run)\n}\nlisten to manual fire go\n`, language_version: '0.12.8' } as never)
      .execute();
    const result = await upgrade(importer);
    expect(result).toMatchObject({ status: 'blocked' });
    if (result.status !== 'blocked') return;
    expect(result.detail).toContain(name);
    expect(result.detail).toContain('nothing moved');
    expect((await getMovementRow({ teamId: TEAM, id: importer }))?.languageVersion).toBe('0.12.8');
  });

  it('a legacy 4 automation moves straight to this release, its timer run finishing on the legacy engine', async () => {
    const { movementId, runId } = await load('legacy-4-timer');
    const first = await upgradeMovement({ teamId: TEAM, id: movementId, acknowledge: false });
    expect(first).toMatchObject({ status: 'needs_acknowledgement', from: { version: '4' } });
    const moved = await upgradeMovement({ teamId: TEAM, id: movementId, acknowledge: true });
    expect(moved).toMatchObject({ status: 'upgraded' });
    expect((await getMovementRow({ teamId: TEAM, id: movementId }))?.languageVersion).toBe(LANGUAGE_VERSION);
    const run = await getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', runId as never).select(['status', 'failure_reason']).executeTakeFirstOrThrow();
    expect(run).toMatchObject({ status: 'parked' });
  });

  it('an edit waiting for confirmation refuses by name, and names the remedy', async () => {
    const { movementId, name } = await load('timer');
    await sql`UPDATE automations.movement SET source = source || ${'\n// an edit that stopped at needs confirmation\n'} WHERE id = ${movementId}::uuid`.execute(getAutomationsQb(['movement']));
    const result = await upgrade(movementId);
    expect(result).toMatchObject({ status: 'blocked' });
    if (result.status !== 'blocked') return;
    expect(result.detail).toContain(`${name} has an edit waiting for confirmation`);
    expect(result.detail).toContain('confirm or discard');
  });
});
