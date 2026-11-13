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
  const [kysely, settings, cleanup, drain, slack, carried, door, deliveries, upgrade, queue, context, principal, emailDoor, inbox, listens] = await Promise.all([
    import('../../../lib/kysely'),
    import('../../../prisma/pool_settings'),
    import('../../../test/harness/cleanup'),
    import('../../work/drain'),
    import('../../webhook_sync/slack_events'),
    import('../carried_delivery'),
    import('../listen_door'),
    import('../../movement_engine/run_host_deliveries'),
    import('../../translation_graph/movement/language_upgrade'),
    import('../../movement_engine/doors_hold'),
    import('../../context'),
    import('../../principal'),
    import('../../../interfaces/rest/private'),
    import('../../translation_graph/adapters/email/public_inbox'),
    import('../../../test/harness/listens'),
  ]);
  return { ...kysely, ...settings, ...cleanup, ...drain, ...slack, ...carried, ...door, ...deliveries, ...upgrade, ...queue, ...context, ...principal, ...emailDoor, ...inbox, ...listens };
}

describe.each([4, 2])('doors at a pool of %i', (poolMax) => {
  let at: Awaited<ReturnType<typeof loadAt>>;
  let teamId: TeamId;
  let slackTeam: string;
  let movementId: MovementId;
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
  const deliver = (externalId: string | null) =>
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
    movementId = randomUUID() as MovementId;
    await at.getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `pool-${teamId}` }).execute();
    await at
      .getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({ id: credentialsId as never, team_id: teamId, type: 'SLACK' as never, name: 'slack_conn', identifier: `teamId:${slackTeam}`, app_id: 'listen-fire', credentials: Buffer.from('unused') })
      .execute();
    // A listen pinned to 0.12, which no version reads here: each keep asks what
    // it owes it, and owes it nothing.
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

  it('seven Slack events claimed by one pass all finish, each kept once', async () => {
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
    expect(readings.rows[0]?.count).toBe(0);
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

  // A door may fail and let the provider retry. It must never hang, and never lose
  // or double a delivery.

  /** How long `work` took to settle, what it settled as, and never past the budget. */
  const timed = async <T>(what: string, work: Promise<T>) => {
    const started = Date.now();
    const settled = await withinBudget(what, work.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })));
    return { ...settled, ms: Date.now() - started };
  };
  /** Ends the session holding the one door in flight, as an operator or a failover
   *  does, and gives its client the moment a closed socket takes to be heard. */
  const lockConnectionDies = async () => {
    const { rows } = await look.query<{ done: boolean }>(
      "select pg_terminate_backend(pid) as done from pg_stat_activity where application_name = 'lf-doors-lock' and datname = current_database() and state = 'idle in transaction'",
    );
    expect(rows).toEqual([{ done: true }]);
    await sleep(100);
  };
  /** Another process's open transaction, hung, on a delivery of this external id. */
  const hungKeepHolds = async (externalId: string) => {
    await elsewhere.query('begin');
    await elsewhere.query(
      "insert into automations.delivery (id, team_id, subscription_id, external_id, received_at, source, inline, events, event_count) values ($1, $2, 'SLACK', $3, now(), 'webhook', false, '[]'::jsonb, 0)",
      [randomUUID(), teamId, externalId],
    );
  };
  const expectTryAgain = (settled: { ok: boolean; error?: unknown }) => {
    expect(settled.ok).toBe(false);
    expect(settled.error).toBeInstanceOf(at.DoorsTryAgain);
  };
  const clean = (async () => ({ diagnostics: [], gaps: [] })) as never;
  let movesMade = 0;
  const moved = async () => async () => {
    movesMade += 1;
    return { ok: true as const };
  };

  describe('an upgrade waits for the doors for a bounded time', () => {
    it('kept waiting by a door, it answers blocked and moves nothing; asked again, it moves', async () => {
      movesMade = 0;
      await elsewhere.query('begin');
      await elsewhere.query('select pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))', [doorsKey()]);

      const answer = await timed('the upgrade', at.upgradeMovement({ teamId, id: movementId, acknowledge: true, validate: clean, advance: moved }));

      expect(answer).toMatchObject({ ok: true, value: { status: 'blocked', detail: expect.stringMatching(/nothing moved.*try again/) } });
      expect(movesMade).toBe(0);

      await elsewhere.query('commit');
      expect(await at.upgradeMovement({ teamId, id: movementId, acknowledge: true, validate: clean, advance: moved })).toMatchObject({ status: 'upgraded' });
      expect(movesMade).toBe(1);
    }, 60_000);

    it('as many upgrades as the main pool holds, of one team, cannot stop the door they all wait for', async () => {
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
        return deliver('behind-the-upgrades');
      });
      await holding;
      const upgrades = Array.from({ length: poolMax }, () => at.upgradeMovement({ teamId, id: movementId, acknowledge: true, validate: clean, advance: moved }));
      await upgradeIsWaiting();
      await sleep(300);
      letDoorGo();

      await withinBudget('the door', door);

      const answers = await withinBudget('the upgrades', Promise.all(upgrades));
      for (const answer of answers) expect(['blocked', 'upgraded']).toContain(answer.status);
      expect(await keptIds()).toEqual(['behind-the-upgrades']);
    }, 60_000);

    it('the bound ends with the wait: the rest of its transaction may wait as long as it did', async () => {
      await at.inOneTransaction(teamId, async () => {
        const db = at.getAutomationsQb(['work']);
        const before = await sql<{ lock_timeout: string }>`show lock_timeout`.execute(db);
        await at.holdDoorsAlone(db, teamId);
        const after = await sql<{ lock_timeout: string }>`show lock_timeout`.execute(db);
        expect(after.rows).toEqual(before.rows);
      });
    }, 60_000);
  });

  describe("the lock's connection lost during a door", () => {
    it('a door still writing fails, keeps nothing, and leaves the process and the pool well; its retry keeps it once', async () => {
      const door = await timed(
        'the door',
        at.withDoorsHeld(teamId, async () => {
          await lockConnectionDies();
          return deliver('lost-mid-door');
        }),
      );

      expectTryAgain(door);
      expect(await keptIds()).toEqual([]);

      await withinBudget('the retry', at.withDoorsHeld(teamId, () => deliver('lost-mid-door')));
      expect(await keptIds()).toEqual(['lost-mid-door']);
    }, 60_000);

    it("a keep's write does not commit, and its retry keeps it once with what it owes", async () => {
      const store = at.deliveryRowStore({ host: 'platform', teamId });
      const delivery = { id: randomUUID(), subscriptionId: 'SLACK', externalId: 'lost-in-keep', receivedAt: new Date().toISOString(), source: 'webhook' as const, request: {} };
      const kept = await timed(
        'the keep',
        store.keepRawDelivery({
          delivery,
          work: async () => {
            await lockConnectionDies();
            return [];
          },
        }),
      );

      expectTryAgain(kept);
      expect(await keptIds()).toEqual([]);

      await withinBudget('the retry', keep('lost-in-keep'));
      expect(await keptIds()).toEqual(['lost-in-keep']);
    }, 60_000);

    it('an upgrade waiting on that door goes ahead, and the door writes nothing on the wrong side of the move', async () => {
      const door = at.withDoorsHeld(teamId, async () => {
        const upgraded = upgradeTakesDoors();
        await upgradeIsWaiting();
        await lockConnectionDies();
        await withinBudget('the upgrade', upgraded);
        return deliver('during-the-move');
      });

      expectTryAgain(await timed('the door', door));
      expect(await keptIds()).toEqual([]);

      await elsewhere.query('commit');
      await withinBudget('the retry', at.withDoorsHeld(teamId, () => deliver('during-the-move')));
      expect(await keptIds()).toEqual(['during-the-move']);
    }, 60_000);

    it('lost after the write committed, the door fails rather than vouch for what it read, and the retry dedupes', async () => {
      const door = await timed(
        'the door',
        at.withDoorsHeld(teamId, async () => {
          const delivered = await deliver('kept-then-lost');
          await lockConnectionDies();
          return delivered;
        }),
      );

      expectTryAgain(door);
      const retry = await withinBudget('the retry', at.withDoorsHeld(teamId, () => deliver('kept-then-lost')));
      expect(retry.kept.kept).toBe(false);
      expect(await keptIds()).toEqual(['kept-then-lost']);
    }, 60_000);
  });

  describe("a keep waits for another process's row for a bounded time", () => {
    it("stuck on a hung process's row, keeps fail and free the doors for every team; the retry keeps it once", async () => {
      const otherTeam = randomUUID() as TeamId;
      await at.getCoreQb(['team']).insertInto('team').values({ id: otherTeam, name: `pool-${otherTeam}` }).execute();
      try {
        await hungKeepHolds('hung');
        // Both of the doors' connections, were a keep to stay stuck on them.
        const stuck = [timed('a stuck keep', keep('hung')), timed('a stuck keep', keep('hung'))];
        await sleep(100);
        const others = await timed(
          "another team's door",
          at.keepForEveryVersion({ origin: { teamId: otherTeam, adapterType: 'slack', providerKey: 'SLACK', credentialsId: null }, subscriptionId: 'SLACK', externalId: 'other', source: 'webhook', request: {} }),
        );

        expect(others.ok).toBe(true);
        for (const settled of await Promise.all(stuck)) expectTryAgain(settled);

        await elsewhere.query('rollback');
        await withinBudget('the retry', keep('hung'));
        expect(await keptIds()).toEqual(['hung']);
      } finally {
        await at.cleanupTeam(otherTeam);
      }
    }, 60_000);

    it('a judged keep is bound the same', async () => {
      await hungKeepHolds('hung-judged');

      expectTryAgain(await timed('the keep', deliver('hung-judged')));

      await elsewhere.query('rollback');
      expect((await withinBudget('the retry', deliver('hung-judged'))).kept.kept).toBe(true);
      expect(await keptIds()).toEqual(['hung-judged']);
    }, 60_000);

    it('a row of the drain is deferred, spends no attempt, and keeps its delivery once the row lock goes', async () => {
      at.resetWorkHandlersForTests();
      at.registerSlackEventWork();
      const eventId = `Ev${randomUUID()}`;
      const envelope = { type: 'event_callback', team_id: slackTeam, event_id: eventId, event: { type: 'message', user: 'U1', channel: 'C1', ts: '1.0', text: 'hi' } };
      await at.enqueueSlackEvent({ envelope, rawBody: Buffer.from(JSON.stringify(envelope)) });
      await hungKeepHolds(`slack:${eventId}`);

      const pass = await withinBudget('the drain pass', at.drainWork({ owner: `pool-${poolMax}`, limit: 50 }));

      expect(pass.deferred).toBeGreaterThanOrEqual(1);
      const row = () => sql<{ attempts: number; deferrals: number }>`select attempts, deferrals from automations.work where kind = 'slack_event' and payload->'envelope'->>'event_id' = ${eventId}`.execute(at.globalQb);
      expect((await row()).rows).toEqual([{ attempts: 0, deferrals: 1 }]);

      await elsewhere.query('rollback');
      // On the drain's clock, which its claim compares with, as enqueueing does: the database's may run ahead.
      await sql`update automations.work set due_at = ${new Date()} where kind = 'slack_event' and payload->'envelope'->>'event_id' = ${eventId}`.execute(at.globalQb);
      await withinBudget('the next pass', at.drainWork({ owner: `pool-${poolMax}`, limit: 50 }));
      expect(await keptIds()).toEqual([`slack:${eventId}`]);
      expect((await row()).rows).toEqual([]);
    }, 60_000);
  });

  describe("a door's wait for the doors is bounded", () => {
    it('behind an upgrade holding them too long it fails before anything is kept, so its retry is the only delivery, even with no id', async () => {
      await upgradeTakesDoors();
      let bodyRan = false;

      const door = await timed(
        'the door',
        at.withDoorsHeld(teamId, async () => {
          bodyRan = true;
          return deliver(null);
        }),
      );

      expectTryAgain(door);
      expect(door.ms).toBeGreaterThanOrEqual(3_500);
      expect(door.ms).toBeLessThan(6_000);
      expect(bodyRan).toBe(false);

      await elsewhere.query('commit');
      await withinBudget('the retry', at.withDoorsHeld(teamId, () => deliver(null)));
      const { rows } = await look.query('select id from automations.delivery where team_id = $1', [teamId]);
      expect(rows).toHaveLength(1);
    }, 60_000);

    it('with both connections held too long it fails the same, and the doors holding them finish', async () => {
      let letThemGo = () => {};
      const go = new Promise<void>((resolve) => {
        letThemGo = resolve;
      });
      const holding = [0, 1].map((n) =>
        at.withDoorsHeld(teamId, async () => {
          await go;
          return deliver(`holding-${n}`);
        }),
      );
      await sleep(100);
      let bodyRan = false;

      const door = await timed(
        'the door',
        at.withDoorsHeld(teamId, async () => {
          bodyRan = true;
        }),
      );

      expectTryAgain(door);
      expect(door.ms).toBeGreaterThanOrEqual(3_500);
      expect(door.ms).toBeLessThan(6_000);
      expect(bodyRan).toBe(false);
      letThemGo();
      await withinBudget('the doors holding', Promise.all(holding));
      expect(await keptIds()).toEqual(['holding-0', 'holding-1']);
    }, 60_000);

    it('an upgrade only waiting for them delays a door behind it, and fails none', async () => {
      await elsewhere.query('begin');
      await elsewhere.query('select pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))', [doorsKey()]);
      const answer = at.upgradeMovement({ teamId, id: movementId, acknowledge: true, validate: clean, advance: moved });
      await upgradeIsWaiting();

      const door = await timed('the door', at.withDoorsHeld(teamId, () => deliver('behind-a-waiting-upgrade')));

      expect(door.ok).toBe(true);
      expect((await answer).status).toBe('blocked');
      expect(await keptIds()).toEqual(['behind-a-waiting-upgrade']);
    }, 60_000);

    it('the email door answers 500 with nothing kept, and the redelivery of mail with no Message-Id is one delivery', async () => {
      const claimant = randomUUID();
      const key = `pool-${randomUUID().slice(0, 8)}`;
      await at.getCoreQb(['user']).insertInto('user').values({ id: claimant, default_team_id: teamId, username: `pool-${claimant.slice(0, 8)}`, granted_access_at: new Date() } as never).execute();
      await at.getCoreQb(['team_membership']).insertInto('team_membership').values({ user_id: claimant, team_id: teamId, access: 'write' } as never).execute();
      await at.claimPublicInbox({ teamId, key, claimedByUserId: claimant as never });
      await at.insertTestListen({ teamId, movementId, adapterType: 'email', edge: 'Emails', delivery: 'connection', taken: at.takenEquals('Key', key) });
      const address = `inbox+${key}@example.com`;
      const body = { sender: 'someone@example.com', from: 'someone@example.com', recipient: address, subject: 'no id', 'body-plain': 'hi' };
      const post = () =>
        new Promise<number>((resolve, reject) => {
          const ctx = new at.Context();
          ctx.bindPrincipal(at.userPrincipal({ userId: claimant, teamId }));
          const res = { headersSent: false, status: (status: number) => ({ send: () => resolve(status) }) };
          void ctx.runAsync(async () => {
            at.inboundEmailHandler({ body, inboundEmailRoute: { key } } as never, res as never, reject);
          });
        });
      await upgradeTakesDoors();

      const answer = await timed('the email door', post());

      expect(answer).toMatchObject({ ok: true, value: 500 });
      expect(answer.ms).toBeLessThan(6_000);
      const delivered = async () => (await look.query('select id from automations.delivery where team_id = $1', [teamId])).rows;
      expect(await delivered()).toHaveLength(0);

      await elsewhere.query('commit');
      expect(await withinBudget('the redelivery', post())).toBeLessThan(300);
      expect(await delivered()).toHaveLength(1);
      await at.getAutomationsQb(['public_inbox']).deleteFrom('public_inbox').where('team_id', '=', teamId).execute();
    }, 60_000);
  });
});
