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
    const platformKeys = [shared, `wake_await:${randomUUID()}`, `fire_callback:${randomUUID()}`];
    const kinds = ['resume_timer', 'wake_await', 'fire_callback'] as const;
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

    expect(await keep(a)).toEqual({ kept: true });
    expect(await keep(b)).toEqual({ kept: true });
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
    await a('correlations.correlate', { runId, teamId: teamA, address: 's0', adapterType: 'slack', correlationKey: 'k' });
    const { id: callbackId } = (await a('callbacks.mint', { teamId: teamA, runId, address: 'cb0', params: [], state: {}, singleUse: true })) as { id: string };
    await a('work.enqueue', { kind: 'wake_await', key: `wake_await:${randomUUID()}`, payload: {}, dueAt: past(1_000) });
    await a('inbound.keepDelivery', { subscriptionId: 'acme_crm', delivery: delivery(`x-${randomUUID()}`), work: [] });
    await a('sources.put', { teamId: teamA, hash: 'sha256:abc', source: 'text' });
    const bRun = await newRun(teamB);

    expect(await b('runs.get', { runId })).toBeNull();
    expect(await b('runs.list', { limit: 10 })).toEqual([expect.objectContaining({ id: bRun })]);
    expect(await b('runs.status', { runId })).toBe('missing');
    expect(await b('parks.leaves', { runId })).toEqual([]);
    expect(await b('parks.claimLeaf', { runId, address: 's0' })).toBeNull();
    expect(await b('leases.claim', { runId, ttlMs: 60_000 })).toBeNull();
    expect(await b('callbacks.get', { id: callbackId })).toBeNull();
    expect(await b('callbacks.record', { id: callbackId, values: {}, bodyDueAt: future(0) })).toEqual({ kind: 'not_found' });
    expect(await b('work.claimDue', { limit: 100, leaseMs: 60_000 })).toEqual([]);
    expect(await b('inbound.deliveries', { limit: 10 })).toEqual([]);
    expect(await b('correlations.correlated', { adapterType: 'slack', teamId: teamA, correlationKey: 'k' })).toEqual([]);
    expect(await b('correlations.correlated', { adapterType: 'slack', teamId: teamB, correlationKey: 'k' })).toEqual([]);
    expect(await b('correlations.ofRun', { runId, adapterType: 'slack' })).toEqual([]);
    expect(await b('sources.get', { teamId: teamA, hash: 'sha256:abc' })).toBeNull();

    // A write naming A's team is refused, whichever run it is on.
    for (const [method, params] of [
      ['correlations.correlate', { runId: bRun, teamId: teamA, address: 's0', adapterType: 'slack', correlationKey: 'k' }],
      ['callbacks.mint', { teamId: teamA, runId: bRun, address: 'cb0', params: [], state: {}, singleUse: true }],
      ['sources.put', { teamId: teamA, hash: 'sha256:abc', source: 'text' }],
      ['work.enqueue', { kind: 'wake_await', key: `wake_await:${randomUUID()}`, payload: {}, teamId: teamA }],
      ['parks.commit', { runId: bRun, address: 's0', state: {}, park: { kind: 'await', teamId: teamA, adapterType: 'slack', correlationKey: 'k' } }],
    ] as const) {
      const refused = await refusal(b(method, params));
      expect({ method, code: refused.code, message: refused.message }).toEqual({ method, code: 'bad_request', message: expect.stringContaining("another tenant's") });
    }
    // A write on A's run under B's key lands nowhere.
    expect((await refusal(b('callbacks.mint', { teamId: teamB, runId, address: 'cb1', params: [], state: {}, singleUse: true }))).code).toBe('bad_request');
    await expect(b('parks.putLeaf', { runId, address: 's1', reason: 'await', state: {}, fence: null })).rejects.toThrow('has no trigger_run row');
    await b('runs.settle', { runId, status: 'failed', outcome: { error: 'not yours' }, at: new Date().toISOString() });
    await b('records.markFailed', { runId, message: 'not yours' });
    await b('callbacks.revokeRun', { runId });
    expect(await a('runs.get', { runId })).toMatchObject({ status: 'running' });
    expect(await a('callbacks.get', { id: callbackId })).toMatchObject({ status: 'live' });
    expect(await a('parks.leaves', { runId })).toEqual([expect.objectContaining({ address: 's0' })]);
  });

  it('keeps a park whole: a commit whose correlation fails leaves no leaf and the run not parked', async () => {
    const lf = store(teamA);
    const runId = await newRun(teamA);
    const lease = (await lf('leases.claim', { runId, ttlMs: 60_000 })) as { token: string };
    const constraint = `lf_store_test_${randomUUID().slice(0, 8)}`;
    const db = getAutomationsQb(['adapter_await']);
    await sql`alter table automations.adapter_await add constraint ${sql.ref(constraint)} check (adapter_type <> 'explodes') not valid`.execute(db);
    try {
      const park = { kind: 'await', teamId: teamA, adapterType: 'explodes', correlationKey: 'k' };
      await expect(lf('parks.commit', { runId, address: 's0', state: {}, fence: lease.token, park })).rejects.toThrow(constraint);
    } finally {
      await sql`alter table automations.adapter_await drop constraint ${sql.ref(constraint)}`.execute(db);
    }

    expect(await lf('parks.leaves', { runId })).toEqual([]);
    expect((await runRow(runId)).status).toBe('running');

    // The same park, uncorrupted, commits whole; a lost fence writes nothing.
    await lf('parks.commit', { runId, address: 's0', state: {}, fence: lease.token, park: { kind: 'timer', wakeAt: future(60_000) } });
    expect((await runRow(runId)).status).toBe('parked');
    const timer = await getAutomationsQb(['work']).selectFrom('work').selectAll().where('host', '=', 'lf').where('key', '=', `resume_timer:${runId}`).executeTakeFirst();
    expect(timer).toMatchObject({ team_id: teamA, kind: 'resume_timer', payload: { runId } });
    const lost = await refusal(lf('parks.commit', { runId, address: 's1', state: {}, fence: randomUUID(), park: { kind: 'limit' } }));
    expect({ code: lost.code, data: lost.data }).toEqual({ code: 'run_lease_lost', data: { runId } });
    expect(((await lf('parks.leaves', { runId })) as { address: string }[]).map((leaf) => leaf.address)).toEqual(['s0']);
  });

  it('keeps a duplicate delivery out whole: no cursor and no rows', async () => {
    const lf = store(teamA);
    const externalId = `x-${randomUUID()}`;
    const first = { kind: 'fire_event', key: `fire_event:${randomUUID()}`, payload: { n: 1 }, dueAt: future(60_000), teamId: null };
    const second = { ...first, key: `fire_event:${randomUUID()}` };
    const again = delivery(externalId);

    expect(await lf('inbound.keepDelivery', { subscriptionId: 'acme_crm', checkpoint: 'c1', delivery: delivery(externalId), work: [first] })).toEqual({ kept: true });
    expect(await lf('inbound.keepDelivery', { subscriptionId: 'acme_crm', checkpoint: 'c2', delivery: again, work: [second] })).toEqual({ kept: false });

    expect(await lf('inbound.checkpoint', { subscriptionId: 'acme_crm' })).toEqual({ checkpoint: 'c1' });
    const keys = (await getAutomationsQb(['work']).selectFrom('work').select('key').where('team_id', '=', teamA).execute()).map((row) => row.key);
    expect(keys).toEqual([first.key]);
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
      'not a work kind: dispatch_event (the kinds: resume_timer, wake_await, fire_event, fire_callback, poll_listen)',
    );
    await expect(lf('work.enqueue', { kind: 'dispatch_event', key: 'k', payload: {} })).rejects.toThrow('not a work kind: dispatch_event');
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

  it('starts an event\'s run once, records a callback call with its body\'s row, and revokes on settle', async () => {
    const lf = store(teamA);
    const runId = randomUUID();
    const kept = delivery(null);
    await lf('inbound.keepDelivery', { subscriptionId: 's', delivery: kept, work: [] });
    const start = { listen: 'listen:welcome.lf:greet', key: 'evt-1', id: runId, file: 'welcome.lf', movement: 'greet', startedAt: new Date().toISOString(), input: '{}', deliveryId: kept.id };
    expect(await lf('events.startRun', start)).toBe(true);
    expect(await lf('events.startRun', { ...start, id: randomUUID() })).toBe(false);
    expect(await lf('runs.list', { limit: 10 })).toEqual([expect.objectContaining({ id: runId, deliveryId: kept.id })]);
    expect(await lf('inbound.delivery', { id: kept.id })).toMatchObject({ runs: [{ id: runId, status: 'running' }] });

    const { id } = (await lf('callbacks.mint', { teamId: teamA, runId, address: 'cb0', params: [], state: { s: 1 }, singleUse: true, expiresAt: null })) as { id: string };
    expect(id).toMatch(/^cb_/);
    expect(await lf('callbacks.record', { id, values: { ok: true }, bodyDueAt: past(0) })).toMatchObject({
      kind: 'recorded',
      callIndex: 0,
      callback: { id, teamId: teamA, runId, status: 'fired', state: { s: 1 } },
    });
    expect(await lf('callbacks.record', { id, values: {}, bodyDueAt: past(0) })).toMatchObject({ kind: 'closed' });
    const [body] = (await lf('work.claimDue', { limit: 10, leaseMs: 60_000, kinds: ['fire_callback'] })) as { key: string; payload: unknown }[];
    expect(body).toMatchObject({ key: `fire_callback:${id}:0`, payload: { callbackId: id, teamId: teamA, callIndex: 0 } });
    expect(await lf('callbacks.markBodyStarted', { id, callIndex: 0 })).toBe(true);
    expect(await lf('callbacks.landed', { ids: [id, 'cb_none', 'x'] })).toEqual([id]);

    const { id: live } = (await lf('callbacks.mint', { teamId: teamA, runId, address: 'cb1', params: [], state: {}, singleUse: false })) as { id: string };
    await lf('runs.settle', { runId, status: 'completed', outcome: { writes: 0 }, at: new Date().toISOString() });
    expect(await lf('callbacks.get', { id: live })).toMatchObject({ status: 'revoked' });
    expect(await lf('callbacks.get', { id })).toMatchObject({ status: 'fired' });
  });

  it('answers store.open with the tenant, and refuses an unknown method and a bad param', async () => {
    const lf = store(teamA);
    expect(await lf('store.open', { settings: {} })).toEqual({ tenant: teamA });
    expect((await refusal(lf('runs.nothing'))).code).toBe('method_not_implemented');
    const bad = await refusal(lf('runs.get', { runId: 7 }));
    expect({ code: bad.code, message: bad.message }).toEqual({ code: 'bad_request', message: expect.stringContaining('runs.get: runId') });
  });
});
