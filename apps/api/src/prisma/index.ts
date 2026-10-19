import crypto from 'node:crypto';

import * as db from '@prisma/client';

import { requireEnv } from '../lib/utils/environment';
import { poolSettings, withPrismaPoolMax } from './pool_settings';

requireEnv('NODE_ENV');
if (process.env.NODE_ENV === 'test') {
  requireEnv('DATABASE_URL_TEST', 'DATABASE_URL_TEST_READONLY');
} else {
  requireEnv('DATABASE_URL', 'DATABASE_URL_READONLY');
}

const testSchemaName = crypto.randomUUID();

function getDatabaseUrl(readonly = false) {
  const env = process.env;
  if (env.NODE_ENV === 'test') {
    const database = readonly ? env.DATABASE_URL_TEST_READONLY : env.DATABASE_URL_TEST;
    return {
      url: `${database}?schema=${testSchemaName}`,
      schemaName: testSchemaName,
    };
  }

  return { url: readonly ? env.DATABASE_URL_READONLY : env.DATABASE_URL, schemaName: null };
}

const log: db.Prisma.LogLevel[] | undefined = undefined;

const prismaClient = new db.PrismaClient({
  datasources: { db: { url: withPrismaPoolMax(getDatabaseUrl().url, poolSettings.prismaMax) } },
  log,
});

const prismaReadonlyClient = new db.PrismaClient({
  datasources: { db: { url: withPrismaPoolMax(getDatabaseUrl(true).url, poolSettings.prismaMax) } },
  log,
});

export { getDatabaseUrl, prismaClient, prismaReadonlyClient };
