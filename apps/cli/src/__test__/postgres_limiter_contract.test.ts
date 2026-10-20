// The limiter slot's contract suite against @listen-fire/postgres-limiter (modules/
// postgres-limiter) as a process, over the slot wire, on the repo's test
// database in a schema of its own that the run drops. Skipped without
// DATABASE_URL_TEST. Two module processes share the one schema in the last
// case: the point of the module is that hosts share one count.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Pool } from 'pg';
import { HOLD_MS } from 'movement-engine/services/limiter/limiter';
import { limiterContractCases } from 'movement-engine/services/limiter/contract';
import { RpcLimiter } from 'movement-engine/services/limiter/rpc_limiter';

const url = process.env.DATABASE_URL_TEST;
const MODULE = resolve(__dirname, '../../../../modules/postgres-limiter');
const schema = `lf_limiter_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

function start(): RpcLimiter {
  return new RpcLimiter(process.execPath, ['--conditions=movement-engine-internals', '--require', require.resolve('tsx/cjs'), resolve(MODULE, 'serve.ts')]);
}

describe('@listen-fire/postgres-limiter', { skip: url === undefined ? 'DATABASE_URL_TEST is not set' : false }, () => {
  const limiters: RpcLimiter[] = [];
  const settings = { url: url ?? '', schema };

  before(async () => {
    const first = start();
    limiters.push(first);
    await first.open(settings);
  });

  after(async () => {
    await Promise.all(limiters.map((limiter) => limiter.close()));
    const pool = new Pool({ connectionString: url });
    try {
      await pool.query(`drop schema if exists "${schema}" cascade`);
    } finally {
      await pool.end();
    }
  });

  for (const contractCase of limiterContractCases) {
    test(contractCase.name, async () => {
      await contractCase.run(limiters[0]!);
    });
  }

  test('a second module process on the same database shares the count, and opening again changes nothing', async () => {
    const second = start();
    limiters.push(second);
    await second.open(settings);
    await limiters[0]!.open(settings);
    const bucket = { key: `shared:${randomUUID()}`, concurrent: 2 };
    const request = { key: `caller:${randomUUID()}`, cost: 1, limits: [bucket], holdMs: HOLD_MS };
    assert.ok((await limiters[0]!.acquire(request)).granted);
    assert.ok((await second.acquire(request)).granted);
    assert.ok(!(await limiters[0]!.acquire(request)).granted, 'both hosts counted');
    const throttled = `throttled:${randomUUID()}`;
    await second.throttle({ key: throttled, until: new Date(Date.now() + 60_000).toISOString() });
    assert.ok(!(await limiters[0]!.acquire({ ...request, key: throttled, limits: [] })).granted, 'a throttle one host reports holds on the other');
  });

  test('many hosts acquiring at once are granted no more than the limit', async () => {
    const bucket = { key: `race:${randomUUID()}`, calls: 7, perMs: 600_000, concurrent: 5 };
    const attempts = await Promise.all(
      Array.from({ length: 40 }, (_, index) => limiters[index % limiters.length]!.acquire({ key: `caller:${randomUUID()}`, cost: 1, limits: [bucket], holdMs: HOLD_MS })),
    );
    assert.equal(attempts.filter((attempt) => attempt.granted).length, 5);
  });
});
