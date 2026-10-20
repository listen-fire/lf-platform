// The module process: the limiter slot's methods (docs/contracts/limiter-slot.md)
// served as adapter protocol 2 over HTTP, answered from Postgres. It opens
// its connection from the `url` setting on `limiter.open`, and from the
// settings every request carries should the process have restarted since.

import { Pool } from 'pg';
import { z } from 'zod';
import { serveSlot, SlotRefusal } from 'movement-engine/public/module-wire';
import type { LimitRequest } from 'movement-engine/public/limiter';
import { PostgresLimiter } from './limiter';
import { DEFAULT_SCHEMA } from './schema';

const Acquire: z.ZodType<LimitRequest> = z.object({
  key: z.string(),
  cost: z.number().int().min(0),
  limits: z.array(z.object({ key: z.string(), calls: z.number().int().positive().optional(), perMs: z.number().int().positive().optional(), concurrent: z.number().int().positive().optional() })),
  holdMs: z.number().int().positive(),
});

let opened: { key: string; limiter: Promise<PostgresLimiter> } | undefined;

function setting(settings: Record<string, unknown>, name: string): string | undefined {
  const value = settings[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function open(settings: Record<string, unknown>): Promise<PostgresLimiter> {
  const url = setting(settings, 'url');
  if (url === undefined && opened !== undefined) return opened.limiter;
  if (url === undefined) throw new SlotRefusal('missing_setting', 'the postgres limiter needs its `url` setting (the connection string)');
  const schema = setting(settings, 'schema') ?? DEFAULT_SCHEMA;
  const key = `${url}\n${schema}`;
  if (opened?.key !== key) {
    const pool = new Pool({ connectionString: url, max: 8 });
    // An idle connection the server drops is replaced by the pool; it must not end the process.
    pool.on('error', (error) => process.stderr.write(`postgres limiter: idle connection error: ${error.message}\n`));
    const limiter = new PostgresLimiter(pool, schema);
    const ready = limiter.setup(schema).then(() => limiter);
    // A failed setup is tried again by the next request, not remembered.
    ready.catch(() => {
      if (opened?.key === key) opened = undefined;
    });
    opened = { key, limiter: ready };
  }
  return opened.limiter;
}

void serveSlot({
  manifest: { protocolVersion: 2, name: 'postgres_limiter', kind: 'core', slot: 'limiter', methods: ['limiter.open', 'limiter.acquire', 'limiter.release', 'limiter.throttle'] },
  print: true,
  answer: async (method, params, settings) => {
    const given = method === 'limiter.open' && typeof params.settings === 'object' && params.settings !== null ? { ...params.settings, ...settings } : settings;
    const limiter = await open(given);
    switch (method) {
      case 'limiter.open':
        return null;
      case 'limiter.acquire':
        return limiter.acquire(Acquire.parse(params));
      case 'limiter.release':
        await limiter.release(String(params.permit));
        return null;
      case 'limiter.throttle':
        await limiter.throttle({ key: String(params.key), until: String(params.until) });
        return null;
      default:
        throw new Error(`no method "${method}"`);
    }
  },
});
