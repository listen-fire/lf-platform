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
//   node scripts/check-engine-boundary.cjs            report / gate
//   node scripts/check-engine-boundary.cjs --update   rewrite the baseline
//   node scripts/check-engine-boundary.cjs --list     also list every site

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
/** Every tree that consumes the engine, relative to the repo root. */
const CONSUMER_ROOTS = [
  'apps/api/src',
  ...['packages', 'modules'].flatMap((dir) =>
    fs
      .readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${dir}/${e.name}`),
  ),
].filter((root) => fs.existsSync(path.join(repoRoot, root)));
const baselineFile = path.join(__dirname, 'engine-boundary-baseline.json');

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
if (grown.length > 0) {
  console.error('engine boundary: FAILED, imports of engine internals grew past the baseline:');
  for (const line of grown) console.error(`  ${line}`);
  console.error('Import from movement-engine/public/* instead, or add the answer to a public entry.');
  process.exit(1);
}
if (total < baseline.total) {
  console.log('engine boundary: below baseline; run with --update to lock in the lower count.');
}
