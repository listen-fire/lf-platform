#!/usr/bin/env node
// The module boundary guard. A module (modules/*) and the kit it is built
// with (packages/module-kit) are loaded by every host — the platform, lf, the
// Rust host, an embedder — so neither may reach what only the hosted product
// has: apps/*, a database client, or the recording layer (lib/recording). The
// engine is reached only through its public entries (movement-engine/public/*).
// Everything a module needs from its host comes through `ctx`.
//
// Unlike the engine boundary there is no baseline: the count is zero and
// stays zero. Run by each module's and the kit's `code:type-check`.
//
//   node scripts/check-module-boundary.cjs

const fs = require('node:fs');
const path = require('node:path');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '../packages/module-kit')] }));

const repoRoot = path.resolve(__dirname, '..');
const roots = [path.join(repoRoot, 'packages/module-kit'), path.join(repoRoot, 'packages/module-runtime')];
// The kit and the runtime it shares with the host are what the engine itself
// is built on, so neither may reach the engine at all: what a module is written
// against is engine-contracts' and module-runtime's.
const ENGINE_FREE = roots.slice();
const modulesDir = path.join(repoRoot, 'modules');
if (fs.existsSync(modulesDir)) {
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (entry.isDirectory()) roots.push(path.join(modulesDir, entry.name));
  }
}

const DATABASE_CLIENTS = /^(kysely|pg|pg-[^/]+|postgres|@prisma\/.*|prisma|\.prisma\/.*|better-sqlite3|sqlite3|knex|mysql2?)(\/|$)/;

// A module that is a database client by purpose: a process module (never loaded
// in a host's process) whose whole job is state kept in a shared database.
const DATABASE_MODULES = [path.join(modulesDir, 'postgres-limiter')];

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Build output is derived from the sources checked here, and may be stale.
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
      sourceFiles(full, found);
    } else if (/\.(c|m)?[tj]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Why an import is refused, or null when it is allowed. */
function refusal(specifier, fromFile) {
  if (ENGINE_FREE.some((root) => fromFile.startsWith(root + path.sep))) {
    const reachesEngine = specifier.startsWith('.')
      ? path.relative(repoRoot, path.resolve(path.dirname(fromFile), specifier)).startsWith(`packages${path.sep}movement-engine${path.sep}`)
      : /^(movement-engine|@listen-fire\/engine)(\/|$)/.test(specifier);
    if (reachesEngine) return 'reaches the engine (the kit and module-runtime stand below it: import engine-contracts or module-runtime)';
  }
  if (specifier.startsWith('.')) {
    const target = path.resolve(path.dirname(fromFile), specifier);
    const inRepo = path.relative(repoRoot, target);
    if (inRepo.startsWith(`apps${path.sep}`)) return 'reaches into apps/';
    if (/(^|[\\/])lib[\\/]recording(\.ts)?$/.test(target)) return 'reaches the recording layer';
    if (inRepo.startsWith(`packages${path.sep}movement-engine${path.sep}`) && !inRepo.startsWith(`packages${path.sep}movement-engine${path.sep}public${path.sep}`)) {
      return 'reaches an engine internal (import movement-engine/public/*)';
    }
    return null;
  }
  if (specifier === 'api' || specifier.startsWith('api/')) return 'reaches the hosted product';
  if (DATABASE_CLIENTS.test(specifier) && !DATABASE_MODULES.some((dir) => fromFile.startsWith(dir + path.sep))) return 'reaches a database client';
  if (/(^|\/)lib\/recording$/.test(specifier)) return 'reaches the recording layer';
  if (specifier === 'movement-engine' || (specifier.startsWith('movement-engine/') && !specifier.startsWith('movement-engine/public/'))) {
    return 'reaches an engine internal (import movement-engine/public/*)';
  }
  return null;
}

const refused = [];
let files = 0;
for (const root of roots) {
  for (const file of sourceFiles(root)) {
    files += 1;
    const { importedFiles } = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true);
    for (const imported of importedFiles) {
      const why = refusal(imported.fileName, file);
      if (why !== null) refused.push(`  ${path.relative(repoRoot, file)}: '${imported.fileName}' ${why}`);
    }
  }
}

if (refused.length > 0) {
  console.error(`module boundary: ${refused.length} import(s) a module may not make:`);
  for (const line of refused) console.error(line);
  process.exit(1);
}
console.log(`module boundary: ${files} files in ${roots.length} package(s), none reaching the hosted product, a database or the recording layer`);
