// The version boundary rule (scripts/check-engine-boundary.cjs) run over small
// trees built here: a tree with an import across versions fails naming it, and
// the same tree without it passes. Without this, "0 imports across versions"
// is also what a scanner that finds nothing prints.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-engine-boundary.cjs');

function write(root: string, file: string, text: string): void {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

const manifest = (name: string, version: string, dependencies: Record<string, string> = {}) =>
  JSON.stringify({ name, version, dependencies });

/**
 * A repository whose current language is 0.15: the workspace catalog names
 * movement-lang 0.15.1, which the api resolves. `old-module` is a module whose
 * core resolved to 0.12.13, and `@listen-fire/lang-0.12` a version package,
 * which only the registry may import.
 */
function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'version-boundary-'));
  write(root, 'pnpm-workspace.yaml', 'catalog:\n  "@listen-fire/movement-lang": 0.15.1\n');
  write(root, 'node_modules/@listen-fire/movement-lang/package.json', manifest('@listen-fire/movement-lang', '0.15.1'));
  write(root, 'apps/api/node_modules/old-module/package.json', manifest('old-module', '1.0.0', { '@listen-fire/movement-lang': '0.12.13' }));
  write(
    root,
    'apps/api/node_modules/old-module/node_modules/@listen-fire/movement-lang/package.json',
    manifest('@listen-fire/movement-lang', '0.12.13'),
  );
  write(root, 'packages/lang-0.12/package.json', manifest('@listen-fire/lang-0.12', '0.12.13'));
  write(root, 'packages/language-versions/package.json', manifest('@listen-fire/language-versions', '0.0.1'));
  write(root, 'packages/language-versions/index.ts', "export const load = () => import('@listen-fire/lang-0.12');\n");
  write(root, 'apps/api/src/current.ts', "import { LANGUAGE_VERSION } from '@listen-fire/movement-lang';\nexport const v = LANGUAGE_VERSION;\n");
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  return root;
}

function check(root: string) {
  const run = spawnSync(process.execPath, [SCRIPT, `--root=${root}`], { encoding: 'utf8' });
  fs.rmSync(root, { recursive: true, force: true });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('the version boundary rule', () => {
  it('passes a tree whose only version package import is the registry', () => {
    const run = check(tree({}));
    expect(run.stdout).toContain('version boundary: current language 0.15; 0 imports across versions');
    expect(run.status).toBe(0);
  });

  it('fails an import of a package whose core is another version, naming the file, line and version', () => {
    const run = check(tree({ 'apps/api/src/crossing.ts': "\nimport { thing } from 'old-module';\nexport { thing };\n" }));
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('1 imports across versions');
    expect(run.stderr).toContain('apps/api/src/crossing.ts:2  old-module: it resolves to language 0.12, not the current 0.15');
  });

  it('fails an import of a version package from anywhere but the registry', () => {
    const run = check(tree({ 'apps/api/src/bypass.ts': "export const lane = require('@listen-fire/lang-0.12');\n" }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('apps/api/src/bypass.ts:1  @listen-fire/lang-0.12: only packages/language-versions imports a version package');
  });
});
