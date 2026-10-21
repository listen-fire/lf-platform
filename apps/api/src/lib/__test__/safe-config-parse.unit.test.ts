/**
 * Unit coverage for the safe-parse helper. The helper is small but
 * load-bearing — every runtime config parser delegates here, so the
 * shape of the result (`{ ok, config }` vs `{ ok, error, raw }`), the
 * presence of the warn log, and the error formatting all need to be
 * pinned.
 *
 */

import { z } from 'zod';

import { captureEngineLogs } from '../../test/engine_logs';
import { safeParseConfig } from '../safe-config-parse';

describe('safeParseConfig', () => {
  const logs = captureEngineLogs();

  it('returns ok: true with the parsed config on valid input', () => {
    const schema = z.object({ key: z.string() });
    const result = safeParseConfig(schema, { key: 'pi-abc' }, 'test:valid');
    expect(result).toEqual({ ok: true, config: { key: 'pi-abc' } });
    expect(logs.warn()).toEqual([]);
  });

  it('returns ok: false with a flattened error message on invalid input', () => {
    const schema = z.object({ key: z.string() });
    const result = safeParseConfig(schema, {}, 'test:invalid');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('key:');
    expect(result.raw).toEqual({});
  });

  it('logs at warn level with the context tag on invalid input', () => {
    const schema = z.object({ key: z.string() });
    safeParseConfig(schema, {}, 'getInboundAdapter:CUSTOM_EMAIL:pi-abc');
    expect(logs.warn()).toHaveLength(1);
    const [{ message }] = logs.warn();
    expect(message).toContain('getInboundAdapter:CUSTOM_EMAIL:pi-abc');
    expect(message).toContain('re-configure');
  });

  it('preserves the raw value on the failure branch for downstream surfacing', () => {
    const schema = z.object({ key: z.string() });
    const raw = { unexpected: 'shape', extra: 42 };
    const result = safeParseConfig(schema, raw, 'test:raw-preserved');
    if (result.ok) throw new Error('unreachable');
    expect(result.raw).toBe(raw);
  });

  it('flattens nested zod errors into a semicolon-joined string', () => {
    const schema = z.object({
      sender: z.object({
        email: z.string(),
        username: z.string(),
      }),
    });
    const result = safeParseConfig(schema, { sender: {} }, 'test:nested');
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('sender.email');
    expect(result.error).toContain('sender.username');
    expect(result.error).toContain('; ');
  });

  it('surfaces a root-level error with the `(root)` path when no key applies', () => {
    const schema = z.string();
    const result = safeParseConfig(schema, 42, 'test:root');
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('(root)');
  });
});
