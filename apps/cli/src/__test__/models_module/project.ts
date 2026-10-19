// A project whose models slot is filled by the test models module (serve.ts).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SERVE = resolve(__dirname, 'serve.ts');

/** What the module answers every call with. */
export const ACME_LLM_ANSWER = 'Vireo Robotics, welcomed by acme_llm';

export function withModelsModule(dir: string, env: Record<string, string> = {}): void {
  mkdirSync(join(dir, 'externals/acme_llm'), { recursive: true });
  const command = [process.execPath, '--conditions=movement-engine-internals', '--require', require.resolve('tsx/cjs'), SERVE];
  const envLines = Object.entries(env).map(([name, value]) => `  ${name}: ${JSON.stringify(value)}`);
  writeFileSync(
    join(dir, 'externals/acme_llm/lf-external.yaml'),
    ['name: acme_llm', 'kind: core', 'slot: models', `command: [${command.map((part) => JSON.stringify(part)).join(', ')}]`, ...(envLines.length > 0 ? ['env:', ...envLines] : []), ''].join('\n'),
  );
  appendFileSync(join(dir, 'lf.yaml'), '\ncore:\n  models: acme_llm\n');
}
