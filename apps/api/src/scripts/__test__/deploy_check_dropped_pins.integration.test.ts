// The deploy check refuses while a run is parked on a dropped pin (a legacy id,
// or 0.12, whose engines this release no longer carries), over rows
// production's own code wrote at 0.12.13 (`fixtures/production-0.12.13`): it
// names every automation on such a pin, and every run parked on one, and the
// deployment stops until those runs are gone. A parked run of the current
// version holds nothing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'kysely';
import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb, getCoreQb } from '../../lib/kysely';
import { cleanupTeam } from '../../test/harness/cleanup';
import { droppedPins } from '../../services/translation_graph/movement/dropped_pins';
import { droppedPinsAllowDeploy, renderDropped } from '../deploy_check';

jest.mock('../../services', () => ({}));

const FIXTURES = join(__dirname, '../../services/movement_engine/__test__/fixtures/production-0.12.13');
const TEAM = '00000000-0000-4000-8000-0000000012a1' as TeamId;

async function load(name: string): Promise<{ runId: TriggerRunId; movementName: string }> {
  const { rows, runId } = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as { runId: string; rows: Record<string, Record<string, unknown>[]> };
  const db = getAutomationsQb(['trigger_run']);
  for (const table of ['movement', 'movement_version', 'trigger', 'trigger_run', 'parked_run']) {
    for (const row of rows[table] ?? []) {
      const columns = Object.keys(row).filter((column) => !(table === 'movement' && column === 'current_version_id'));
      await sql`
        INSERT INTO ${sql.table(`automations.${table}`)} (${sql.join(columns.map((c) => sql.ref(c)))})
        SELECT ${sql.join(columns.map((c) => sql.ref(c)))}
        FROM jsonb_populate_record(null::${sql.table(`automations.${table}`)}, ${JSON.stringify(row)}::jsonb)
      `.execute(db);
    }
  }
  return { runId: runId as TriggerRunId, movementName: String(rows.movement?.[0]?.name) };
}

describe('the deploy check, over automations on dropped pins', () => {
  beforeAll(async () => {
    await getCoreQb(['team']).insertInto('team').values({ id: TEAM, name: 'dropped pins' } as never).onConflict((oc) => oc.column('id').doNothing()).execute();
  });

  afterEach(async () => {
    await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('team_id', '=', TEAM).execute();
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', TEAM).execute();
    await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', TEAM).execute();
  });

  afterAll(async () => {
    await cleanupTeam(TEAM);
  });

  it('refuses while a run is parked on a dropped pin, naming each run and its automation, and lets the deploy on once they are gone', async () => {
    const legacy = await load('legacy-4-timer');
    const dropped = await load('timer');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    expect(await droppedPinsAllowDeploy()).toBe(false);
    const said = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(said).toContain(`REFUSED: 2 runs are parked on them`);
    expect(said).toContain(`run ${legacy.runId} of ${legacy.movementName} (4)`);
    expect(said).toContain(`run ${dropped.runId} of ${dropped.movementName} (0.12.`);

    await getAutomationsQb(['trigger_run']).updateTable('trigger_run').set({ status: 'failed' }).where('team_id', '=', TEAM).execute();
    log.mockClear();

    expect(await droppedPinsAllowDeploy()).toBe(true);
    const named = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(named).toContain(`- ${legacy.movementName} (4), team ${TEAM}`);
    expect(named).toContain(`- ${dropped.movementName} (0.12.`);
    expect(named).not.toContain('REFUSED');
    log.mockRestore();
  });

  it('a parked run whose automation is on the current version holds nothing', async () => {
    const { runId } = await load('timer');
    const current = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId)
      .select('movement_version_id')
      .executeTakeFirstOrThrow();
    await getAutomationsQb(['movement_version']).updateTable('movement_version').set({ language_version: LANGUAGE_VERSION }).where('id', '=', current.movement_version_id!).execute();
    await getAutomationsQb(['movement']).updateTable('movement').set({ language_version: LANGUAGE_VERSION }).where('team_id', '=', TEAM).execute();

    const found = await droppedPins();
    expect(found.parkedRuns.filter((run) => run.teamId === TEAM)).toEqual([]);
    expect(found.automations.filter((automation) => automation.teamId === TEAM)).toEqual([]);
    expect(renderDropped({ automations: [], parkedRuns: [] })).toBe('');
  });

  it('a run parked on a 0.15.3 automation holds nothing: the carried 0.15 engine continues it, while a 0.12 or legacy pin is still named', async () => {
    const carried = await load('timer');
    const legacy = await load('legacy-4-timer');
    const carriedMovement = await getAutomationsQb(['trigger_run', 'movement_version'])
      .selectFrom('trigger_run')
      .innerJoin('movement_version', 'movement_version.id', 'trigger_run.movement_version_id')
      .where('trigger_run.id', '=', carried.runId)
      .select(['movement_version.id as versionId', 'movement_version.movement_id as movementId'])
      .executeTakeFirstOrThrow();
    await getAutomationsQb(['movement_version']).updateTable('movement_version').set({ language_version: '0.15.3' }).where('id', '=', carriedMovement.versionId).execute();
    await getAutomationsQb(['movement']).updateTable('movement').set({ language_version: '0.15.3' }).where('id', '=', carriedMovement.movementId).execute();

    const found = await droppedPins();
    expect(found.parkedRuns.filter((run) => run.teamId === TEAM).map((run) => run.id)).toEqual([legacy.runId]);
    expect(found.automations.filter((automation) => automation.teamId === TEAM).map((automation) => automation.pin)).toEqual(['4']);
  });
});
