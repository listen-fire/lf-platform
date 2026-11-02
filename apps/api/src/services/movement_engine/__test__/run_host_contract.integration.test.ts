// The run host's contract suites (movement-engine run_host/contract.ts and
// engine-contracts' conformance/store-waits.json) against the hosted Postgres
// backend: the same cases listen-fire's own stores are held to. Every case's
// runs are fresh trigger_run rows of one throwaway team; their live state goes
// with them, and the arrivals, waits and rows the waits cases log under their
// own fresh teams are cleared after.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import {
  cancelContractCases,
  runHostContractCases,
  storeWaitsCases,
  type RecordsContractBackend,
  type StoreWaitsBackend,
} from 'movement-engine/public/testing';

import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb } from '../../../lib/kysely';
import { registerWorkKinds, resetWorkHandlersForTests } from '../../work/drain';
import { hostedRunHost } from '../run_host';
import { platformDeliveryRows, postgresRunHostStore, triggerRunIdOf } from '../run_host_store';

const TEAM_ID = randomUUID();
const runs: TriggerRunId[] = [];
/** The teams the waits cases logged and queued under. */
const waitTeams = new Set<string>();

async function newRun(): Promise<string> {
  const row = await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    .values({ team_id: TEAM_ID, trigger_id: `run-host-contract-${randomUUID()}`, trigger_type: 'webhook', status: 'parked' })
    .returning('id')
    .executeTakeFirstOrThrow();
  runs.push(row.id);
  return row.id;
}

const backend: RecordsContractBackend = {
  store: postgresRunHostStore,
  runs: hostedRunHost().runs,
  teamId: TEAM_ID,
  newRun,
  async requestCancel({ runId, reason }) {
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ cancel_requested_at: sql`now()`, cancel_reason: reason })
      .where('id', '=', triggerRunIdOf(runId))
      .execute();
  },
  async runStatus(runId) {
    const row = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', triggerRunIdOf(runId))
      .select('status')
      .executeTakeFirstOrThrow();
    return row.status;
  },
  async completeRun(runId) {
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ status: 'success' })
      .where('id', '=', triggerRunIdOf(runId))
      .execute();
  },
};

const deliveries = platformDeliveryRows(TEAM_ID);

/** The store as the waits cases reach it, noting each team they log under. */
const waitsBackend: StoreWaitsBackend = {
  store: {
    ...postgresRunHostStore,
    waits: {
      ...postgresRunHostStore.waits,
      log: (input) => {
        waitTeams.add(input.teamId);
        return postgresRunHostStore.waits.log(input);
      },
    },
  },
  runRows: {
    async startRun({ runId }) {
      await getAutomationsQb(['trigger_run'])
        .insertInto('trigger_run')
        .values({ id: triggerRunIdOf(runId), team_id: TEAM_ID, trigger_id: `store-waits-${runId}`, trigger_type: 'webhook', status: 'running' })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      runs.push(triggerRunIdOf(runId));
    },
    async runStatus({ runId }) {
      const row = await getAutomationsQb(['trigger_run'])
        .selectFrom('trigger_run')
        .where('id', '=', triggerRunIdOf(runId))
        .select('status')
        .executeTakeFirst();
      // The hosted product names a completed run `success`.
      return row === undefined ? null : row.status === 'success' ? 'completed' : row.status;
    },
  },
  deliveries: {
    ...deliveries,
    keepDelivery: (input) => {
      if (input.arrivals !== undefined) waitTeams.add(input.arrivals.teamId);
      for (const row of input.work) if (row.teamId != null) waitTeams.add(row.teamId);
      return deliveries.keepDelivery(input);
    },
  },
};

beforeAll(() => {
  // A kept delivery's rows and a race's are claimed by the process that
  // registers their kind; these cases claim them by name and never drain them.
  const claimedByTheCase = {
    run: () => Promise.reject(new Error('a contract case claims this row itself; nothing drains it')),
  };
  registerWorkKinds([
    { kind: 'fire_event', handler: claimedByTheCase },
    { kind: 'settle_race', handler: claimedByTheCase },
  ]);
});

afterAll(async () => {
  resetWorkHandlersForTests();
  await clearEarlierCases();
  const db = getAutomationsQb(['trigger_run']);
  await sql`delete from automations.delivery where team_id = ${TEAM_ID}::uuid`.execute(db);
  await sql`delete from automations.inbound_checkpoint where team_id = ${TEAM_ID}::uuid`.execute(db);
  if (runs.length === 0) return;
  await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('id', 'in', runs).execute();
});

// This case arms and claims an lf polled listen's row (kind `poll_edge`). The
// platform's run host never holds one: the platform polls through its own
// `poll_source` rows, and lf's rows go through the store module, whose contract
// (lf_store/store_contract) runs this case. The conditional insert itself is
// held by work/__test__/store.integration.
const LF_POLLED_LISTEN_CASE = 'work: a key queued if absent is queued once; a row there, due later or leased, is left as it was';

describe('the run host contract on Postgres', () => {
  it('names the one case it leaves to the store module', () => {
    expect(runHostContractCases.map((c) => c.name)).toContain(LF_POLLED_LISTEN_CASE);
  });

  for (const contractCase of runHostContractCases) {
    if (contractCase.name === LF_POLLED_LISTEN_CASE) continue;
    it(contractCase.name, () => contractCase.run(backend));
  }
});

describe('the cancel contract on Postgres', () => {
  for (const contractCase of cancelContractCases) {
    it(contractCase.name, () => contractCase.run(backend));
  }
});

/** What the cases before left behind: their arrivals, waits, queued rows and
 *  unexpired leases. The arrival log, its sweep floor and a wake claim are
 *  store-wide, and each waits case reads them as a fresh store's. */
async function clearEarlierCases(): Promise<void> {
  const db = getAutomationsQb(['trigger_run']);
  const teams = [...waitTeams, TEAM_ID];
  await sql`delete from automations.work where team_id = any(${teams}::uuid[])`.execute(db);
  await sql`delete from automations.wait_row where team_id = any(${teams}::uuid[])`.execute(db);
  await sql`delete from automations.arrival where team_id = any(${teams}::uuid[])`.execute(db);
  await sql`delete from automations.arrival_identity where team_id = any(${teams}::uuid[])`.execute(db);
  if (runs.length > 0) {
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ lease_owner: null, lease_until: null, lease_token: null })
      .where('id', 'in', runs)
      .execute();
  }
}

describe("the store's waits cases on Postgres", () => {
  beforeEach(clearEarlierCases);

  for (const waitsCase of storeWaitsCases()) {
    it(waitsCase.name, () => waitsCase.run(waitsBackend));
  }
});
