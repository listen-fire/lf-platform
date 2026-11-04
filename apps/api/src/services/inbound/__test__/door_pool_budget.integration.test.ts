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
import { Client } from 'pg';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

/** A healthy pass takes well under a second a door. */
const BUDGET_MS = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const [kysely, settings, cleanup, drain, slack, carried, door, deliveries, upgrade] = await Promise.all([
    import('../../../lib/kysely'),
    import('../../../prisma/pool_settings'),
    import('../../../test/harness/cleanup'),
    import('../../work/drain'),
    import('../../webhook_sync/slack_events'),
    import('../carried_delivery'),
    import('../listen_door'),
    import('../../movement_engine/run_host_deliveries'),
    import('../../translation_graph/movement/language_upgrade'),
  ]);
  return { ...kysely, ...settings, ...cleanup, ...drain, ...slack, ...carried, ...door, ...deliveries, ...upgrade };
}

describe.each([4, 2])('doors at a pool of %i', (poolMax) => {
  let at: Awaited<ReturnType<typeof loadAt>>;
  let teamId: TeamId;
  let slackTeam: string;
  /** Another process's session: an upgrade elsewhere, and a look at the database. */
  let elsewhere: Client;
  let look: Client;

  const doorsKey = () => `doors:${teamId}`;
  const tryDoorsAlone = async () => {
    const { rows } = await look.query<{ held: boolean }>('select pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) as held', [doorsKey()]);
    return rows[0]?.held === true;
  };
  const keep = (externalId: string) =>
    at.keepForEveryVersion({
      origin: { teamId, adapterType: 'slack', providerKey: 'SLACK', credentialsId: null },
      subscriptionId: 'SLACK',
      externalId,
      source: 'webhook',
      request: {},
    });
  const deliver = (externalId: string) =>
    at.deliverArrivals({ teamId, delivered: { adapterType: 'slack', credentialsId: null }, subscriptionId: 'SLACK', externalId, source: 'webhook', arrivals: [ARRIVAL] });
  const keptIds = async (): Promise<string[]> => {
    const { rows } = await look.query<{ external_id: string }>('select external_id from automations.delivery where team_id = $1 order by external_id', [teamId]);
    return rows.map((row) => row.external_id);
  };
  /** Holds the doors alone from another session, as an upgrade does, once granted. */
  const upgradeTakesDoors = () => elsewhere.query('begin').then(() => elsewhere.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [doorsKey()]));
  const upgradeIsWaiting = async () => {
    for (;;) {
      const { rows } = await look.query<{ waiting: number }>("select count(*)::int as waiting from pg_locks where locktype = 'advisory' and mode = 'ExclusiveLock' and not granted");
      if ((rows[0]?.waiting ?? 0) > 0) return;
      await sleep(10);
    }
  };

  beforeAll(async () => {
    at = await loadAt(poolMax);
    expect(at.poolSettings.kyselyMax).toBe(poolMax);
  }, 120_000);

  beforeEach(async () => {
    elsewhere = new Client({ connectionString: process.env.DATABASE_URL });
    look = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([elsewhere.connect(), look.connect()]);
    teamId = randomUUID() as TeamId;
    slackTeam = `T${randomUUID()}`;
    const credentialsId = randomUUID();
    const movementId = randomUUID() as MovementId;
    await at.getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `pool-${teamId}` }).execute();
    await at
      .getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({ id: credentialsId as never, team_id: teamId, type: 'SLACK' as never, name: 'slack_conn', identifier: `teamId:${slackTeam}`, app_id: 'listen-fire', credentials: Buffer.from('unused') })
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
    // A session still blocked, after a failure, would never end.
    await Promise.race([Promise.all([elsewhere.end(), look.end()]), sleep(1_000)]);
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

    // A limit above seven, as another suite's due row takes a slot and is released.
    const pass = await withinBudget('the drain pass', at.drainWork({ owner: `pool-${poolMax}`, limit: 50 }));

    expect(pass.ran).toBe(7);
    const { rows } = await sql<{ external_id: string | null; judged: boolean }>`
      select external_id, judged_at is not null as judged from automations.delivery where team_id = ${teamId}::uuid`.execute(at.globalQb);
    expect(rows.map((row) => row.external_id).sort()).toEqual(eventIds.map((id) => `slack:${id}`).sort());
    expect(rows.every((row) => row.judged)).toBe(true);
    const readings = await sql<{ count: number }>`
      select count(*)::int as count from automations.work where team_id = ${teamId}::uuid and kind = 'read_delivery'`.execute(at.globalQb);
    expect(readings.rows[0]?.count).toBe(7);
  }, 60_000);

  it('more doors than there are connections each wait their turn on the lock, and none fails', async () => {
    let mostHolding = 0;
    const doors = Array.from({ length: 8 }, (_, door) =>
      at.withDoorsHeld(teamId, async () => {
        const { rows } = await look.query<{ holding: number }>("select count(*)::int as holding from pg_stat_activity where application_name = 'lf-doors-lock' and state <> 'idle'");
        mostHolding = Math.max(mostHolding, rows[0]?.holding ?? 0);
        await sleep(50);
        return deliver(`door-${door}`);
      }),
    );

    const delivered = await withinBudget('eight doors', Promise.all(doors));

    expect(delivered.every(({ kept }) => kept.kept)).toBe(true);
    expect((await keptIds()).length).toBe(8);
    expect(mostHolding).toBeLessThanOrEqual(2);
  }, 60_000);

  it('a door an upgrade is waiting for still finishes, with keeps queued behind that upgrade', async () => {
    let doorHolds = () => {};
    const holding = new Promise<void>((resolve) => {
      doorHolds = resolve;
    });
    let letDoorGo = () => {};
    const go = new Promise<void>((resolve) => {
      letDoorGo = resolve;
    });
    const door = at.withDoorsHeld(teamId, async () => {
      doorHolds();
      await go;
      return deliver('the-door');
    });
    await holding;
    const upgraded = upgradeTakesDoors();
    await upgradeIsWaiting();
    // Enough to hold every connection of the pool, were a keep to wait there.
    const keeps = Array.from({ length: poolMax + 1 }, (_, n) => keep(`keep-${n}`));
    await sleep(200);
    letDoorGo();

    await withinBudget('the door', door);
    await withinBudget('the upgrade', upgraded);
    await elsewhere.query('commit');
    await withinBudget('the keeps', Promise.all(keeps));
    expect((await keptIds()).length).toBe(poolMax + 2);
  }, 60_000);

  it('a keep made while an upgrade holds the doors waits for the move', async () => {
    await upgradeTakesDoors();
    const kept = keep('after-the-move');
    await sleep(300);
    expect(await keptIds()).toEqual([]);

    await elsewhere.query('commit');

    await withinBudget('the keep', kept);
    expect(await keptIds()).toEqual(['after-the-move']);
  }, 60_000);

  it('a keep holds the doors from before its reads until its write is committed', async () => {
    let doorsWhileReading: boolean | undefined;
    let ownRowSeen = 0;
    let otherSessionSaw = -1;
    const store = at.deliveryRowStore({ host: 'platform', teamId });
    await look.query('begin');
    await withinBudget(
      'the keep',
      store.keepRawDelivery({
        delivery: { id: randomUUID(), subscriptionId: 'SLACK', externalId: 'under-the-lock', receivedAt: new Date().toISOString(), source: 'webhook', request: {} },
        work: async (trx) => {
          doorsWhileReading = await tryDoorsAlone();
          // The read is on the keep's own transaction: it sees the row uncommitted.
          const { rows } = await sql<{ count: number }>`select count(*)::int as count from automations.delivery where team_id = ${teamId}::uuid`.execute(trx);
          ownRowSeen = rows[0]?.count ?? 0;
          otherSessionSaw = (await keptIds()).length;
          return [];
        },
      }),
    );
    expect(doorsWhileReading).toBe(false);
    expect(ownRowSeen).toBe(1);
    expect(otherSessionSaw).toBe(0);
    // Released with the keep, and what it wrote is there for the move to see.
    expect(await tryDoorsAlone()).toBe(true);
    expect(await keptIds()).toEqual(['under-the-lock']);
    await look.query('rollback');
  }, 60_000);

  it("a door's body runs with the doors held, and lets go when it is done or fails", async () => {
    await look.query('begin');
    let whileHeld: boolean | undefined;
    await at.withDoorsHeld(teamId, async () => {
      whileHeld = await tryDoorsAlone();
    });
    expect(whileHeld).toBe(false);
    await expect(
      at.withDoorsHeld(teamId, async () => {
        throw new Error('the door failed');
      }),
    ).rejects.toThrow('the door failed');
    expect(await tryDoorsAlone()).toBe(true);
    await look.query('rollback');
  }, 60_000);

  it("a door inside an upgrade's own transaction joins it rather than waiting for itself", async () => {
    await withinBudget(
      'the door in the transaction',
      at.inOneTransaction(teamId, async () => {
        await at.holdDoorsAlone(at.getAutomationsQb(['work']), teamId);
        await at.withDoorsHeld(teamId, async () => {});
        await keep('joined');
      }),
    );
    expect(await keptIds()).toEqual(['joined']);
  }, 60_000);
});
