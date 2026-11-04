// The wake slot against the real work table: what enqueueWork, the drain's
// retries and deferrals, and the callback body's transaction tell the wake,
// and that a wake which refuses or hangs never holds up an enqueue nor loses
// its row.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { Context } from '../../context';
import { userPrincipal } from '../../principal';
import { WorkDeferred, drainWork, registerWorkHandler, resetWorkHandlersForTests } from '../drain';
import { claimDueWork, completeWork, enqueueWork, ensurePeriodicWork, listWorkByKind, removeWork } from '../store';
import { WAKE_WAIT_MS, installWake, resetWakeForTests, settleWakes, type WakeSlot } from '../wake';

interface Told {
  call: 'now' | 'at';
  kind: string;
  at?: Date;
}

function recordingSlot(onCall: () => Promise<void> = async () => {}): { slot: WakeSlot; told: Told[] } {
  const told: Told[] = [];
  return {
    told,
    slot: {
      now(kind) {
        told.push({ call: 'now', kind });
        return onCall();
      },
      at(kind, at) {
        told.push({ call: 'at', kind, at });
        return onCall();
      },
    },
  };
}

let teamId: TeamId;
const keys: string[] = [];

function freshKey(kind: string): string {
  const key = `${kind}:${randomUUID()}`;
  keys.push(key);
  return key;
}

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `wake-${teamId.slice(0, 8)}` } as any)
    .execute();
});

afterEach(async () => {
  resetWakeForTests();
  resetWorkHandlersForTests();
  for (const key of keys.splice(0)) await removeWork({ key });
  await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).execute();
});

