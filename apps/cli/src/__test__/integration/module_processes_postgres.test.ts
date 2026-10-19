// The module process list in the Postgres store (@lf/postgres-store's
// lf.module_processes, its fourth migration): written by compare-and-set on
// its version, one list per tenant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { RpcStoreBackend } from 'movement-engine/services/run_host/rpc_store';
import { lfBinary } from '../lf_bin';
import { freshTeam, POSTGRES_URL } from './pg';

const List = z.object({ processes: z.array(z.unknown()), version: z.number() });

test('the list is written only over the version it was read at, per tenant', async () => {
  const [one, other] = [freshTeam(), freshTeam()];
  const store = new RpcStoreBackend(lfBinary(), ['--contract-store', POSTGRES_URL, '--team', one.team]);
  const elsewhere = new RpcStoreBackend(lfBinary(), ['--contract-store', POSTGRES_URL, '--team', other.team]);
  const entry = { pid: 11, lf: 1, machine: 'box', command: 'node' };
  try {
    assert.deepEqual(await store.call('processes.list', {}, List), { processes: [], version: 0 });
    assert.equal(await store.call('processes.swap', { version: 0, processes: [entry] }, z.boolean()), true);
    assert.equal(await store.call('processes.swap', { version: 0, processes: [] }, z.boolean()), false);
    assert.deepEqual(await store.call('processes.list', {}, List), { processes: [entry], version: 1 });
    assert.equal(await store.call('processes.swap', { version: 1, processes: [] }, z.boolean()), true);
    assert.deepEqual(await store.call('processes.list', {}, List), { processes: [], version: 2 });
    assert.deepEqual(await elsewhere.call('processes.list', {}, List), { processes: [], version: 0 });
  } finally {
    await store.close();
    await elsewhere.close();
    one.clear();
    other.clear();
  }
});
