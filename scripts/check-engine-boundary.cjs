#!/usr/bin/env node
// The engine boundary guard. The platform reaches the installed engine
// (`@listen-fire/engine`, spelled `movement-engine` by the alias most manifests
// use) only through its public entries, `movement-engine/public/*`; this lists
// every import of an internal module (anything else under the package) and
// compares the count with the baseline in engine-boundary-baseline.json.
//
// Every file in the platform's trees is held to the rule, tests too: the
// published engine has no internals to reach, so a test uses the public
// entries (the test host and the contract cases are in `public/testing`, the
// log lines in `public/log`'s sink), and a `jest.mock` of an internal module
// counts as an import of it. The engine is an installed package, so the check
// is by name: a relative path cannot reach it.
//
// The baseline is empty: any import of an internal fails. ESLint's
// no-restricted-imports (apps/api/eslint.config.js) says the same in the
// editor, and the package's `exports` map refuses an internal at run time.
//
// The same run guards the boundary between language versions. The platform
// carries more than one release (packages/language-versions), and TypeScript
// compares structurally: a value from one release passes silently into
// another's functions, and a throw of one release's error class is not the
// other's. So nothing imports a package of a version other than the current
// one, except that version's own package (`packages/lang-<version>`) and the
// registry, which alone imports a `@listen-fire/lang-*` package. A package's
// version is the release of the language core it resolves (by Node's own
// walk from its directory), so a module whose peers resolved to 0.12 is 0.12's
// however it is spelled. That rule has no baseline: any crossing fails.
//
//   node scripts/check-engine-boundary.cjs              report / gate
//   node scripts/check-engine-boundary.cjs --update     rewrite the baseline
//   node scripts/check-engine-boundary.cjs --list       also list every site
//   node scripts/check-engine-boundary.cjs --root=DIR   check the tree at DIR
//                                                       (default: this repo)

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const rootArg = process.argv.slice(2).find((arg) => arg.startsWith('--root='));
const repoRoot = path.resolve(rootArg !== undefined ? rootArg.slice('--root='.length) : path.join(__dirname, '..'));
/** Every tree that consumes the engine, relative to the repo root. */
const CONSUMER_ROOTS = [
  'apps/api/src',
  ...['packages', 'modules'].filter((dir) => fs.existsSync(path.join(repoRoot, dir))).flatMap((dir) =>
    fs
      .readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${dir}/${e.name}`),
  ),
].filter((root) => fs.existsSync(path.join(repoRoot, root)));
const baselineFile = path.join(repoRoot, 'scripts', 'engine-boundary-baseline.json');

const PACKAGE = 'movement-engine';
const PUBLISHED = '@listen-fire/engine';
const args = new Set(process.argv.slice(2));

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** The module an import names, as a path inside the engine package, or null
 *  when it does not reach the package. '' is the package root. */
function enginePathOf(specifier) {
  for (const name of [PACKAGE, PUBLISHED]) {
    if (specifier === name) return '';
    if (specifier.startsWith(`${name}/`)) return specifier.slice(name.length + 1);
  }
  return null;
}

function specifiersIn(sourceFile) {
  const found = [];
  const add = (literal) => {
    if (literal && ts.isStringLiteralLike(literal)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
      found.push({ specifier: literal.text, line: line + 1 });
    }
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isJestModuleCall =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'jest' &&
        ['mock', 'doMock', 'unmock', 'requireActual', 'requireMock'].includes(callee.name.text);
      if (isRequire || isJestModuleCall || callee.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const sites = [];
for (const root of CONSUMER_ROOTS) {
  const rootDir = path.join(repoRoot, root);
  for (const file of sourceFiles(rootDir)) {
    const relative = path.relative(rootDir, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(PACKAGE) && !text.includes(PUBLISHED)) continue;
    const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
    for (const { specifier, line } of specifiersIn(parsed)) {
      const inside = enginePathOf(specifier);
      if (inside === null) continue;
      if (inside === 'public' || inside.startsWith('public/')) continue;
      sites.push({ module: inside === '' ? '(package root)' : inside, file: `${root}/${relative}`, line });
    }
  }
}

const byModule = {};
for (const { module: name } of sites) byModule[name] = (byModule[name] ?? 0) + 1;
const sortedModules = Object.fromEntries(Object.entries(byModule).sort(([a], [b]) => a.localeCompare(b)));
const total = sites.length;

if (args.has('--update')) {
  fs.writeFileSync(baselineFile, `${JSON.stringify({ total, byModule: sortedModules }, null, 2)}\n`);
  console.log(`engine boundary: baseline written (${total} imports of ${Object.keys(sortedModules).length} internal modules)`);
  process.exit(0);
}

const baseline = fs.existsSync(baselineFile)
  ? JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
  : { total: 0, byModule: {} };

const grown = [];
if (total > baseline.total) grown.push(`total ${baseline.total} -> ${total}`);
for (const [name, count] of Object.entries(sortedModules)) {
  const allowed = baseline.byModule[name] ?? 0;
  if (count > allowed) grown.push(`${name}: ${allowed} -> ${count}`);
}

console.log(
  `engine boundary: ${total} imports of engine internals outside movement-engine/public (baseline ${baseline.total}, ${Object.keys(sortedModules).length} modules)`,
);
if (args.has('--list')) {
  for (const site of sites) console.log(`  ${site.file}:${site.line}  ${site.module}`);
}
if (total < baseline.total) {
  console.log('engine boundary: below baseline; run with --update to lock in the lower count.');
}

// ---- The boundary between language versions. ----

const CORE = new Set(['@listen-fire/engine', '@listen-fire/engine-contracts', '@listen-fire/movement-lang']);
const REGISTRY_ROOT = 'packages/language-versions';
const VERSION_PACKAGE = /^@listen-fire\/lang-/;
const VERSION_ROOT = /^packages\/lang-[^/]+$/;
const VERSION_ROOTS = [...CONSUMER_ROOTS, 'apps/web/src', 'apps/admin/src'].filter((root) =>
  fs.existsSync(path.join(repoRoot, root)),
);

/** The compatibility key of a release (movement-lang `compatibilityKey`): the
 *  minor under 0.x, the major from 1.0. */
function keyOf(version) {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (match === null) return undefined;
  return match[1] === '0' ? `0.${match[2]}` : match[1];
}

/** The current release: the workspace catalog's core, which every consumer
 *  outside a version package imports. */
const currentKey = (() => {
  const catalog = fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const match = /^\s*"@listen-fire\/movement-lang":\s*([0-9][^\s]*)/m.exec(catalog);
  if (match === null) throw new Error('version boundary: the workspace catalog names no @listen-fire/movement-lang');
  return keyOf(match[1]);
})();

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** The package directory `name` resolves to from `dir`, by Node's walk, or null. */
const resolvedCache = new Map();
function resolvePackage(dir, name) {
  const cacheKey = `${dir}\0${name}`;
  if (resolvedCache.has(cacheKey)) return resolvedCache.get(cacheKey);
  let found = null;
  for (let at = dir; ; at = path.dirname(at)) {
    const candidate = path.join(at, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      found = fs.realpathSync(candidate);
      break;
    }
    if (path.dirname(at) === at) break;
  }
  resolvedCache.set(cacheKey, found);
  return found;
}

/** The language versions (compatibility keys) a package belongs to: its own
 *  release when it is a core package, else the releases of the core packages
 *  it declares, as they resolve from its directory (an alias counts by the
 *  package it names). */
const versionsCache = new Map();
function versionsOf(packageDir) {
  if (versionsCache.has(packageDir)) return versionsCache.get(packageDir);
  const keys = new Set();
  const manifest = readManifest(packageDir);
  if (manifest !== undefined) {
    if (CORE.has(manifest.name)) {
      keys.add(keyOf(manifest.version));
    } else {
      const declared = { ...manifest.peerDependencies, ...manifest.dependencies };
      for (const dependency of Object.keys(declared)) {
        const dependencyDir = resolvePackage(packageDir, dependency);
        const resolved = dependencyDir === null ? undefined : readManifest(dependencyDir);
        if (resolved !== undefined && CORE.has(resolved.name)) keys.add(keyOf(resolved.version));
      }
    }
  }
  versionsCache.set(packageDir, keys);
  return keys;
}

/** The package a bare specifier names (`@scope/name` or `name`); null for a
 *  relative path or a builtin. */
function packageNameOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const crossings = [];
for (const root of VERSION_ROOTS) {
  if (VERSION_ROOT.test(root)) continue;
  const rootDir = path.join(repoRoot, root);
  for (const file of sourceFiles(rootDir)) {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
    const relative = `${root}/${path.relative(rootDir, file).split(path.sep).join('/')}`;
    for (const { specifier, line } of specifiersIn(parsed)) {
      const name = packageNameOf(specifier);
      if (name === null) continue;
      if (VERSION_PACKAGE.test(name)) {
        if (root !== REGISTRY_ROOT) crossings.push({ file: relative, line, specifier, why: `only ${REGISTRY_ROOT} imports a version package` });
        continue;
      }
      const packageDir = resolvePackage(path.dirname(file), name);
      if (packageDir === null) continue;
      const foreign = [...versionsOf(packageDir)].filter((key) => key !== currentKey);
      if (foreign.length > 0) {
        crossings.push({ file: relative, line, specifier, why: `it resolves to language ${foreign.join(', ')}, not the current ${currentKey}` });
      }
    }
  }
}

console.log(`version boundary: current language ${currentKey}; ${crossings.length} imports across versions`);
for (const { file, line, specifier, why } of crossings) console.error(`  ${file}:${line}  ${specifier}: ${why}`);

if (grown.length > 0) {
  console.error('engine boundary: FAILED, imports of engine internals grew past the baseline:');
  for (const line of grown) console.error(`  ${line}`);
  console.error('Import from movement-engine/public/* instead, or add the answer to a public entry.');
}
if (crossings.length > 0) {
  console.error(
    `version boundary: FAILED. Reach another language version only through ${REGISTRY_ROOT}, which loads its package.`,
  );
}
if (grown.length > 0 || crossings.length > 0) process.exit(1);
