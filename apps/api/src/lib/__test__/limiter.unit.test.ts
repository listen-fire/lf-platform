// The limiter the platform installs at boot, against the test database: the
// boot line names its schema, the slot holds it, and it passes the limiter
// slot's contract cases (the language's own, every limiter is held to them).

import { randomUUID } from 'node:crypto';

import Pg from 'pg';
import { limiterSlot } from 'movement-engine/public/limiter';
import { limiterContractCases } from 'movement-engine/public/testing';
import { PostgresLimiter } from '@listen-fire/postgres-limiter/limiter';

import { captureEngineLogs } from '../../test/engine_logs';
import { installSharedLimiter, type SharedLimiter } from '../limiter';

const databaseUrl = process.env.DATABASE_URL_TEST ?? '';
const schema = `lf_limiter_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const logs = captureEngineLogs();

let installed: SharedLimiter | undefined;

afterAll(async () => {
  await installed?.close();
  const client = new Pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`drop schema if exists "${schema}" cascade`);
  await client.end();
});

describe('the limiter installed at boot', () => {
  it('fills the slot with the Postgres limiter and says so, naming its schema', async () => {
    installed = await installSharedLimiter({ DATABASE_URL: databaseUrl, LIMITER_SCHEMA: schema });

    expect(installed.schema).toBe(schema);
    expect(limiterSlot()).toBeInstanceOf(PostgresLimiter);
    expect(logs.messages('info')).toContainEqual(expect.stringContaining(`kept in Postgres schema ${schema}`));
  });

  it('refuses a schema name that is not a plain identifier, naming the variable', async () => {
    await expect(installSharedLimiter({ DATABASE_URL: databaseUrl, LIMITER_SCHEMA: 'bad-name' })).rejects.toThrow(
      /^LIMITER_SCHEMA: /,
    );
  });

  it('refuses to boot without a database to keep the limits in', async () => {
    await expect(installSharedLimiter({})).rejects.toThrow(/DATABASE_URL/);
  });
});

describe('the limiter slot contract, on the platform database', () => {
  it.each(limiterContractCases.map((c) => [c.name, c] as const))('%s', async (_name, contractCase) => {
    expect(installed).toBeDefined();
    await contractCase.run(limiterSlot());
  });
});
