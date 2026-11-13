// The door's writes, against a real database: a judged delivery kept in one
// write (its `fire_event` rows and its unjudged facts with it), and the run a
// `fire_event` row starts claimed under its listen's receipt, which is what
// keeps a redelivery, or a drain taking the row again, from starting a run
// twice.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { arrivalReceiptKey } from 'movement-engine/public/inbound';

import { getAutomationsQb } from '../../../lib/kysely';
import { recordWrite } from '../../lf_store/listens';
import { claimReceipt, keepJudgedDelivery, type FireRow, type SavedListen, type Undecided } from '../listen_door';

const PIPELINE = 'listen:polls.lf:tally:0a1b2c3d';
const RUN = { triggerType: 'webhook', recordId: 't1', payload: { pressed: 't1' }, movementVersionId: null };

let teamId: TeamId;

beforeEach(() => {
  teamId = randomUUID() as TeamId;
});

afterEach(async () => {
  await sql`delete from automations.event_receipt where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['event_receipt']));
  await sql`delete from automations.trigger_run where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['trigger_run']));
  await sql`delete from automations.work where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['work']));
  await sql`delete from automations.arrival_unjudged where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['arrival_unjudged']));
  await sql`delete from automations.arrival where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['arrival']));
  await sql`delete from automations.arrival_identity where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['arrival_identity']));
  await sql`delete from automations.delivery where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['delivery']));
  await sql`delete from automations.write_ledger where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['write_ledger']));
});

const ARRIVAL: Exclude<Arrival, { gone: true }> = {
  edge: 'Interactions',
  key: 'poll-1',
  identity: 'press-1',
  landing: { recordId: 't1', recordType: 'Interaction', fields: { Id: 't1' } },
};
const RECEIPT = arrivalReceiptKey(ARRIVAL);

function fire(overrides: Partial<FireRow> = {}): FireRow {
  return {
    teamId,
    triggerId: randomUUID(),
    pipeline: PIPELINE,
    arrival: ARRIVAL,
    runId: randomUUID(),
    receipt: RECEIPT,
    deliveryId: randomUUID(),
    ...overrides,
  };
}

async function runRow(runId: string): Promise<{ status: string; last_heartbeat_at: Date | null; record_id: string | null } | undefined> {
  return getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId as TriggerRunId)
    .select(['status', 'last_heartbeat_at', 'record_id'])
    .executeTakeFirst();
}

describe('claimReceipt: the run a fire_event row starts', () => {
  it('the first run of an arrival by a listen takes the receipt and is written queued', async () => {
    const first = fire();

    expect(await claimReceipt({ fire: first, run: RUN, chain: [] })).toEqual({ kind: 'run' });

    expect(await runRow(first.runId)).toEqual({ status: 'running', last_heartbeat_at: null, record_id: 't1' });
  });

  it('a row taken again before its run started runs it; once started, it is in hand', async () => {
    const first = fire();
    await claimReceipt({ fire: first, run: RUN, chain: [] });

    expect(await claimReceipt({ fire: first, run: RUN, chain: [] })).toEqual({ kind: 'run' });

    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ last_heartbeat_at: new Date() })
      .where('id', '=', first.runId as TriggerRunId)
      .execute();
    expect(await claimReceipt({ fire: first, run: RUN, chain: [] })).toEqual({ kind: 'in_hand' });
  });

  it('another run of the same arrival by the same listen ran before, and writes no run', async () => {
    await claimReceipt({ fire: fire(), run: RUN, chain: [] });
    const again = fire();

    expect(await claimReceipt({ fire: again, run: RUN, chain: [] })).toEqual({ kind: 'ran_before' });
    expect(await runRow(again.runId)).toBeUndefined();
  });

  it('another listen hearing the same arrival runs under its own receipt', async () => {
    await claimReceipt({ fire: fire(), run: RUN, chain: [] });

    expect(await claimReceipt({ fire: fire({ pipeline: 'listen:polls.lf:count:9f8e7d6c' }), run: RUN, chain: [] })).toEqual({ kind: 'run' });
  });

  it('a forced replay runs past the listen`s receipt, under one of its own', async () => {
    await claimReceipt({ fire: fire(), run: RUN, chain: [] });
    const forced = fire({ forced: true });

    expect(await claimReceipt({ fire: forced, run: RUN, chain: [] })).toEqual({ kind: 'run' });
    expect(await claimReceipt({ fire: fire({ forced: true }), run: RUN, chain: [] })).toEqual({ kind: 'run' });
  });
});

