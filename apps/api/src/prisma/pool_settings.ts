/**
 * How many database connections this process may hold, for deployments on a
 * small managed Postgres (Cloud SQL's smallest tiers allow a few dozen in
 * total, and every API replica and worker brings its own pools).
 *
 * Every setting is optional and unset means the library's own default, so a
 * deployment that sets none of them behaves exactly as before. They are read
 * once, at boot; a value that is not a whole number in range fails the boot
 * naming the variable rather than being clamped.
 */

interface PoolSettings {
  /** `PRISMA_POOL_MAX`: connections EACH of the two Prisma clients (read-write, read-only) may hold. */
  prismaMax: number | undefined;
  /** `KYSELY_POOL_MAX`: connections the Kysely query builder's pool may hold. */
  kyselyMax: number | undefined;
  /** `KYSELY_POOL_IDLE_TIMEOUT_MS`: how long an idle Kysely connection is kept before it is closed (0 never closes it). */
  kyselyIdleTimeoutMs: number | undefined;
}

const MAX_CONNECTIONS_LIMIT = 10_000;

function wholeNumber(
  env: Record<string, string | undefined>,
  name: string,
  { min, max }: { min: number; max: number },
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}

function poolSettingsFromEnv(env: Record<string, string | undefined>): PoolSettings {
  return {
    prismaMax: wholeNumber(env, 'PRISMA_POOL_MAX', { min: 1, max: MAX_CONNECTIONS_LIMIT }),
    kyselyMax: wholeNumber(env, 'KYSELY_POOL_MAX', { min: 1, max: MAX_CONNECTIONS_LIMIT }),
    kyselyIdleTimeoutMs: wholeNumber(env, 'KYSELY_POOL_IDLE_TIMEOUT_MS', { min: 0, max: 24 * 60 * 60 * 1000 }),
  };
}

/**
 * Prisma takes its pool size from the connection string. Appended as text
 * rather than through `URL` so a Cloud SQL socket URL
 * (`postgresql://u:p@/db?host=/cloudsql/...`) keeps its exact spelling, and a
 * `connection_limit` already in the string is replaced, not duplicated.
 */
function withPrismaPoolMax(url: string | undefined, max: number | undefined): string | undefined {
  if (max === undefined || url === undefined) return url;
  const param = `connection_limit=${max}`;
  if (/([?&])connection_limit=[^&]*/.test(url)) {
    return url.replace(/([?&])connection_limit=[^&]*/, `$1${param}`);
  }
  return `${url}${url.includes('?') ? '&' : '?'}${param}`;
}

/** The options handed to `new pg.Pool`; only the ones set, so the rest stay pg's own defaults. */
function kyselyPoolOptions(settings: PoolSettings): { max?: number; idleTimeoutMillis?: number } {
  return {
    ...(settings.kyselyMax === undefined ? {} : { max: settings.kyselyMax }),
    ...(settings.kyselyIdleTimeoutMs === undefined ? {} : { idleTimeoutMillis: settings.kyselyIdleTimeoutMs }),
  };
}

const poolSettings = poolSettingsFromEnv(process.env);

export { poolSettings, poolSettingsFromEnv, withPrismaPoolMax, kyselyPoolOptions };
export type { PoolSettings };
