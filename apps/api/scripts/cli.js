// `pnpm cli`: the operator CLI, run from wherever this install keeps it.
//
// An installation's image carries the compiled CLI and no TypeScript toolchain
// (its dependencies are the production ones). A checkout carries the toolchain
// and, at best, a build from some earlier commit, which lacks any command added
// since. So the toolchain decides: with ts-node installed, the CLI runs from its
// source, the code in front of you, with the checkout's `.env` loaded as every
// dev script loads it; without it, from the build the image made.

const path = require('path');

const api = path.resolve(__dirname, '..');

function installed(name) {
  try {
    require.resolve(name, { paths: [api] });
    return true;
  } catch {
    return false;
  }
}

if (installed('ts-node')) {
  const project = path.join(api, 'tsconfig.dev.json');
  require('dotenv').config({ path: path.join(api, '.env') });
  require('ts-node').register({ project, transpileOnly: true });
  process.env.TS_NODE_PROJECT = project;
  require('tsconfig-paths/register');
  require(path.join(api, 'src/interfaces/cli/cli.ts'));
} else {
  require(path.join(api, 'build/interfaces/cli/cli.js'));
}