describe('keepJudgedDelivery: a judged delivery in one write', () => {
  function listen(): SavedListen {
    return {
      pipeline: PIPELINE,
      plan: { adapter: 'chat', connection: 'chat', movement: 'tally', carries: [], hops: [] } as unknown as SavedListen['plan'],
      awaits: { own: [], carried: {} },
      fieldIds: {},
      triggerId: randomUUID() as TriggerId,
      teamId,
      file: 'polls.lf',
      credentialsId: null,
    };
  }

  it('keeps a fire_event row per minted run, due at once, and each unjudged fact with the delivery', async () => {
    const saved = listen();
    const runId = randomUUID() as TriggerRunId;
    const now = new Date();

    const { kept, deliveryId, fires } = await keepJudgedDelivery({
      teamId,
      subscriptionId: 'sub-1',
      adapterType: 'chat',
      externalId: 'ext-1',
      source: 'webhook',
      arrivals: [ARRIVAL],
      judged: {
        minted: [{ listen: saved, arrival: ARRIVAL, index: 0, runId, receipt: RECEIPT }],
        unjudged: [
          {
            listen: saved,
            arrival: ARRIVAL,
            fact: {
              pipeline: 'listen:polls.lf:count:9f8e7d6c',
              arrival: RECEIPT,
              file: 'polls.lf',
              movement: 'count',
              edge: 'Interactions',
              adapter: 'chat',
              recordId: 't1',
              landing: ARRIVAL.landing,
              reason: 'the arrival carries no Messages record',
              at: now.toISOString(),
              attempt: 0,
            },
          },
        ],
        lines: [],
      },
      now,
    });

    expect(kept.kept).toBe(true);
    expect(fires).toEqual([
      { teamId, triggerId: saved.triggerId, pipeline: PIPELINE, arrival: ARRIVAL, runId, receipt: RECEIPT, deliveryId },
    ]);
    const work = await getAutomationsQb(['work'])
      .selectFrom('work')
      .where('team_id', '=', teamId)
      .select(['kind', 'key', 'payload', 'due_at'])
      .execute();
    expect(work).toEqual([
      { kind: 'fire_event', key: `fire_event:${runId}`, payload: expect.objectContaining({ runId, deliveryId }), due_at: expect.any(Date) },
    ]);
    expect(work[0]!.due_at.getTime()).toBeLessThanOrEqual(Date.now());
    const facts = await sql<{ pipeline: string; adapter: string | null; landing: unknown; delivery_id: string }>`
      select pipeline, adapter, landing, delivery_id::text from automations.arrival_unjudged where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['arrival_unjudged']));
    expect(facts.rows).toEqual([{ pipeline: 'listen:polls.lf:count:9f8e7d6c', adapter: 'chat', landing: ARRIVAL.landing, delivery_id: deliveryId }]);
  });

  it('an arrival a listen could not judge names the run whose write of its record caused it', async () => {
    const saved = listen();
    const writer = fire();
    await claimReceipt({ fire: writer, run: RUN, chain: [] });
    const now = new Date();
    await recordWrite(
      { tenant: teamId },
      { adapter: 'chat', recordType: 'Interaction', externalId: 't1', runId: writer.runId, depth: 0, at: new Date(now.getTime() - 1000).toISOString(), forgetBefore: new Date(now.getTime() - 60_000).toISOString() },
    );
    const undecided = (arrival: Exclude<Arrival, { gone: true }>): Undecided => ({
      listen: saved,
      arrival,
      fact: { pipeline: PIPELINE, arrival: arrivalReceiptKey(arrival), file: 'polls.lf', movement: 'tally', edge: 'Interactions', adapter: 'chat', recordId: arrival.landing.recordId ?? null, landing: arrival.landing, reason: 'a lookup failed', at: now.toISOString(), attempt: 0 },
    });
    const elsewhere: Exclude<Arrival, { gone: true }> = { ...ARRIVAL, identity: 'press-2', landing: { recordId: 't2', recordType: 'Interaction', fields: { Id: 't2' } } };

    await keepJudgedDelivery({
      teamId,
      subscriptionId: 'sub-1',
      adapterType: 'chat',
      externalId: 'ext-3',
      source: 'webhook',
      arrivals: [ARRIVAL, elsewhere],
      judged: { minted: [], unjudged: [undecided(ARRIVAL), undecided(elsewhere)], lines: [] },
      now,
    });

    const facts = await sql<{ record_id: string; cause: string | null }>`
      select record_id, cause from automations.arrival_unjudged where team_id = ${teamId}::uuid order by record_id`.execute(getAutomationsQb(['arrival_unjudged']));
    expect(facts.rows).toEqual([
      { record_id: 't1', cause: writer.runId },
      { record_id: 't2', cause: null },
    ]);
  });

  it('a redelivery under the same external id keeps nothing more', async () => {
    const judged = { minted: [], unjudged: [], lines: [] };
    const input = { teamId, subscriptionId: 'sub-1', adapterType: 'chat', externalId: 'ext-2', source: 'webhook' as const, arrivals: [ARRIVAL], judged };

    expect((await keepJudgedDelivery({ ...input, now: new Date() })).kept.kept).toBe(true);
    expect((await keepJudgedDelivery({ ...input, now: new Date() })).kept.kept).toBe(false);
  });
});
