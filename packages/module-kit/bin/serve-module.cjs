#!/usr/bin/env node
// Serves a module over adapter protocol 2. tsx, when installed, lets the kit's
// own sources and a module written in TypeScript load without a build; it is
// an optional peer, so a built kit serving a built module needs none.
try {
  require('tsx/cjs');
} catch (error) {
  if (!(error && error.code === 'MODULE_NOT_FOUND')) throw error;
}
require('../serve.ts')
  .main(process.argv.slice(2), process.env)
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
