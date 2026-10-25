// The run host's contract suite (movement-engine run_host/contract.ts) against
// the hosted Postgres backend: the same cases lf's SQLite backend is held to.
// Every case's runs are fresh trigger_run rows of one throwaway team; their
// live state goes with them.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import {
  callbackContractCases,
  cancelContractCases,
  runHostContractCases,
  type RecordsContractBackend,
} from 'movement-engine/public/testing';

import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb } from '../../../lib/kysely';
import { postgresCallbackStore } from '../callback_store';
import { hostedRunHost } from '../run_host';
import { postgresRunHostStore, triggerRunIdOf } from '../run_host_store';

const TEAM_ID = randomUUID();
const runs: TriggerRunId[] = [];

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
  callbacks: postgresCallbackStore,
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

afterAll(async () => {
  if (runs.length === 0) return;
  await getAutomationsQb(['callback']).deleteFrom('callback').where('run_id', 'in', runs).execute();
  await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('id', 'in', runs).execute();
});

// This case arms and claims an lf polled listen's row (kind `poll_listen`). The
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

describe('the callback and cancel contract on Postgres', () => {
  for (const contractCase of [...callbackContractCases, ...cancelContractCases]) {
    it(contractCase.name, () => contractCase.run(backend));
  }
});