afterAll(async () => {
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

describe('an outage', () => {
  it.each([
    ['refuses', () => Promise.reject(new Error('Cloud Tasks answered 503 UNAVAILABLE to a task create'))],
    ['hangs', () => new Promise<void>(() => {})],
  ])(
    'a wake that %s leaves enqueueWork resolved within WAKE_WAIT_MS, and the next tick drains the row',
    async (_label, answer) => {
      const { slot, told } = recordingSlot(answer);
      installWake(slot);
      const ran: unknown[] = [];
      registerWorkHandler('resume_timer', {
        async run(payload) {
          ran.push(payload);
        },
      });

      const key = freshKey('resume_timer');
      const started = Date.now();
      await enqueueWork({ kind: 'resume_timer', key, teamId, payload: { runId: key } });
      expect(Date.now() - started).toBeLessThan(WAKE_WAIT_MS + 500);
      expect(told).toEqual([{ call: 'now', kind: 'resume_timer' }]);

      // The safety tick: a drain the wake never started.
      const result = await drainWork({ teamId });
      expect(result).toMatchObject({ claimed: 1, ran: 1, failed: 0 });
      expect(ran).toEqual([{ runId: key }]);
      expect((await listWorkByKind('resume_timer')).find((row) => row.key === key)).toBeUndefined();
      await settleWakes(10);
    },
  );
});

describe('what enqueueWork tells the wake', () => {
  it("enqueueWork announces the row's resulting due time: an earlier unleased due wins", async () => {
    const { slot, told } = recordingSlot();
    installWake(slot);
    const key = freshKey('poll_edge');
    const base = Date.now() + 10 * 60_000;
    const at = (minutes: number) => new Date(base + minutes * 60_000);

    await enqueueWork({ kind: 'poll_edge', key, teamId, payload: {}, dueAt: at(10) });
    await enqueueWork({ kind: 'poll_edge', key, teamId, payload: {}, dueAt: at(20) });
    await enqueueWork({ kind: 'poll_edge', key, teamId, payload: {}, dueAt: at(5) });

    expect(told).toEqual([
      { call: 'at', kind: 'poll_edge', at: at(10) },
      { call: 'at', kind: 'poll_edge', at: at(10) },
      { call: 'at', kind: 'poll_edge', at: at(5) },
    ]);
  });

  it('a periodic row is never announced', async () => {
    const { slot, told } = recordingSlot();
    installWake(slot);
    const key = freshKey('timer_sweep');
    // Due in 2001 so only this row is due at the claim's `now`.
    const T0 = new Date('2001-01-01T00:00:00.000Z');
    await ensurePeriodicWork({ kind: 'timer_sweep', key, intervalMs: 30_000, dueAt: T0 });
    const claimed = (await claimDueWork({ owner: 'wake-test', limit: 100, leaseMs: 30_000, now: new Date(T0.getTime() + 1_000) })).filter(
      (row) => row.key === key,
    );
    expect(claimed).toHaveLength(1);
    const [row] = claimed;
    if (!row?.leaseToken) throw new Error('expected a claim');
    await completeWork({ id: row.id, leaseToken: row.leaseToken, claimedUpdatedAt: row.updatedAt });
    const rearmed = (await listWorkByKind('timer_sweep')).find((each) => each.key === key);
    expect(rearmed?.dueAt.getTime()).toBeGreaterThan(Date.now());
    expect(told).toEqual([]);
  });
});

describe('a work row written in a request transaction', () => {
  // The slot reads the row from outside the transaction, as a drain the wake
  // started would: before the commit it finds nothing.
  function slotThatReadsTheRow(key: string): { told: Told[]; seen: boolean[] } {
    const told: Told[] = [];
    const seen: boolean[] = [];
    const read = async (): Promise<void> => {
      const { rows } = await sql<{ id: string }>`
        SELECT id FROM automations.work WHERE key = ${key}`.execute(getAutomationsQb(['work']));
      seen.push(rows.length === 1);
    };
    installWake({
      async now(kind) {
        told.push({ call: 'now', kind });
        await read();
      },
      async at(kind, at) {
        told.push({ call: 'at', kind, at });
        await read();
      },
    });
    return { told, seen };
  }

  function requestContext(): Context {
    const ctx = new Context();
    ctx.bindPrincipal(userPrincipal({ userId: randomUUID(), teamId }));
    return ctx;
  }

  it('is announced after the transaction commits, and the drain it starts finds the row', async () => {
    const key = freshKey('poll_edge');
    const { told, seen } = slotThatReadsTheRow(key);
    const ctx = requestContext();

    await ctx.runAsync(async () => {
      await ctx.enterTransaction();
      await enqueueWork({ kind: 'poll_edge', key, teamId, payload: {} });
      expect(told).toEqual([]);
    });

    await settleWakes(WAKE_WAIT_MS);
    expect(told).toEqual([{ call: 'now', kind: 'poll_edge' }]);
    expect(seen).toEqual([true]);
  });

  it('is announced by nothing when the transaction rolls back', async () => {
    const key = freshKey('poll_edge');
    const { told } = slotThatReadsTheRow(key);
    const ctx = requestContext();

    await expect(
      ctx.runAsync(async () => {
        await ctx.enterTransaction();
        await enqueueWork({ kind: 'poll_edge', key, teamId, payload: {} });
        throw new Error('the request failed');
      }),
    ).rejects.toThrow('the request failed');

    await settleWakes(WAKE_WAIT_MS);
    expect(told).toEqual([]);
    // Other suites' shared polls may be armed in the same table: only this key is this test's.
    expect((await listWorkByKind('poll_edge')).filter((row) => row.key === key)).toEqual([]);
  });
});

describe('a shipped schedule asking for a reconcile', () => {
  it('while the periodic row is leased gets its own row due now, which does not re-arm', async () => {
    // Other suites' rows of this kind must not be claimed in their place.
    await getAutomationsQb(['work']).deleteFrom('work').where('host', '=', 'platform').where('kind', '=', 'timer_sweep').execute();
    await ensurePeriodicWork({ kind: 'timer_sweep', key: 'timer_sweep', intervalMs: 3_600_000, dueAt: new Date(Date.now() - 1000) });
    const [periodic] = await claimDueWork({ owner: 'ship-test', limit: 1, leaseMs: 60_000, kinds: ['timer_sweep'] });
    expect(periodic.key).toBe('timer_sweep');

    await enqueueWork({ kind: 'timer_sweep', key: 'timer_sweep:shipped' });

    const rows = await listWorkByKind('timer_sweep');
    const shipped = rows.find((row) => row.key === 'timer_sweep:shipped');
    expect(shipped?.intervalMs).toBeNull();
    expect(shipped?.dueAt.getTime()).toBeLessThanOrEqual(Date.now());
    const [claimed] = await claimDueWork({ owner: 'ship-test', limit: 1, leaseMs: 60_000, kinds: ['timer_sweep'] });
    expect(claimed.key).toBe('timer_sweep:shipped');

    await completeWork({ id: claimed.id, leaseToken: claimed.leaseToken!, claimedUpdatedAt: claimed.updatedAt });
    const after = await listWorkByKind('timer_sweep');
    expect(after.map((row) => row.key)).toEqual(['timer_sweep']);
    await removeWork({ key: 'timer_sweep' });
  });
});

describe('what the drain tells the wake', () => {
  it('a released row is announced at its backoff, a deferred one at its deferral', async () => {
    const { slot, told } = recordingSlot();
    registerWorkHandler('resume_timer', {
      async run() {
        throw new Error('the handler failed');
      },
    });
    registerWorkHandler('poll_edge', {
      async run() {
        throw new WorkDeferred('the run is busy elsewhere');
      },
    });
    await enqueueWork({ kind: 'resume_timer', key: freshKey('resume_timer'), teamId, payload: {} });
    await enqueueWork({ kind: 'poll_edge', key: freshKey('poll_edge'), teamId, payload: {} });
    installWake(slot);

    const before = Date.now();
    const result = await drainWork({ teamId });
    const after = Date.now();
    expect(result).toMatchObject({ claimed: 2, failed: 1, deferred: 1 });

    const released = told.find((each) => each.kind === 'resume_timer');
    const deferred = told.find((each) => each.kind === 'poll_edge');
    expect(told).toHaveLength(2);
    // The first attempt's backoff is 1 s; the first deferral's is 2 s.
    expect(released?.call).toBe('at');
    expect(released?.at?.getTime()).toBeGreaterThanOrEqual(before + 1_000);
    expect(released?.at?.getTime()).toBeLessThanOrEqual(after + 1_000);
    expect(deferred?.call).toBe('at');
    expect(deferred?.at?.getTime()).toBeGreaterThanOrEqual(before + 2_000);
    expect(deferred?.at?.getTime()).toBeLessThanOrEqual(after + 2_000);

    // As the rows hold them.
    const rows = await getAutomationsQb(['work'])
      .selectFrom('work')
      .select(['kind', 'due_at'])
      .where('team_id', '=', teamId)
      .execute();
    expect(Object.fromEntries(rows.map((row) => [row.kind, row.due_at.getTime()]))).toEqual({
      resume_timer: released?.at?.getTime(),
      poll_edge: deferred?.at?.getTime(),
    });
  });
});
