// The loop breaker against a real database: each record write a run sends is
// kept in the write ledger at the run's place in its chain, and an arrival on
// a record a run wrote within the loop window continues that run's chain.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { Arrival } from 'engine-contracts';
import type { AdapterCall, AdapterCallAnswer, AdapterMethod, HostAdapters, ResolvedAdapter } from 'movement-engine/public/host';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { SavedListen } from '../listen_door';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { DbCancelGate } from '../../movement_engine/cancel_gate';

import { arrivalReceiptKey } from 'movement-engine/public/inbound';

import { getAutomationsQb } from '../../../lib/kysely';
import { claimReceipt, type FireRow } from '../listen_door';
import { chainBefore, ledgeredAdapters, loopLine } from '../loop_breaker';
import { runPlatformFor } from '../../translation_graph/movement/carried_run';

const SETTINGS = { windowMs: 20_000, depth: 10 };
const PIPELINE = 'listen:sync.lf:stamp:0a1b2c3d';

let teamId: TeamId;

beforeEach(() => {
  teamId = randomUUID() as TeamId;
});

afterEach(async () => {
  await sql`delete from automations.event_receipt where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['event_receipt']));
  await sql`delete from automations.trigger_run where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['trigger_run']));
  await sql`delete from automations.write_ledger where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['write_ledger']));
});

/** A queued run of the listen, its chain on its row. */
async function queuedRun(chain: string[]): Promise<string> {
  const arrival: Exclude<Arrival, { gone: true }> = {
    edge: 'Changes',
    key: 'company-1',
    identity: randomUUID(),
    landing: { recordId: randomUUID(), recordType: 'CompanyChange', fields: {} },
  };
  const fire: FireRow = {
    teamId,
    triggerId: randomUUID(),
    pipeline: PIPELINE,
    arrival,
    runId: randomUUID(),
    receipt: arrivalReceiptKey(arrival),
    deliveryId: randomUUID(),
  };
  await claimReceipt({ fire, run: { triggerType: 'webhook', recordId: null, payload: {}, movementVersionId: null }, chain });
  return fire.runId;
}

/** A host's adapters whose one instance answers every write as written. */
function fakeAdapters(): HostAdapters & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async resolve(resolution): Promise<ResolvedAdapter> {
      return {
        instance: resolution.dryRun === true ? 'rehearsed' : 'live',
        adapterType: 'attio',
        supportedTriggers: [],
        capabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
        methods: ['createRecord', 'updateRecord', 'readRecord'],
      };
    },
    async call<M extends AdapterMethod>(call: AdapterCall<M>): Promise<AdapterCallAnswer<M>> {
      sent.push(call.method);
      const named = 'externalId' in call.args && typeof call.args.externalId === 'string' ? call.args.externalId : undefined;
      if (named === 'gone') return { result: { notFound: true } } as AdapterCallAnswer<M>;
      return { result: { adapterType: 'attio', externalId: named ?? 'company-new' } } as AdapterCallAnswer<M>;
    },
  };
}

async function ledger(): Promise<Array<{ external_id: string; run_id: string; depth: number }>> {
  const { rows } = await sql<{ external_id: string; run_id: string; depth: number }>`
    select external_id, run_id, depth from automations.write_ledger where team_id = ${teamId}::uuid order by at, external_id`.execute(
    getAutomationsQb(['write_ledger']),
  );
  return rows;
}

describe('ledgeredAdapters: the writes a run sends', () => {
  it("keeps each create, update and delete at the run's depth, and nothing a rehearsal or a read sends", async () => {
    const runId = await queuedRun(['run-a', 'run-b']);
    const host = ledgeredAdapters(fakeAdapters(), { teamId, runId, settings: SETTINGS });
    const live = await host.resolve({ segmentId: 's1', adapterType: 'attio', role: 'target' });
    const rehearsed = await host.resolve({ segmentId: 's1', adapterType: 'attio', role: 'target', dryRun: true });
    const call = (instance: string, method: AdapterMethod, args: Record<string, unknown>) =>
      host.call({ segmentId: 's1', instance, method, args } as AdapterCall);
    await call(live.instance, 'createRecord', { recordType: 'Companies', fields: {} });
    await call(live.instance, 'updateRecord', { recordType: 'Companies', externalId: 'company-1', fields: {} });
    await call(live.instance, 'updateRecord', { recordType: 'Companies', externalId: 'gone', fields: {} });
    await call(live.instance, 'readRecord', { recordType: 'Companies', externalId: 'company-2' });
    await call(rehearsed.instance, 'updateRecord', { recordType: 'Companies', externalId: 'company-3', fields: {} });
    expect(await ledger()).toEqual([
      { external_id: 'company-new', run_id: runId, depth: 2 },
      { external_id: 'company-1', run_id: runId, depth: 2 },
    ]);
  });
});

describe('chainBefore: the chain the run an arrival fires continues', () => {
  const listen = { plan: { movement: 'stamp', connection: 'crm', adapter: 'attio', hops: [{ edge: 'Changes', from: 'Companies', to: 'CompanyChange', judged: 'arrival' }] } } as unknown as SavedListen;
  const echo = (occurredAt?: string): Exclude<Arrival, { gone: true }> => ({
    edge: 'Changes',
    key: 'company-1',
    identity: randomUUID(),
    landing: { recordId: randomUUID(), recordType: 'CompanyChange', fields: {} },
    about: { recordType: 'Companies', externalId: 'company-1' },
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  });

  async function wrote(runId: string, depth: number, at: Date): Promise<void> {
    await sql`
      insert into automations.write_ledger (team_id, adapter, record_type, external_id, run_id, depth, at)
      values (${teamId}::uuid, 'attio', 'Companies', 'company-1', ${runId}::text, ${depth}::int4, ${at.toISOString()}::timestamptz)`.execute(
      getAutomationsQb(['write_ledger']),
    );
  }

  it("an arrival about a record a run wrote within the window continues that run's chain", async () => {
    const now = new Date();
    const first = await queuedRun([]);
    const second = await queuedRun([first]);
    await wrote(first, 0, new Date(now.getTime() - 5_000));
    await wrote(second, 1, new Date(now.getTime() - 2_000));
    expect(await chainBefore({ teamId, listen, arrival: echo(), now, settings: SETTINGS })).toEqual([first, second]);
  });

  it('a write before the window, measured from when the arrival happened, caused nothing', async () => {
    const now = new Date();
    const first = await queuedRun([]);
    await wrote(first, 0, new Date(now.getTime() - 30_000));
    expect(await chainBefore({ teamId, listen, arrival: echo(), now, settings: SETTINGS })).toEqual([]);
    // Found by a poll a minute after it happened, just after the write.
    const happened = new Date(now.getTime() - 25_000).toISOString();
    expect(await chainBefore({ teamId, listen, arrival: echo(happened), now, settings: SETTINGS })).toEqual([first]);
  });

  it("a cloud listen-fire run's chain is read from its facts", async () => {
    const now = new Date();
    const lfRun = randomUUID();
    await sql`
      insert into automations.trigger_run (id, team_id, host, trigger_id, trigger_type, status, started_at, trigger_payload)
      values (${lfRun}::uuid, ${teamId}::uuid, 'lf', 'listen:sync:stamp', 'webhook', 'success', now(),
              jsonb_build_object('file', 'sync', 'movement', 'stamp', 'facts', ${JSON.stringify({ chain: ['run-0'] })}::text))`.execute(
      getAutomationsQb(['trigger_run']),
    );
    await wrote(lfRun, 1, new Date(now.getTime() - 1_000));
    expect(await chainBefore({ teamId, listen, arrival: echo(), now, settings: SETTINGS })).toEqual(['run-0', lfRun]);
  });

  it("a write a carried version's run sent is found too: it enters the one ledger, under that run", async () => {
    const now = new Date();
    const carriedRun = await queuedRun([]);
    const platform = runPlatformFor({ teamId, triggerRunId: carriedRun as TriggerRunId, cancel: { cancelled: async () => false, cancelledNow: async () => false, reason: () => null } as unknown as DbCancelGate });
    await platform.keepWrite?.({ adapterType: 'attio', recordType: 'Companies', externalId: 'company-1', at: new Date(now.getTime() - 1_000).toISOString() });
    expect(await ledger()).toEqual([{ external_id: 'company-1', run_id: carriedRun, depth: 0 }]);
    expect(await chainBefore({ teamId, listen, arrival: echo(), now, settings: SETTINGS })).toEqual([carriedRun]);
  });

  it('names the listen and the chain it pauses', () => {
    expect(loopLine('sync.lf:stamp', ['r1', 'r2'])).toBe(
      'LISTEN_LOOP: sync.lf:stamp is paused: this arrival would start run 3 of a chain of writes and arrivals (r1, r2); resume the automation once the loop is broken',
    );
  });
});
