// The lf store module over the platform's run tables (real DB), called
// in-process as the slot route calls it, under two throwaway tenants. What it
// must keep apart: lf's rows from the platform's (a claim, a sweep), and one
// tenant's rows from another's (every method); what it must keep whole: each
// composite write.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { SlotRefusal } from 'module-runtime/module_wire/wire';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { enqueueWork } from '../../work/store';
import { settleOrphanedRunningRuns } from '../../translation_graph/runs/trigger_run';
import { returnLeavesOfLapsedLeases } from '../../movement_engine/run_host_store';
import { answerFor } from '../answer';

const past = (ms: number) => new Date(Date.now() - ms).toISOString();
const future = (ms: number) => new Date(Date.now() + ms).toISOString();

let teamA: TeamId;
let teamB: TeamId;

beforeEach(() => {
  teamA = randomUUID() as TeamId;
  teamB = randomUUID() as TeamId;
});

afterEach(async () => {
  await cleanupTeam(teamA);
  await cleanupTeam(teamB);
});

function store(tenant: string) {
  const answer = answerFor({ tenant });
  return (method: string, params: Record<string, unknown> = {}) => answer(method, params, {});
}

async function refusal(promise: Promise<unknown>): Promise<SlotRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SlotRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

async function newRun(tenant: string, overrides: { startedAt?: string; deliveryId?: string } = {}): Promise<string> {
  const id = randomUUID();
  await store(tenant)('runs.start', {
    id,
    file: 'welcome.lf',
    movement: 'greet',
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    input: '{"who":"ada"}',
    deliveryId: overrides.deliveryId ?? null,
  });
  return id;
}

async function runRow(id: string) {
  return getAutomationsQb(['trigger_run']).selectFrom('trigger_run').selectAll().where('id', '=', id as never).executeTakeFirstOrThrow();
}

function delivery(externalId: string | null) {
  return { id: randomUUID(), externalId, receivedAt: new Date().toISOString(), source: 'webhook', inline: false, replayOf: null, events: [{ n: 1 }] };
}

