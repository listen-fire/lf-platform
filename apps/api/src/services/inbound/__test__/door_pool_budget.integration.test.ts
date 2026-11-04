// Doors at the pool production runs (real Postgres, the real drain and handler,
// a real pool of the size named). A connection held while waiting for another
// from the same pool hangs for good once enough doors arrive together, and
// Postgres sees nothing wrong: the transactions sit idle. So each scenario has a
// time budget, and blowing it is the failure. The Slack module's read is stubbed,
// as it calls Slack; no transaction is open around it.

import { randomUUID } from 'node:crypto';

const ARRIVAL = { edge: 'Messages', key: 'C1', identity: 'C1:1.0', landing: { recordId: 'C1:1.0', recordType: 'Slack Message', fields: { Text: 'hi' } } };
jest.mock('../../translation_graph/adapters/resolve', () => ({
  ...jest.requireActual('../../translation_graph/adapters/resolve'),
  resolveAdapter: jest.fn(async () => ({ adapterType: 'slack', preprocessInbound: async () => ({ events: [], arrivals: [ARRIVAL] }) })),
}));

import { sql } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

/** A healthy pass takes well under a second a door. */
const BUDGET_MS = 20_000;

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
  const [kysely, settings, cleanup, drain, slack] = await Promise.all([
    import('../../../lib/kysely'),
    import('../../../prisma/pool_settings'),
    import('../../../test/harness/cleanup'),
    import('../../work/drain'),
    import('../../webhook_sync/slack_events'),
  ]);
  return { ...kysely, ...settings, ...cleanup, ...drain, ...slack };
}

describe.each([4, 2])('doors at a pool of %i', (poolMax) => {
  let at: Awaited<ReturnType<typeof loadAt>>;
  let teamId: TeamId;
  let slackTeam: string;

  beforeAll(async () => {
    at = await loadAt(poolMax);
    expect(at.poolSettings.kyselyMax).toBe(poolMax);
  }, 120_000);

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    slackTeam = `T${randomUUID()}`;
    const credentialsId = randomUUID();
    const movementId = randomUUID() as MovementId;
    await at.getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `pool-${teamId}` }).execute();
    await at
      .getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({ id: credentialsId as never, team_id: teamId, type: 'SLACK' as never, name: 'slack_conn', identifier: `teamId:${slackTeam}`, app_id: 'listen-fire', credentials: 'unused' })
      .execute();
    // A listen pinned to the carried version, so each keep asks what it owes it.
    await at.getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'heard', source: '', language_version: '0.12.13' }).execute();
    await at
      .getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({ id: randomUUID() as TriggerId, team_id: teamId, kind: 'slack', name: 'listen', config: '{}' as never, movement_id: movementId, fired_movement_name: 'onChange', run_mode: 'live' })
      .execute();
  });

  afterEach(async () => {
    await withinBudget('cleaning up', at.cleanupTeam(teamId));
  });

  it('seven Slack events claimed by one pass all finish, each kept once with what it owes the carried version', async () => {
    at.resetWorkHandlersForTests();
    at.registerSlackEventWork();
    const eventIds = Array.from({ length: 7 }, () => `Ev${randomUUID()}`);
    await Promise.all(
      eventIds.map((event_id) => {
        const envelope = { type: 'event_callback', team_id: slackTeam, event_id, event: { type: 'message', user: 'U1', channel: 'C1', ts: '1.0', text: 'hi' } };
        return at.enqueueSlackEvent({ envelope, rawBody: Buffer.from(JSON.stringify(envelope)) });
      }),
    );

    const pass = await withinBudget('the drain pass', at.drainWork({ owner: `pool-${poolMax}`, limit: 7 }));

    expect(pass).toMatchObject({ claimed: 7, ran: 7, failed: 0 });
    const { rows } = await sql<{ external_id: string | null; judged: boolean }>`
      select external_id, judged_at is not null as judged from automations.delivery where team_id = ${teamId}::uuid`.execute(at.globalQb);
    expect(rows.map((row) => row.external_id).sort()).toEqual(eventIds.map((id) => `slack:${id}`).sort());
    expect(rows.every((row) => row.judged)).toBe(true);
    const readings = await sql<{ count: number }>`
      select count(*)::int as count from automations.work where team_id = ${teamId}::uuid and kind = 'read_delivery'`.execute(at.globalQb);
    expect(readings.rows[0]?.count).toBe(7);
  }, 60_000);
});
