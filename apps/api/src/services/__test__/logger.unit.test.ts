/**
 * Plain JSON.stringify drops Error.message/Error.stack (non-enumerable) → `{}`.
 * The engine's line format applies an Error-aware replacer to the metadata,
 * in any NODE_ENV.
 */

import { formatEngineLogLine, logger, routeEngineLogsTo } from 'movement-engine/public/log';

// Captures through the engine's log hook, formatting each line as the default
// console hook would print it.
function captureLogOutput(emit: () => void): string {
  const lines: string[] = [];
  const restore = routeEngineLogsTo((line) => lines.push(formatEngineLogLine(line, { colour: false })));
  try {
    emit();
  } finally {
    restore();
  }
  return lines.join('\n');
}

describe('logger metadata Error serialization', () => {
  it('keeps message/stack for a top-level Error in metadata', () => {
    const output = captureLogOutput(() => {
      logger.warn('Plugin failed to fetch URL', { url: 'https://example.com', error: new Error('boom') });
    });
    expect(output).toContain('"message":"boom"');
    expect(output).toContain('"stack":"Error: boom');
    expect(output).not.toContain('"error":{}');
  });

  it('keeps message/stack for a nested Error in metadata', () => {
    const output = captureLogOutput(() => {
      logger.warn('Nested error case', { ctx: { error: new Error('nested') } });
    });
    expect(output).toContain('"message":"nested"');
    expect(output).toContain('"stack":"Error: nested');
  });

  it('omits trailing metadata json when there is none', () => {
    const output = captureLogOutput(() => {
      logger.warn('Plain message no metadata');
    });
    expect(output).toContain('Plain message no metadata');
    expect(output).not.toContain('{}');
  });
});