describe('the lf store module', () => {
  it('an lf claim never takes a platform row', async () => {
    const lf = store(teamA);
    const shared = `resume_timer:${randomUUID()}`;
    const platformKeys = [shared, `wake_await:${randomUUID()}`, `wake_await:${randomUUID()}`];
    const kinds = ['resume_timer', 'wake_await', 'wake_await'] as const;
    for (const [i, key] of platformKeys.entries()) {
      await enqueueWork({ kind: kinds[i] ?? 'resume_timer', key, teamId: teamA, dueAt: new Date(Date.now() - 1_000) });
    }
    // lf's row under the platform's key is a second row, lf's own.
    await lf('work.enqueue', { kind: 'resume_timer', key: shared, payload: { n: 1 }, dueAt: past(1_000), teamId: null });

    const claimed = [
      ...((await lf('work.claimDue', { limit: 100, leaseMs: 60_000, kinds: [...kinds] })) as { key: string; id: string }[]),
      ...((await lf('work.claimDue', { limit: 100, leaseMs: 60_000 })) as { key: string; id: string }[]),
    ];

    const platformRows = await getAutomationsQb(['work']).selectFrom('work').selectAll().where('host', '=', 'platform').where('key', 'in', platformKeys).execute();
    expect(platformRows).toHaveLength(3);
    for (const row of platformRows) expect(row).toMatchObject({ lease_owner: null, lease_token: null, attempts: 0 });
    expect(claimed.map((row) => row.key)).toEqual([shared]);
    expect(platformRows.some((row) => row.id === claimed[0]?.id)).toBe(false);
  });

  it("keeps two tenants' rows under one work key apart, and hands each its key as it gave it", async () => {
    const [a, b] = [store(teamA), store(teamB)];
    const key = `poll_edge:acme_crm-${randomUUID()}`;
    await a('work.enqueue', { kind: 'poll_edge', key, payload: { tenant: 'a' }, dueAt: past(1_000) });
    await b('work.enqueue', { kind: 'poll_edge', key, payload: { tenant: 'b' }, dueAt: past(1_000) });

    const stored = await getAutomationsQb(['work']).selectFrom('work').select(['key', 'team_id']).where('host', '=', 'lf').where('key', 'like', `%${key}`).orderBy('key').execute();
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((row) => row.key))).toEqual(new Set([`lf:${teamA}:${key}`, `lf:${teamB}:${key}`]));

    for (const [tenant, name] of [[a, 'a'], [b, 'b']] as const) {
      const claimed = (await tenant('work.claimDue', { limit: 10, leaseMs: 60_000 })) as { key: string; payload: unknown }[];
      expect(claimed).toEqual([expect.objectContaining({ key, payload: { tenant: name } })]);
    }
  });

  it("a lapsed lf lease is lf's to fail", async () => {
    const lf = store(teamA);
    const runId = await newRun(teamA, { startedAt: past(10 * 60_000) });
    const lease = (await lf('leases.claim', { runId, ttlMs: 60_000 })) as { token: string };
    await lf('parks.putLeaf', { runId, address: 's0', reason: 'timer', wakeAt: future(60_000), state: {}, fence: lease.token });
    expect(await lf('parks.claimLeaf', { runId, address: 's0', reason: null })).toEqual({ reason: 'timer', state: {} });
    // The container died: its lease lapsed and its heartbeat went stale long ago.
    await sql`update automations.trigger_run set lease_until = now() - interval '1 minute', last_heartbeat_at = now() - interval '1 day'
              where id = ${runId}::uuid`.execute(getAutomationsQb(['trigger_run']));

    await settleOrphanedRunningRuns();
    await returnLeavesOfLapsedLeases();

    expect((await runRow(runId)).status).toBe('running');
    expect(await lf('parks.leaves', { runId })).toEqual([{ address: 's0', reason: 'timer', status: 'resuming', wakeAt: expect.any(String) }]);
    expect(await lf('runs.lapsed', { staleMs: 60_000, limit: 10 })).toEqual([runId]);

    await lf('records.markFailed', { runId, message: 'the worker running this run was lost' });

    expect(await lf('runs.get', { runId })).toMatchObject({ status: 'failed', outcome: JSON.stringify({ error: 'the worker running this run was lost' }) });
    expect(await lf('runs.lapsed', { staleMs: 60_000, limit: 10 })).toEqual([]);
  });

  it('two tenants keep the same subscription and external id each', async () => {
    const [a, b] = [store(teamA), store(teamB)];
    const externalId = `x-${randomUUID()}`;
    const keep = (tenant: typeof a) =>
      tenant('inbound.keepDelivery', { subscriptionId: 'acme_crm', checkpoint: null, delivery: delivery(externalId), work: [] });

    expect(await keep(a)).toEqual({ kept: true, arrivalMark: expect.any(Number) });
    expect(await keep(b)).toEqual({ kept: true, arrivalMark: expect.any(Number) });
    expect(await keep(a)).toEqual({ kept: false });
    expect(await keep(b)).toEqual({ kept: false });

    for (const tenant of [a, b]) {
      const listed = (await tenant('inbound.deliveries', { subscriptionId: 'acme_crm', limit: 10 })) as { externalId: string }[];
      expect(listed.map((row) => row.externalId)).toEqual([externalId]);
    }
  });

  it("another tenant's rows are invisible to every method", async () => {
    const [a, b] = [store(teamA), store(teamB)];
    const runId = await newRun(teamA);
    await a('parks.putLeaf', { runId, address: 's0', reason: 'await', state: {}, fence: null });
    const since = (await a('waits.mark')) as number;
    const { waitId } = (await a('waits.open', { runId, teamId: teamA, adapterType: 'slack', edge: 'Replies', key: 'thread:1', since })) as { waitId: string };
    await a('parks.commit', { runId, address: 's0', state: {}, fence: null, park: { kind: 'wait', waitId } });
    await a('waits.log', { teamId: teamA, adapterType: 'slack', arrivals: [{ edge: 'Replies', key: 'thread:1', identity: 'r1', version: null, landing: null, gone: true }], at: new Date().toISOString(), resendWindowMs: 60_000 });
    await a('work.enqueue', { kind: 'wake_await', key: `wake_await:${randomUUID()}`, payload: {}, dueAt: past(1_000) });
    await a('inbound.keepDelivery', { subscriptionId: 'acme_crm', delivery: delivery(`x-${randomUUID()}`), work: [] });
    await a('sources.put', { teamId: teamA, hash: 'sha256:abc', source: 'text' });
    await a('listens.setPaused', { pipeline: 'listen:f:m', paused: 'LISTEN_LOOP: too deep' });
    await a('writes.record', { adapter: 'slack', recordType: 'Message', externalId: 'm1', runId, depth: 1, at: past(0), forgetBefore: past(60_000) });
    await a('releases.note', { version: '0.13.0', at: past(0) });
    const bRun = await newRun(teamB);

    expect(await b('runs.get', { runId })).toBeNull();
    expect(await b('runs.list', { limit: 10 })).toEqual([expect.objectContaining({ id: bRun })]);
    expect(await b('runs.status', { runId })).toBe('missing');
    expect(await b('parks.leaves', { runId })).toEqual([]);
    expect(await b('parks.claimLeaf', { runId, address: 's0' })).toBeNull();
    expect(await b('leases.claim', { runId, ttlMs: 60_000 })).toBeNull();
    expect(await b('work.claimDue', { limit: 100, leaseMs: 60_000 })).toEqual([]);
    expect(await b('inbound.deliveries', { limit: 10 })).toEqual([]);
    expect(await b('sources.get', { teamId: teamA, hash: 'sha256:abc' })).toBeNull();
    expect(await b('waits.stranded', { runId })).toEqual([]);
    expect(await b('waits.stranded', { limit: 100 })).toEqual([]);
    expect(await a('waits.stranded', { runId })).toEqual([expect.objectContaining({ waitId, parked: true })]);
    expect((await refusal(b('waits.arrivals', { waitId }))).code).toBe('bad_request');
    expect((await refusal(b('waits.note', { waitId, identity: 'r1', version: null, matched: true }))).code).toBe('bad_request');
    expect(await b('listens.states', { pipelines: ['listen:f:m'] })).toEqual({});
    expect(await b('writes.depth', { adapter: 'slack', recordType: 'Message', externalId: 'm1', since: past(60_000) })).toBeNull();
    expect(await b('releases.list', { limit: 10 })).toEqual([]);

    // A write naming A's team is refused, whichever run it is on.
    for (const [method, params] of [
      ['sources.put', { teamId: teamA, hash: 'sha256:abc', source: 'text' }],
      ['work.enqueue', { kind: 'wake_await', key: `wake_await:${randomUUID()}`, payload: {}, teamId: teamA }],
      ['runs.start', { id: randomUUID(), file: 'f', movement: 'm', startedAt: past(0), input: '{}', teamId: teamA }],
      ['events.claim', { listen: 'listen:f:m', key: 'k', teamId: teamA }],
      ['waits.open', { runId: bRun, teamId: teamA, adapterType: 'slack', edge: 'Replies', key: 'thread:1', since }],
      ['waits.log', { teamId: teamA, adapterType: 'slack', arrivals: [], at: past(0), resendWindowMs: 0 }],
      ['parks.commitSegment', { runId: bRun, teamId: teamA, fence: null, resumed: null, joins: [], parks: [], settle: null }],
      ['inbound.keepDelivery', { subscriptionId: 's', delivery: delivery(null), work: [], arrivals: { teamId: teamA, adapterType: 'slack', arrivals: [], at: past(0), resendWindowMs: 0 } }],
    ] as const) {
      const refused = await refusal(b(method, params));
      expect({ method, code: refused.code, message: refused.message }).toEqual({ method, code: 'bad_request', message: expect.stringContaining("another tenant's") });
    }
    // A write on A's run under B's key lands nowhere.
    await expect(b('waits.open', { runId, teamId: teamB, adapterType: 'slack', edge: 'Replies', key: 'thread:1', since })).rejects.toThrow(SlotRefusal);
    await expect(b('parks.putLeaf', { runId, address: 's1', reason: 'await', state: {}, fence: null })).rejects.toThrow('has no trigger_run row');
    await expect(b('parks.commit', { runId, address: 's1', state: {}, fence: null, park: { kind: 'limit' } })).rejects.toThrow('has no trigger_run row');
    await b('runs.settle', { runId, status: 'failed', outcome: { error: 'not yours' }, at: new Date().toISOString() });
    await b('records.markFailed', { runId, message: 'not yours' });
    expect(await b('leases.dropRunState', { runId, fence: null })).toBe(true);
    expect(await a('runs.get', { runId })).toMatchObject({ status: 'parked' });
    expect(await a('parks.leaves', { runId })).toEqual([expect.objectContaining({ address: 's0' })]);
    expect(await a('waits.stranded', { runId })).toEqual([expect.objectContaining({ waitId })]);
  });

  it('keeps a park whole: a commit on a wait the run has not leaves no leaf and the run not parked', async () => {
    const lf = store(teamA);
    const runId = await newRun(teamA);
    const lease = (await lf('leases.claim', { runId, ttlMs: 60_000 })) as { token: string };
    await expect(lf('parks.commit', { runId, address: 's0', state: {}, fence: lease.token, park: { kind: 'wait', waitId: randomUUID() } })).rejects.toThrow(
      'has no wait',
    );

    expect(await lf('parks.leaves', { runId })).toEqual([]);
    expect((await runRow(runId)).status).toBe('running');

    // A timer park commits whole; a lost fence writes nothing.
    await lf('parks.commit', { runId, address: 's0', state: {}, fence: lease.token, park: { kind: 'timer', wakeAt: future(60_000) } });
    expect((await runRow(runId)).status).toBe('parked');
    const timer = await getAutomationsQb(['work']).selectFrom('work').selectAll().where('host', '=', 'lf').where('key', '=', `lf:${teamA}:resume_timer:${runId}`).executeTakeFirst();
    expect(timer).toMatchObject({ team_id: teamA, kind: 'resume_timer', payload: { runId } });
    const lost = await refusal(lf('parks.commit', { runId, address: 's1', state: {}, fence: randomUUID(), park: { kind: 'limit' } }));
    expect({ code: lost.code, data: lost.data }).toEqual({ code: 'run_lease_lost', data: { runId } });
    expect(((await lf('parks.leaves', { runId })) as { address: string }[]).map((leaf) => leaf.address)).toEqual(['s0']);
    // A park of the retired await kind is not one.
    const retired = await refusal(lf('parks.commit', { runId, address: 's2', state: {}, fence: lease.token, park: { kind: 'await', teamId: teamA, adapterType: 'slack', correlationKey: 'k' } }));
    expect(retired.code).toBe('bad_request');
  });

  it('a lost fence on a wait note is the lease lost, and a segment that parks a wait with unread arrivals wakes it', async () => {
    const lf = store(teamA);
    const runId = await newRun(teamA);
    const lease = (await lf('leases.claim', { runId, ttlMs: 60_000 })) as { token: string };
    const since = (await lf('waits.mark')) as number;
    const { waitId } = (await lf('waits.open', { runId, teamId: teamA, adapterType: 'slack', edge: 'Replies', key: 'thread:1', since })) as { waitId: string };
    await lf('waits.log', { teamId: teamA, adapterType: 'slack', arrivals: [{ edge: 'Replies', key: 'thread:1', identity: 'r1', version: null, landing: { text: 'hi' }, gone: false }], at: past(0), resendWindowMs: 60_000 });

    const lost = await refusal(lf('waits.note', { waitId, identity: 'r1', version: null, matched: true, fence: randomUUID() }));
    expect({ code: lost.code, data: lost.data }).toEqual({ code: 'run_lease_lost', data: { runId } });

    const wakes = await lf('parks.commitSegment', {
      runId,
      teamId: teamA,
      fence: lease.token,
      resumed: null,
      joins: [{ frameAddress: 'f0', pending: 2 }],
      parks: [{ address: 's0', state: { at: 's0' }, park: { kind: 'wait', waitId } }],
      settle: null,
      owedRaces: [{ frameAddress: 'r0', state: { arm: 1 } }],
    });
    expect(wakes).toEqual([{ runId, waitId, address: 's0' }]);
    expect(await lf('joins.frames', { runId })).toEqual(['f0']);
    expect(await lf('parks.owedRaces', { runId })).toEqual([{ frameAddress: 'r0', state: { arm: 1 } }]);
    const rows = (await lf('work.claimDue', { limit: 10, leaseMs: 60_000 })) as { kind: string; key: string; payload: unknown }[];
    expect(rows.map((row) => row.kind).sort()).toEqual(['settle_race', 'wake_await']);
    expect(rows.find((row) => row.kind === 'wake_await')).toMatchObject({ key: expect.stringMatching(/^wake_await:/), payload: { runId, waitId, address: 's0' } });
    expect(rows.find((row) => row.kind === 'settle_race')?.key).toBe(`settle_race:${runId}:r0`);

    await lf('joins.deleteFrames', { runId, frameAddresses: ['r0'] });
    expect(await lf('parks.owedRaces', { runId })).toEqual([]);
  });

  it('keeps a duplicate delivery out whole: no cursor and no rows', async () => {
    const lf = store(teamA);
    const externalId = `x-${randomUUID()}`;
    const first = { kind: 'fire_event', key: `fire_event:${randomUUID()}`, payload: { n: 1 }, dueAt: future(60_000), teamId: null };
    const second = { ...first, key: `fire_event:${randomUUID()}` };
    const again = delivery(externalId);

    expect(await lf('inbound.keepDelivery', { subscriptionId: 'acme_crm', checkpoint: 'c1', delivery: delivery(externalId), work: [first] })).toEqual({
      kept: true,
      arrivalMark: expect.any(Number),
    });
    expect(await lf('inbound.keepDelivery', { subscriptionId: 'acme_crm', checkpoint: 'c2', delivery: again, work: [second] })).toEqual({ kept: false });

    expect(await lf('inbound.checkpoint', { subscriptionId: 'acme_crm' })).toEqual({ checkpoint: 'c1' });
    const keys = (await getAutomationsQb(['work']).selectFrom('work').select('key').where('team_id', '=', teamA).execute()).map((row) => row.key);
    expect(keys).toEqual([`lf:${teamA}:${first.key}`]);
    expect(await lf('inbound.delivery', { id: again.id })).toBeNull();
    // An absent cursor is left as it is; a null one is saved.
    await lf('inbound.keepDelivery', { subscriptionId: 'acme_crm', delivery: delivery(null), work: [] });
    expect(await lf('inbound.checkpoint', { subscriptionId: 'acme_crm' })).toEqual({ checkpoint: 'c1' });
    await lf('inbound.keepDelivery', { subscriptionId: 'acme_crm', checkpoint: null, delivery: delivery(null), work: [] });
    expect(await lf('inbound.checkpoint', { subscriptionId: 'acme_crm' })).toEqual({ checkpoint: null });
  });

  it('stamps the heartbeat on start, claim and renew', async () => {
    const lf = store(teamA);
    const runId = await newRun(teamA, { startedAt: past(60 * 60_000) });
    const started = await runRow(runId);
    expect(started).toMatchObject({ host: 'lf', trigger_type: 'webhook', trigger_id: 'listen:welcome.lf:greet', status: 'running' });
    expect(started.trigger_payload).toEqual({ file: 'welcome.lf', movement: 'greet', facts: '{"who":"ada"}' });
    expect(Date.now() - (started.last_heartbeat_at?.getTime() ?? 0)).toBeLessThan(60_000);

    const stale = sql`update automations.trigger_run set last_heartbeat_at = now() - interval '1 day' where id = ${runId}::uuid`;
    const beat = async () => (await runRow(runId)).last_heartbeat_at?.getTime() ?? 0;

    await stale.execute(getAutomationsQb(['trigger_run']));
    const lease = (await lf('leases.claim', { runId, ttlMs: 60_000 })) as { token: string };
    expect(Date.now() - (await beat())).toBeLessThan(60_000);

    await stale.execute(getAutomationsQb(['trigger_run']));
    expect(await lf('leases.renew', { runId, token: lease.token, ttlMs: 60_000 })).toBe(true);
    expect(Date.now() - (await beat())).toBeLessThan(60_000);
  });

  it('keeps lf\'s words for its statuses and hands its outcome back as it was given', async () => {
    const lf = store(teamA);
    const runId = await newRun(teamA);
    await lf('runs.settle', { runId, status: 'completed', outcome: { writes: 2, returned: { value: { b: 1, a: 2 } } }, at: new Date().toISOString() });

    expect((await runRow(runId)).status).toBe('success');
    expect(await lf('runs.get', { runId })).toMatchObject({
      status: 'completed',
      outcome: '{"writes":2,"returned":{"value":{"b":1,"a":2}}}',
    });
    expect(await lf('runs.get', { runId: 'not-a-uuid' })).toBeNull();
  });

  it('claims and buries work as lf does, and refuses a kind that is not lf\'s', async () => {
    const lf = store(teamA);
    const key = `wake_await:${randomUUID()}`;
    await lf('work.enqueue', { kind: 'wake_await', key, payload: { n: 1 }, dueAt: past(1_000) });
    const [row] = (await lf('work.claimDue', { limit: 10, leaseMs: 60_000, kinds: ['wake_await'] })) as { id: string; claim: string; attempts: number }[];
    expect(row).toMatchObject({ key, payload: { n: 1 }, attempts: 1 });
    expect(JSON.parse(row?.claim ?? '')).toEqual({ leaseToken: expect.any(String), claimedUpdatedAt: expect.any(String) });

    await lf('work.release', { id: row?.id, claim: row?.claim, dueAt: past(1_000), why: 'busy' });
    const [again] = (await lf('work.claimDue', { limit: 10, leaseMs: 60_000 })) as { id: string; claim: string; attempts: number }[];
    expect(again?.attempts).toBe(1);
    await lf('work.bury', { id: again?.id, claim: again?.claim, reason: 'gave up' });
    expect(await lf('work.claimDue', { limit: 10, leaseMs: 60_000 })).toEqual([]);
    // Queued again, a dead row lives again, its attempts from nought.
    await lf('work.enqueue', { kind: 'wake_await', key, payload: { n: 2 }, dueAt: past(1_000) });
    expect(await lf('work.claimDue', { limit: 10, leaseMs: 60_000 })).toEqual([expect.objectContaining({ key, attempts: 1 })]);

    await expect(lf('work.claimDue', { limit: 10, leaseMs: 60_000, kinds: ['dispatch_event'] })).rejects.toThrow(
      'not a work kind: dispatch_event (the kinds: resume_timer, wake_await, fire_event, poll_edge, resolve_listen, refresh_subscription, settle_race)',
    );
    await expect(lf('work.enqueue', { kind: 'dispatch_event', key: 'k', payload: {} })).rejects.toThrow('not a work kind: dispatch_event');
  });

  it('queues a row only when no row has its key, in any state, and leaves a row there as it is', async () => {
    const [a, b] = [store(teamA), store(teamB)];
    const key = `poll_edge:acme_crm-${randomUUID()}`;
    const row = (payload: unknown, dueAt: string) => ({ kind: 'poll_edge', key, payload, dueAt });
    const stored = () =>
      getAutomationsQb(['work']).selectFrom('work').selectAll().where('host', '=', 'lf').where('key', '=', `lf:${teamA}:${key}`).execute();

    expect(await a('work.enqueueIfAbsent', row({ n: 1 }, past(1_000)))).toBe(true);
    const [first] = await stored();
    expect(first).toMatchObject({ payload: { n: 1 }, team_id: teamA, attempts: 0 });

    // Queued: a second arm queues nothing and moves nothing.
    expect(await a('work.enqueueIfAbsent', row({ n: 2 }, past(500)))).toBe(false);
    expect(await stored()).toEqual([first]);

    // Leased.
    const [claimed] = (await a('work.claimDue', { limit: 10, leaseMs: 60_000 })) as { id: string; claim: string }[];
    const [leased] = await stored();
    expect(leased?.lease_token).not.toBeNull();
    expect(await a('work.enqueueIfAbsent', row({ n: 3 }, future(60_000)))).toBe(false);
    expect(await stored()).toEqual([leased]);

    // Dead.
    await a('work.bury', { id: claimed?.id, claim: claimed?.claim, reason: 'gave up' });
    const [dead] = await stored();
    expect(dead?.dead_at).not.toBeNull();
    expect(await a('work.enqueueIfAbsent', row({ n: 4 }, past(1_000)))).toBe(false);
    expect(await stored()).toEqual([dead]);

    // Another team's same key is its own row.
    expect(await b('work.enqueueIfAbsent', row({ n: 5 }, past(1_000)))).toBe(true);
    expect(await b('work.enqueueIfAbsent', row({ n: 6 }, past(1_000)))).toBe(false);
    expect(await stored()).toEqual([dead]);

    await expect(a('work.enqueueIfAbsent', { kind: 'dispatch_event', key: 'k', payload: {} })).rejects.toThrow('not a work kind: dispatch_event');
    await expect(a('work.enqueueIfAbsent', { ...row({}, past(1)), teamId: teamB })).rejects.toThrow(SlotRefusal);
  });

  it('sweeps only settled deliveries no lf fire_event row names, and swaps processes by compare-and-set', async () => {
    const lf = store(teamA);
    const settled = delivery(null);
    const queued = delivery(null);
    const running = delivery(null);
    const old = past(60 * 60_000);
    await lf('inbound.keepDelivery', { subscriptionId: 's', delivery: { ...settled, receivedAt: old }, work: [] });
    await lf('inbound.keepDelivery', {
      subscriptionId: 's',
      delivery: { ...queued, receivedAt: old },
      work: [{ kind: 'fire_event', key: `fire_event:${randomUUID()}`, payload: { deliveryId: queued.id }, dueAt: future(60_000) }],
    });
    await lf('inbound.keepDelivery', { subscriptionId: 's', delivery: { ...running, receivedAt: old }, work: [] });
    await newRun(teamA, { deliveryId: running.id });

    expect(await lf('inbound.sweepDeliveries', { before: past(0), limit: 10 })).toBe(1);
    expect(await lf('inbound.delivery', { id: settled.id })).toBeNull();
    expect(await lf('inbound.delivery', { id: running.id })).toMatchObject({ runs: [{ status: 'running' }], events: [{ n: 1 }] });

    expect(await lf('processes.list')).toEqual({ processes: [], version: 0 });
    expect(await lf('processes.swap', { version: 0, processes: [{ pid: 1 }] })).toBe(true);
    expect(await lf('processes.swap', { version: 0, processes: [{ pid: 2 }] })).toBe(false);
    expect(await lf('processes.swap', { version: 1, processes: [{ pid: 3 }] })).toBe(true);
    expect(await lf('processes.list')).toEqual({ processes: [{ pid: 3 }], version: 2 });
    expect(await store(teamB)('processes.list')).toEqual({ processes: [], version: 0 });
  });

  it("starts an event's run once per team, and pages its failed runs", async () => {
    const lf = store(teamA);
    const runId = randomUUID();
    const kept = delivery(null);
    await lf('inbound.keepDelivery', { subscriptionId: 's', delivery: kept, work: [] });
    const start = { listen: 'listen:welcome.lf:greet', key: 'evt-1', id: runId, file: 'welcome.lf', movement: 'greet', startedAt: new Date().toISOString(), input: '{}', deliveryId: kept.id };
    expect(await lf('events.startRun', start)).toBe(true);
    expect(await lf('events.startRun', { ...start, id: randomUUID(), teamId: teamA })).toBe(false);
    expect(await lf('events.claim', { listen: start.listen, key: start.key })).toBe(false);
    expect(await store(teamB)('events.claim', { listen: start.listen, key: start.key, teamId: teamB })).toBe(true);
    expect(await lf('runs.list', { limit: 10 })).toEqual([expect.objectContaining({ id: runId, deliveryId: kept.id })]);
    expect(await lf('inbound.delivery', { id: kept.id })).toMatchObject({ runs: [{ id: runId, status: 'running' }] });

    const later = await newRun(teamA);
    await lf('runs.settle', { runId, status: 'failed', outcome: { error: 'first' }, at: past(2_000) });
    await lf('runs.settle', { runId: later, status: 'failed', outcome: { error: 'second' }, at: past(1_000) });
    await store(teamB)('runs.settle', { runId: await newRun(teamB), status: 'failed', outcome: { error: 'theirs' }, at: past(1_000) });
    const page = (await lf('runs.failed', { until: past(0), limit: 1 })) as { id: string }[];
    expect(page).toEqual([expect.objectContaining({ id: runId, status: 'failed' })]);
    const [last] = page;
    const failedAt = (await runRow(runId)).failed_at?.toISOString();
    expect(await lf('runs.failed', { after: { at: failedAt, runId: last?.id }, until: past(0), limit: 10 })).toEqual([expect.objectContaining({ id: later })]);
    expect(await lf('runs.failed', { until: past(1_500), limit: 10 })).toEqual([expect.objectContaining({ id: runId })]);
  });

  it('keeps a delivery with its request, arrivals, run waits and unjudged listens in one write, and completes its fire row by key', async () => {
    const lf = store(teamA);
    const runId = randomUUID();
    const fireKey = `fire_event:${randomUUID()}`;
    const kept = delivery(`x-${randomUUID()}`);
    const request = { method: 'POST', path: '/hooks/slack', query: '', headers: { 'content-type': 'application/json' }, body: 'e30=', arrivalIds: ['a1'] };
    const unjudged = { pipeline: 'listen:f:m', arrival: 'a1', file: 'f', movement: 'm', edge: 'Replies', reason: 'lookup failed', at: past(0) };
    const answer = (await lf('inbound.keepDelivery', {
      subscriptionId: 'slack',
      delivery: { ...kept, source: 'poll', request },
      work: [{ kind: 'fire_event', key: fireKey, payload: { deliveryId: kept.id }, dueAt: future(60_000), teamId: null }],
      arrivals: { teamId: teamA, adapterType: 'slack', arrivals: [{ edge: 'Replies', key: 'thread:1', identity: 'a1', version: null, landing: null, gone: false }], at: past(0), resendWindowMs: 60_000 },
      waits: [{ runId, edge: 'Replies', key: 'thread:1', fireKey, preNoted: { identity: 'a1', version: null } }],
      unjudged: [unjudged],
    })) as { kept: true; arrivalMark: number; wakes: unknown[] };
    expect(answer).toEqual({ kept: true, arrivalMark: expect.any(Number), wakes: [] });

    const fire = await getAutomationsQb(['work']).selectFrom('work').selectAll().where('key', '=', `lf:${teamA}:${fireKey}`).executeTakeFirstOrThrow();
    expect(fire.payload).toEqual({ deliveryId: kept.id, arrivalMark: answer.arrivalMark });
    expect(await lf('inbound.delivery', { id: kept.id })).toMatchObject({ source: 'poll', request });
    expect(await lf('unjudged.list', { limit: 10 })).toEqual([{ ...unjudged, deliveryId: null, recordId: null, cause: null, attempt: 0, at: expect.any(String) }]);
    const waitRows = await sql<{ fire_key: string }>`select fire_key from automations.wait_row where run_id = ${runId}::uuid`.execute(getAutomationsQb(['work']));
    expect(waitRows.rows).toEqual([{ fire_key: `lf:${teamA}:${fireKey}` }]);

    // Waits without arrivals are refused, writing nothing.
    const refused = await refusal(lf('inbound.keepDelivery', { subscriptionId: 'slack', delivery: delivery(null), work: [], waits: [{ runId, edge: 'Replies', key: 'thread:1', fireKey }] }));
    expect(refused.code).toBe('bad_request');

    // Its caller ran it: the row goes, and with it the wait of the run that never started.
    expect(await lf('work.completeKey', { key: fireKey })).toBe(true);
    expect(await lf('work.completeKey', { key: fireKey })).toBe(false);
    expect((await sql`select 1 from automations.wait_row where run_id = ${runId}::uuid`.execute(getAutomationsQb(['work']))).rows).toEqual([]);

    // The sweep forgets the request of every old delivery, kept or not.
    expect(await lf('inbound.sweepDeliveries', { before: future(1_000), limit: 0 })).toBe(0);
    const swept = (await lf('inbound.delivery', { id: kept.id })) as Record<string, unknown>;
    expect(swept).not.toHaveProperty('request');
  });

  it("keeps a listen's state: one resolve at a time, a pause apart from a resolve, and arrivals held while paused", async () => {
    const lf = store(teamA);
    const pipeline = 'listen:f:m';
    const claim = (await lf('listens.claimResolve', { pipeline, ttlMs: 60_000 })) as { token: string };
    expect(await lf('listens.claimResolve', { pipeline, ttlMs: 60_000 })).toBeNull();
    expect(await lf('listens.states', { pipelines: [pipeline, 'listen:other'] })).toEqual({
      [pipeline]: { heads: [], resolvedAt: null, failure: null, paused: null, held: 0 },
    });
    await lf('listens.hold', { pipeline });
    await lf('listens.setPaused', { pipeline, paused: 'LISTEN_LOOP: past 5' });
    await lf('listens.hold', { pipeline });
    await lf('listens.hold', { pipeline });
    const resolution = { heads: ['b1'], resolvedAt: past(0), failure: null, parents: { Tables: ['app1'] } };
    expect(await lf('listens.saveResolution', { pipeline, token: claim.token, resolution })).toBe(true);
    expect(await lf('listens.saveResolution', { pipeline, token: claim.token, resolution })).toBe(false);
    expect(await lf('listens.states', { pipelines: [pipeline] })).toEqual({ [pipeline]: { ...resolution, paused: 'LISTEN_LOOP: past 5', held: 2 } });
    await lf('listens.setPaused', { pipeline, paused: 'again' });
    expect(await lf('listens.states', { pipelines: [pipeline] })).toMatchObject({ [pipeline]: { paused: 'again', held: 2, heads: ['b1'] } });
    await lf('listens.setPaused', { pipeline, paused: null });
    expect(await lf('listens.states', { pipelines: [pipeline] })).toMatchObject({ [pipeline]: { paused: null, held: 0, heads: ['b1'] } });
    // A pause of a listen never resolved keeps a state of its own.
    await lf('listens.setPaused', { pipeline: 'listen:fresh', paused: 'p' });
    expect(await lf('listens.states', { pipelines: ['listen:fresh'] })).toEqual({ 'listen:fresh': { heads: [], resolvedAt: null, failure: null, paused: 'p', held: 0 } });
  });

  it('keeps the write ledger: the deepest write since an instant, a run keeping one write per record, the old forgotten', async () => {
    const lf = store(teamA);
    const record = { adapter: 'acme_crm', recordType: 'Company', externalId: 'company-1' };
    const write = (runId: string, depth: number, at: string, forgetBefore: string) => lf('writes.record', { ...record, runId, depth, at, forgetBefore });
    expect(await lf('writes.depth', { ...record, since: '2026-10-31T09:00:00.000Z' })).toBeNull();
    await write('r1', 0, '2026-10-31T10:00:00.000Z', '2026-10-31T09:00:00.000Z');
    await write('r2', 1, '2026-10-31T10:00:05.000Z', '2026-10-31T09:00:00.000Z');
    expect(await lf('writes.depth', { ...record, since: '2026-10-31T09:00:00.000Z' })).toEqual({ runId: 'r2', depth: 1 });
    expect((await refusal(write('r3', -1, '2026-10-31T10:00:06.000Z', '2026-10-31T09:00:00.000Z'))).code).toBe('bad_request');
    await write('r2', 1, '2026-10-31T10:00:20.000Z', '2026-10-31T09:00:00.000Z');
    expect(await lf('writes.depth', { ...record, since: '2026-10-31T10:00:10.000Z' })).toEqual({ runId: 'r2', depth: 1 });
    await write('r3', 0, '2026-10-31T10:01:00.000Z', '2026-10-31T10:00:30.000Z');
    expect(await lf('writes.depth', { ...record, since: '2026-10-31T09:00:00.000Z' })).toEqual({ runId: 'r3', depth: 0 });
  });

  it('keeps each release once and each unjudged arrival once per attempt, paging both oldest first', async () => {
    const lf = store(teamA);
    expect(await lf('releases.note', { version: '0.13.0', at: '2026-11-01T10:00:00.000Z' })).toBe(true);
    expect(await lf('releases.note', { version: '0.13.0', at: '2026-11-02T10:00:00.000Z' })).toBe(false);
    expect(await lf('releases.note', { version: '0.13.1', at: '2026-11-02T10:00:00.000Z' })).toBe(true);
    expect(await lf('releases.list', { limit: 1 })).toEqual([{ version: '0.13.0', at: '2026-11-01T10:00:00.000Z' }]);
    expect(await lf('releases.list', { after: { at: '2026-11-01T10:00:00.000Z', version: '0.13.0' }, limit: 10 })).toEqual([
      { version: '0.13.1', at: '2026-11-02T10:00:00.000Z' },
    ]);

    const fact = { pipeline: 'listen:f:m', arrival: 'a1', file: 'f', movement: 'm', deliveryId: null, edge: 'Replies', recordId: 'r1', reason: 'lookup failed', cause: null };
    const note = (at: string, attempt: number | undefined, forgetBefore: string) => lf('unjudged.note', { ...fact, at, ...(attempt !== undefined ? { attempt } : {}), forgetBefore });
    expect(await note('2026-11-01T10:00:00.000Z', undefined, '2026-10-01T00:00:00.000Z')).toBe(true);
    expect(await note('2026-11-01T10:00:01.000Z', 0, '2026-10-01T00:00:00.000Z')).toBe(false);
    expect(await note('2026-11-01T10:00:02.000Z', 1, '2026-10-01T00:00:00.000Z')).toBe(true);
    expect(await lf('unjudged.list', { limit: 10, pipeline: 'listen:other' })).toEqual([]);
    const [first] = (await lf('unjudged.list', { limit: 1 })) as { at: string; attempt: number }[];
    expect(first).toEqual({ ...fact, at: '2026-11-01T10:00:00.000Z', attempt: 0 });
    expect(await lf('unjudged.list', { after: { at: first?.at, pipeline: fact.pipeline, arrival: fact.arrival }, limit: 10 })).toEqual([
      { ...fact, at: '2026-11-01T10:00:02.000Z', attempt: 1 },
    ]);
    // Facts found before `forgetBefore` go in the same write.
    expect(await note('2026-11-02T10:00:00.000Z', 2, '2026-11-01T10:00:01.000Z')).toBe(true);
    expect(((await lf('unjudged.list', { limit: 10 })) as { attempt: number }[]).map((f) => f.attempt)).toEqual([1, 2]);
  });

  it('answers store.open with the tenant, and refuses an unknown method and a bad param', async () => {
    const lf = store(teamA);
    expect(await lf('store.open', { settings: {} })).toEqual({ tenant: teamA });
    expect((await refusal(lf('runs.nothing'))).code).toBe('method_not_implemented');
    const bad = await refusal(lf('runs.get', { runId: 7 }));
    expect({ code: bad.code, message: bad.message }).toEqual({ code: 'bad_request', message: expect.stringContaining('runs.get: runId') });
  });
});
