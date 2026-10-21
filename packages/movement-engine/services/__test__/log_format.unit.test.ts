import { jsonLogLine, logFormatFromEnv, severityOf } from '../log_format';

describe('severityOf', () => {
  it.each([
    ['error', 'ERROR'],
    ['warn', 'WARNING'],
    ['info', 'INFO'],
    ['http', 'INFO'],
    ['verbose', 'DEBUG'],
    ['debug', 'DEBUG'],
    ['silly', 'DEBUG'],
  ])('maps winston %s to %s', (level, severity) => {
    expect(severityOf(level)).toBe(severity);
  });

  it('puts a process-killing exception at CRITICAL', () => {
    expect(severityOf('error', { fatal: true })).toBe('CRITICAL');
  });

  it('falls back to INFO for a level it does not know', () => {
    expect(severityOf('custom')).toBe('INFO');
  });
});

describe('jsonLogLine', () => {
  const timestamp = new Date('2026-10-19T12:00:00.000Z');

  it('is one JSON object with severity, message, timestamp and the metadata', () => {
    const line = jsonLogLine({ level: 'warn', message: 'slow query', timestamp, meta: { ms: 812 } });
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      severity: 'WARNING',
      message: 'slow query',
      timestamp: '2026-10-19T12:00:00.000Z',
      ms: 812,
    });
  });

  it('carries the request context id as its own field', () => {
    const parsed = JSON.parse(jsonLogLine({ level: 'info', message: 'hi', timestamp, contextId: 'ctx-1', meta: {} }));
    expect(parsed.contextId).toBe('ctx-1');
    expect(parsed.message).toBe('hi');
  });

  it('keeps an Error message and stack in metadata', () => {
    const parsed = JSON.parse(
      jsonLogLine({ level: 'error', message: 'failed', timestamp, meta: { error: new Error('boom') } }),
    );
    expect(parsed.error.message).toBe('boom');
    expect(parsed.error.stack).toContain('boom');
  });

  it('marks an uncaught exception CRITICAL and drops the marker field', () => {
    const parsed = JSON.parse(jsonLogLine({ level: 'error', message: 'died', timestamp, meta: { exception: true } }));
    expect(parsed.severity).toBe('CRITICAL');
    expect(parsed).not.toHaveProperty('exception');
  });

  it('does not let metadata shadow the reserved fields', () => {
    const parsed = JSON.parse(
      jsonLogLine({
        level: 'info',
        message: 'real',
        timestamp,
        meta: { severity: 'FAKE', message: 'fake', timestamp: 'fake' },
      }),
    );
    expect(parsed).toMatchObject({ severity: 'INFO', message: 'real', timestamp: '2026-10-19T12:00:00.000Z' });
  });

  it('stringifies an object message', () => {
    const parsed = JSON.parse(jsonLogLine({ level: 'info', message: { a: 1 }, timestamp, meta: {} }));
    expect(parsed.message).toBe('{"a":1}');
  });

  it('writes already-redacted text exactly as given', () => {
    const parsed = JSON.parse(jsonLogLine({ level: 'warn', message: 'refresh failed: [redacted]', timestamp, meta: {} }));
    expect(parsed.message).toBe('refresh failed: [redacted]');
  });
});

describe('logFormatFromEnv', () => {
  it('defaults to the human-readable format', () => {
    expect(logFormatFromEnv({})).toBe('text');
    expect(logFormatFromEnv({ LOG_FORMAT: '' })).toBe('text');
    expect(logFormatFromEnv({ LOG_FORMAT: 'text' })).toBe('text');
  });

  it('switches to json', () => {
    expect(logFormatFromEnv({ LOG_FORMAT: 'json' })).toBe('json');
  });

  it('refuses any other value, naming the variable', () => {
    expect(() => logFormatFromEnv({ LOG_FORMAT: 'JSON' })).toThrow(/LOG_FORMAT/);
    expect(() => logFormatFromEnv({ LOG_FORMAT: 'yaml' })).toThrow(/LOG_FORMAT/);
  });
});
