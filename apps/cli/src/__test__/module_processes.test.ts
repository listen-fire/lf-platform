// The module processes lf started, listed in the store (`processes.list`,
// `processes.swap`): a compare-and-set on the list's version, so two lfs on
// one store never overwrite each other's entries. Over lf's SQLite store and
// over a store module that forwards to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { RpcStoreBackend } from 'movement-engine/services/run_host/rpc_store';
import { lfBinary } from './lf_bin';
import { withStoreModule } from './store_module/project';

const List = z.object({ processes: z.array(z.unknown()), version: z.number() });

/** A project whose store slot the test store module fills, its state in `path`. */
function storeModuleProject(path: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-processes-slot-'));
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.11.0\n');
  withStoreModule(dir, path);
  return dir;
}

const bridges = [
  { over: 'the SQLite store', args: (path: string) => ['--contract-store', path] },
  { over: 'a store module', args: (path: string) => ['--contract-store-slot', '--dir', storeModuleProject(path)] },
];

for (const bridge of bridges) {
  test(`${bridge.over}: the module process list is written only over the version it was read at`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lf-processes-')), 'state.db');
    const store = new RpcStoreBackend(lfBinary(), bridge.args(path));
    const one = { pid: 11, lf: 1, machine: 'box', command: 'node' };
    const two = { pid: 22, lf: 2, machine: 'box', command: 'node' };
    try {
      assert.deepEqual(await store.call('processes.list', {}, List), { processes: [], version: 0 });
      // Two lfs read the empty list; the first write wins, the second learns it lost.
      assert.equal(await store.call('processes.swap', { version: 0, processes: [one] }, z.boolean()), true);
      assert.equal(await store.call('processes.swap', { version: 0, processes: [two] }, z.boolean()), false);
      assert.deepEqual(await store.call('processes.list', {}, List), { processes: [one], version: 1 });
      // The loser reads again and writes over what it read.
      assert.equal(await store.call('processes.swap', { version: 1, processes: [one, two] }, z.boolean()), true);
      assert.deepEqual(await store.call('processes.list', {}, List), { processes: [one, two], version: 2 });
    } finally {
      await store.close();
    }
  });
}
