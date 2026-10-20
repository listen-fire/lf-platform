// The test wake module (serve.ts) as a process, and a project whose wake
// slot it fills.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVE = resolve(__dirname, 'serve.ts');

/** How node starts serve.ts. */
export const WAKE_MODULE_COMMAND = [process.execPath, '--conditions=movement-engine-internals', '--require', require.resolve('tsx/cjs'), SERVE];

export function wakeModuleProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-wake-slot-'));
  mkdirSync(join(dir, 'externals/acme_wake'), { recursive: true });
  writeFileSync(
    join(dir, 'externals/acme_wake/lf-external.yaml'),
    [
      'name: acme_wake',
      'kind: core',
      'slot: wake',
      `command: [${WAKE_MODULE_COMMAND.map((part) => JSON.stringify(part)).join(', ')}]`,
      'settings:',
      '  - { name: target, label: where a wake is delivered }',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.11.0\ncore:\n  wake: acme_wake\n');
  return dir;
}
