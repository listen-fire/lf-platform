// The limiter every model call asks before it goes (@lf/anthropic's 8 in
// flight, and its vendor's retry-after), kept in the platform's own Postgres
// so every instance, worker and drain pass on the database shares one count.
// Without it each process ran the engine's in-process default and allowed the
// full limit on its own.

import Pg from 'pg';
import { installLimiter } from 'movement-engine/public/limiter';
import { logger } from 'movement-engine/public/log';
import { PostgresLimiter } from '@listen-fire/postgres-limiter/limiter';
import { DEFAULT_SCHEMA, schemaIdentifier } from '@listen-fire/postgres-limiter/schema';

/** Each acquire is one short transaction, so a few connections serve every caller. */
const POOL_MAX = 8;

interface SharedLimiter {
  schema: string;
  /** Ends the limiter's pool. The slot keeps the limiter, so only an exiting process calls it. */
  close(): Promise<void>;
}

function limiterSchema(env: NodeJS.ProcessEnv): string {
  const schema = env.LIMITER_SCHEMA || DEFAULT_SCHEMA;
  try {
    schemaIdentifier(schema);
  } catch (error) {
    throw new Error(`LIMITER_SCHEMA: ${error instanceof Error ? error.message : String(error)}`);
  }
  return schema;
}

/**
 * Fill the engine's limiter slot with the Postgres limiter, creating its schema
 * when it is not there. Awaited before the process drains or serves, since a
 * call made earlier would count in the in-process default instead.
 */
async function installSharedLimiter(env: NodeJS.ProcessEnv = process.env): Promise<SharedLimiter> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('The DATABASE_URL environment variable is required — the limiter is kept there');
  const schema = limiterSchema(env);
  const pool = new Pg.Pool({ connectionString: databaseUrl, max: POOL_MAX });
  // An idle connection the server drops (a restart, a failover) is an `error`
  // event, and an unheard one ends the process. The next acquire reconnects.
  pool.on('error', (error) => {
    logger.warn('[limiter] an idle connection to the limiter database failed', { cause: error.message });
  });
  const limiter = new PostgresLimiter(pool, schema);
  await limiter.setup(schema);
  installLimiter(limiter);
  logger.info(`[limiter] calls share one count across instances, kept in Postgres schema ${schema}`, { schema });
  return { schema, close: () => pool.end() };
}

export { installSharedLimiter, POOL_MAX };
export type { SharedLimiter };
