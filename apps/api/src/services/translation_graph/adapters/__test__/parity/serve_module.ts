// Where a module served as its own process (module-kit's serve-module) is
// found. The kit and the built-in modules are the language's: beside this app
// in the language's tree, installed from the registry in the platform's, so
// both are found by package name, never by a path into the repository.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A package's root directory, as this app resolves it. */
export function packageDir(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

/** The kit's serve-module bin, as its manifest names it (`bin/` in the source,
 *  `dist/bin/` once published). */
function serveModuleBin(): string {
  const kit = packageDir('module-kit');
  const manifest: unknown = JSON.parse(readFileSync(join(kit, 'package.json'), 'utf8'));
  if (typeof manifest === 'object' && manifest !== null && 'bin' in manifest) {
    const bin: unknown = manifest.bin;
    if (typeof bin === 'object' && bin !== null && 'serve-module' in bin && typeof bin['serve-module'] === 'string') {
      return join(kit, bin['serve-module']);
    }
  }
  throw new Error(`module-kit's manifest (${kit}) names no serve-module bin`);
}

export const SERVE_MODULE = serveModuleBin();
