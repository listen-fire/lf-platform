const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../check-split-boundary.cjs');

function write(root, relative, text) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-boundary-'));
  write(root, 'pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
  write(root, 'packages/lang/package.json', JSON.stringify({
    name: '@x/lang',
    dependencies: { plat: 'workspace:@x/plat@*' },
  }));
  write(root, 'packages/plat/package.json', JSON.stringify({
    name: '@x/plat',
    dependencies: { lang: 'workspace:^' },
  }));
  write(root, 'packages/lang/src/by_relative.ts', "import { a } from '../../plat/src/a';\n");
  write(root, 'packages/lang/src/by_alias.ts', "\nimport { b } from 'plat/src/b';\n");
  write(root, 'packages/lang/src/clean.ts', "import { c } from './by_relative';\n");
  write(root, 'packages/plat/src/a.ts', 'export const a = 1;\n');
  write(root, 'packages/plat/src/b.ts', 'export const b = 1;\n');
  write(root, 'packages/plat/src/uses_lang.ts', "import { c } from 'lang/src/clean';\nimport { d } from '../../lang/src/clean';\n");
  return root;
}

test('a language file importing a platform file is a violation, the reverse is not', () => {
  const root = fixture();
  const { violations } = run(root, { language: ['packages/lang'], platform: ['packages/plat'] });
  const sites = violations.map((v) => `${v.file}:${v.line}`).sort();
  assert.deepStrictEqual(sites, ['packages/lang/src/by_alias.ts:2', 'packages/lang/src/by_relative.ts:1']);
  assert.ok(violations.every((v) => v.target.startsWith('packages/plat/')));
});

test('the longest matching prefix decides the root', () => {
  const root = fixture();
  const { violations } = run(root, {
    language: ['packages/lang', 'packages/plat/src/a.ts'],
    platform: ['packages/plat'],
  });
  const sites = violations.map((v) => `${v.file}:${v.line}`).sort();
  assert.deepStrictEqual(sites, ['packages/lang/src/by_alias.ts:2']);
});
