// Schedules' turns under 0.12 at the pool production runs (real Postgres, the real
// drain and handlers, a real pool of the size named). A turn that holds a
// connection in its transaction while asking the same pool for something hangs for
// good once the turns of one pass reach the pool's size, and Postgres sees nothing
// wrong: every session sits idle in transaction. So the scenario has a time
// budget, and blowing it is the failure. The firing itself is stubbed, as in the
// carried listening suite.

import { randomUUID } from 'node:crypto';

jest.mock('../../translation_graph/movement/execute', () => {
  const actual = jest.requireActual('../../translation_graph/movement/execute');
  return { ...actual, runMovementFiring: jest.fn(async () => ({ result: { movementName: 'fired', writes: [], extractionSites: {}, trace: [] } })) };
});

import { sql } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

const PIN = '0.12.13';
const POOL = 4;
/** More schedules due than the pool has connections. */
const SCHEDULES = POOL + 1;
/** A healthy pass takes well under a second a turn. */
const BUDGET_MS = 20_000;
const EVERY_MINUTE = 'import { `@lf/cron` as cron } from adapters\ntimer = connect cron\nfunction digest(t: <timer-[:Tick]->>) {\n  return t.`Fired at`\n}\nlisten to timer { schedule: "* * * * *" } fire digest\n';

async function withinBudget<T>(what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const blown = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${BUDGET_MS} ms: the pool is starved`)), BUDGET_MS);
  });
  try {
    return await Promise.race([work, blown]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fresh modules, so the pool is made at the size asked for. */
async function loadAt(poolMax: number) {
  process.env.KYSELY_POOL_MAX = String(poolMax);
  process.env.PRISMA_POOL_MAX = String(poolMax);
  jest.resetModules();
  const [kysely, settings, cleanup, drain, register, store, provision, engines] = await Promise.all([
    import('../../../lib/kysely'),
    import('../../../prisma/pool_settings'),
    import('../../../test/harness/cleanup'),
    import('../../work/drain'),
    import('../../work/register'),
    import('../../work/store'),
    import('../../translation_graph/movement/provision'),
    import('../../lf_engine/team_engine'),
  ]);
  return { ...kysely, ...settings, ...cleanup, ...drain, ...register, ...store, ...provision, ...engines };
}

describe(`schedules under 0.12 at a pool of ${POOL}`, () => {
  let at: Awaited<ReturnType<typeof loadAt>>;
  let teamId: TeamId;
  let triggers: TriggerId[];

  const fiveMinutesAgo = () => new Date(Date.now() - 5 * 60_000);
  const dueSince = async (triggerId: TriggerId) => {
    await at.getAutomationsQb(['trigger']).updateTable('trigger').set({ cron_last_fired_at: fiveMinutesAgo() }).where('id', '=', triggerId).execute();
    await at.enqueueWork({ kind: 'fire_cron', key: `fire_cron:${triggerId}`, teamId, payload: { triggerId }, dueAt: new Date(Date.now() - 60_000) });
  };

  beforeAll(async () => {
    at = await loadAt(POOL);
    expect(at.poolSettings.kyselyMax).toBe(POOL);
    at.resetWorkHandlersForTests();
    at.registerCoreWork();
    at.setWorkNotifier(at.inProcessNotifier);
  }, 120_000);

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await at.getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `turns-${teamId}` }).execute();
    // A member, as production's teams have: a turn sets its session as them.
    const userId = randomUUID();
    await sql`insert into core."user" (id, default_team_id, username) values (${userId}::uuid, ${teamId}::uuid, ${`turns-${userId}`})`.execute(at.getCoreQb(['team']));
    await sql`insert into core.team_membership (id, team_id, user_id, access, is_personal, created_at, updated_at) values (gen_random_uuid(), ${teamId}::uuid, ${userId}::uuid, 'write', false, now(), now())`.execute(at.getCoreQb(['team']));
    triggers = [];
    for (let n = 0; n < SCHEDULES; n++) {
      const id = randomUUID() as MovementId;
      await at.getAutomationsQb(['movement']).insertInto('movement').values({ id, team_id: teamId, name: `m-${id}`, source: EVERY_MINUTE, language_version: PIN }).execute();
      const saved = await at.saveMovement({ teamId, id, source: EVERY_MINUTE, acknowledgeErrors: true });
      if (!saved.ok) throw new Error(`the save did not ship: ${JSON.stringify(saved)}`);
      const row = await at.getAutomationsQb(['trigger']).selectFrom('trigger').where('movement_id', '=', id).select('id').executeTakeFirstOrThrow();
      triggers.push(row.id);
    }
    // The saves' own rows (the reconcile) go first, so the passes below claim the turns alone.
    await at.drainWork({ owner: 'ready', limit: 50, teamId });
  });

  afterEach(async () => {
    await withinBudget('cleaning up', at.cleanupTeam(teamId));
  });

  it('as many schedules due as the pool has connections, with events waiting to dispatch, all take their turn in one pass', async () => {
    // Events from a turn a while ago, waiting to dispatch.
    for (const triggerId of triggers) await dueSince(triggerId);
    await withinBudget('the first pass', at.drainWork({ owner: 'first', limit: SCHEDULES, teamId }));
    // The next occurrence, due before those events were queued, as a schedule's is.
    for (const triggerId of triggers) await dueSince(triggerId);
    const { rows: waiting } = await sql<{ kind: string; count: number }>`
      select kind, count(*)::int as count from automations.work where team_id = ${teamId}::uuid and due_at <= now() and dead_at is null group by kind`.execute(at.globalQb);
    expect(waiting).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'fire_cron', count: SCHEDULES }), expect.objectContaining({ kind: 'dispatch_event' })]));
    // A process that last read the set of lf teams over five seconds ago: every new drain job's first pass.
    at.forgetLfEngineTeams();

    const pass = await withinBudget('the drain pass', at.drainWork({ owner: 'second', limit: 10, teamId }));

    expect(pass.failed).toBe(0);
    const { rows: marks } = await sql<{ moved: boolean }>`
      select cron_last_fired_at > now() - interval '1 minute' as moved from automations.trigger where id = any(${triggers}::uuid[])`.execute(at.globalQb);
    expect(marks).toHaveLength(SCHEDULES);
    expect(marks.every((mark) => mark.moved)).toBe(true);
  }, 60_000);
});
