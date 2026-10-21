import { rateLimitDelayMs } from '../retry_after';

const NOW = Date.parse('2026-10-21T12:00:00Z');

describe('rateLimitDelayMs', () => {
  it('reads Retry-After seconds from a plain header object', () => {
    expect(rateLimitDelayMs({ headers: { 'retry-after': '7' } })).toBe(7000);
  });

  it('reads Retry-After from a fetch Headers object', () => {
    expect(rateLimitDelayMs({ headers: new Headers({ 'Retry-After': '7' }) })).toBe(7000);
  });

  it('reads Retry-After as an HTTP date', () => {
    const date = new Date(NOW + 30_000).toUTCString();
    expect(rateLimitDelayMs({ headers: { 'retry-after': date } }, NOW)).toBe(30_000);
  });

  it('reads Google RetryInfo from the error text', () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' }],
      },
    });
    expect(rateLimitDelayMs(new Error(body))).toBe(17_000);
  });

  it('reads a decoded retryDelay object', () => {
    expect(rateLimitDelayMs(new Error('{"retryDelay":{"seconds":9}}'))).toBe(9000);
  });

  it('is undefined when the vendor did not say', () => {
    expect(rateLimitDelayMs(new Error('429 Too Many Requests'))).toBeUndefined();
    expect(rateLimitDelayMs('nope')).toBeUndefined();
  });

  it('clamps to the ceiling and the floor', () => {
    expect(rateLimitDelayMs({ headers: { 'retry-after': '600' } })).toBe(120_000);
    expect(rateLimitDelayMs({ headers: { 'retry-after': '0' } })).toBe(1000);
  });
});
