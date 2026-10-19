import { kyselyPoolOptions, poolSettingsFromEnv, withPrismaPoolMax } from '../pool_settings';

describe('poolSettingsFromEnv', () => {
  it('leaves everything undefined when nothing is set, so library defaults apply', () => {
    const settings = poolSettingsFromEnv({});
    expect(settings).toEqual({ prismaMax: undefined, kyselyMax: undefined, kyselyIdleTimeoutMs: undefined });
    expect(kyselyPoolOptions(settings)).toEqual({});
  });

  it('parses the three settings', () => {
    const settings = poolSettingsFromEnv({
      PRISMA_POOL_MAX: '3',
      KYSELY_POOL_MAX: '4',
      KYSELY_POOL_IDLE_TIMEOUT_MS: '0',
    });
    expect(settings).toEqual({ prismaMax: 3, kyselyMax: 4, kyselyIdleTimeoutMs: 0 });
    expect(kyselyPoolOptions(settings)).toEqual({ max: 4, idleTimeoutMillis: 0 });
  });

  it.each([
    ['PRISMA_POOL_MAX', '0'],
    ['PRISMA_POOL_MAX', '-1'],
    ['PRISMA_POOL_MAX', '2.5'],
    ['KYSELY_POOL_MAX', 'many'],
    ['KYSELY_POOL_MAX', '1e3'],
    ['KYSELY_POOL_MAX', '999999'],
    ['KYSELY_POOL_IDLE_TIMEOUT_MS', '-5'],
    ['KYSELY_POOL_IDLE_TIMEOUT_MS', '1.5'],
  ])('refuses %s=%s, naming the variable', (name, value) => {
    expect(() => poolSettingsFromEnv({ [name]: value })).toThrow(new RegExp(name));
  });
});

describe('withPrismaPoolMax', () => {
  it('changes nothing when unset', () => {
    expect(withPrismaPoolMax('postgresql://u:p@h:5432/db', undefined)).toBe('postgresql://u:p@h:5432/db');
    expect(withPrismaPoolMax(undefined, 3)).toBeUndefined();
  });

  it('appends connection_limit to a bare URL or one with a query', () => {
    expect(withPrismaPoolMax('postgresql://u:p@h/db', 3)).toBe('postgresql://u:p@h/db?connection_limit=3');
    expect(withPrismaPoolMax('postgresql://u:p@h/db?schema=x', 3)).toBe('postgresql://u:p@h/db?schema=x&connection_limit=3');
  });

  it('replaces a connection_limit the URL already carries', () => {
    expect(withPrismaPoolMax('postgresql://u@h/db?connection_limit=20&schema=x', 3)).toBe(
      'postgresql://u@h/db?connection_limit=3&schema=x',
    );
  });

  it('keeps a Cloud SQL socket URL spelled as given', () => {
    expect(withPrismaPoolMax('postgresql://u:p%40ss@/db?host=/cloudsql/p:r:i', 2)).toBe(
      'postgresql://u:p%40ss@/db?host=/cloudsql/p:r:i&connection_limit=2',
    );
  });
});
