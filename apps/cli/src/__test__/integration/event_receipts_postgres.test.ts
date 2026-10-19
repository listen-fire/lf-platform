// An event's receipt in the Postgres store (@lf/postgres-store's
// lf.event_receipt, its second migration): one idempotencyKey runs a listen
// once, per tenant, asked over the store wire's `events.claim`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { RpcStoreBackend } from 'movement-engine/services/run_host/rpc_store';
import { lfBinary } from '../lf_bin';
import { freshTeam, POSTGRES_URL } from './pg';

/** Each request's result, in order, from one `lf --contract-store` process. */
async function claims(team: string, asks: Array<[listen: string, key: string]>): Promise<unknown[]> {
  const bridge = new RpcStoreBackend(lfBinary(), ['--contract-store', POSTGRES_URL, '--team', team]);
  try {
    const out: unknown[] = [];
    for (const [listen, key] of asks) out.push(await bridge.call('events.claim', { listen, key }, z.boolean()));
    return out;
  } finally {
    await bridge.close();
  }
}

test('a redelivered key is refused for its listen and tenant only', async () => {
  const [one, other] = [freshTeam(), freshTeam()];
  try {
    assert.deepEqual(
      await claims(one.team, [
        ['listen:companies:welcome', 'delivery-1'],
        ['listen:companies:welcome', 'delivery-1'],
        ['listen:companies:audit', 'delivery-1'],
      ]),
      [true, false, true],
    );
    // A later process sees the receipt; another tenant has its own.
    assert.deepEqual(await claims(one.team, [['listen:companies:welcome', 'delivery-1']]), [false]);
    assert.deepEqual(await claims(other.team, [['listen:companies:welcome', 'delivery-1']]), [true]);
  } finally {
    one.clear();
    other.clear();
  }
});
