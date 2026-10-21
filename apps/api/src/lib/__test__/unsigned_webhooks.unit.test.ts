// The rule every inbound door shares when it has no signing secret. It used to
// be "reject in production, allow everywhere else", which left every staging box
// and review app with an unauthenticated ingress that fires real automations.

import type { EngineLogLine } from 'movement-engine/public/log';

// Each case runs in a fresh module registry, whose logger is its own, so the
// sink is installed there rather than through the shared capture helper.
let logged: EngineLogLine[] = [];
const warnings = () => logged.filter((line) => line.level === 'warn');

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
  logged = [];
  const { routeEngineLogsTo } = await import('movement-engine/public/log');
  routeEngineLogsTo((line) => {
    logged.push(line);
  });
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** Fresh module per case: the one-shot warning is per-process state. */
async function authorize(door = 'test/door') {
  const { authorizeUnsignedWebhook } = await import('../unsigned_webhooks');
  return authorizeUnsignedWebhook(door);
}

it('refuses when no secret is configured and nothing opted in', async () => {
  process.env.NODE_ENV = 'development';
  delete process.env.ALLOW_UNSIGNED_WEBHOOKS;

  expect(await authorize()).toEqual({ authorized: false, reason: 'no_secret' });
});

it('refuses in production even with the bypass set — the bypass is not a production switch', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';

  expect(await authorize()).toEqual({ authorized: false, reason: 'no_secret' });
  expect(warnings()).toEqual([]);
});

it('allows outside production when the bypass is explicitly set', async () => {
  process.env.NODE_ENV = 'development';
  process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';

  expect(await authorize()).toEqual({ authorized: true });
});

it('warns loudly, naming itself and the door, and only once per door', async () => {
  process.env.NODE_ENV = 'development';
  process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';

  const { authorizeUnsignedWebhook } = await import('../unsigned_webhooks');
  authorizeUnsignedWebhook('slack/events');
  authorizeUnsignedWebhook('slack/events');
  authorizeUnsignedWebhook('telegram/builtin');

  const messages = warnings().map((line) => line.message);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toContain('ALLOW_UNSIGNED_WEBHOOKS');
  expect(messages[0]).toContain('slack/events');
  expect(messages[1]).toContain('telegram/builtin');
});

it('takes only the literal `true` — a truthy-looking value is not consent', async () => {
  process.env.NODE_ENV = 'development';

  for (const value of ['1', 'TRUE', 'yes', '']) {
    process.env.ALLOW_UNSIGNED_WEBHOOKS = value;
    expect(await authorize()).toEqual({ authorized: false, reason: 'no_secret' });
  }
});
