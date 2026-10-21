#!/usr/bin/env node
// The split boundary check. The repo is allocated to two future repos
// (scripts/split-allocation.json): the language and the platform. A violation
// is a file on the language side that imports a file on the platform side, by
// workspace package name, by a package.json alias (`#shared`, `movement-engine`)
// or by relative path. Test files count.
//
//   node scripts/check-split-boundary.cjs            exit 1 on any violation
//   node scripts/check-split-boundary.cjs --report   print the count, exit 0
//   node scripts/check-split-boundary.cjs --list     also print each site

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'target', '.git']);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The directories the workspace globs name: `dir/*` expands one level, a literal is itself. */
function workspaceDirectories(repoRoot) {
  const file = path.join(repoRoot, 'pnpm-workspace.yaml');
  if (!fs.existsSync(file)) return [];
  const globs = [...fs.readFileSync(file, 'utf8').matchAll(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  const found = [];
  for (const glob of globs) {
    if (glob.endsWith('/*')) {
      const parent = path.join(repoRoot, glob.slice(0, -2));
      if (!fs.existsSync(parent)) continue;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(parent, entry.name, 'package.json'))) {
          found.push(toPosix(path.relative(repoRoot, path.join(parent, entry.name))));
        }
      }
    } else if (fs.existsSync(path.join(repoRoot, glob, 'package.json'))) {
      found.push(glob);
    }
  }
  return found;
}

/** The declared name a `workspace:` dependency value points at, or null for any other value. */
function workspaceTarget(alias, value) {
  if (typeof value !== 'string' || !value.startsWith('workspace:')) return null;
  const spec = value.slice('workspace:'.length);
  if (spec === '*' || spec === '^' || spec === '~') return alias;
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : alias;
}

/** Every way an import can name a workspace package, as specifier prefix -> package directory. */
function buildAliasTables(repoRoot, directories) {
  const nameToDirectory = new Map();
  const manifests = new Map();
  for (const dir of directories) {
    const manifest = readJson(path.join(repoRoot, dir, 'package.json'));
    if (!manifest) continue;
    manifests.set(dir, manifest);
    if (manifest.name) nameToDirectory.set(manifest.name, dir);
  }
  const byBasename = (name) => directories.find((dir) => dir.split('/').pop() === name.replace(/^@[^/]+\//, ''));
  const resolveName = (name) => nameToDirectory.get(name) ?? byBasename(name) ?? null;

  const aliasesByPackage = new Map();
  for (const [dir, manifest] of manifests) {
    const aliases = new Map();
    for (const group of [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]) {
      for (const [alias, value] of Object.entries(group ?? {})) {
        const name = workspaceTarget(alias, value);
        const target = name === null ? null : resolveName(name);
        if (target !== null) aliases.set(alias, target);
      }
    }
    aliasesByPackage.set(dir, aliases);
  }
  return { nameToDirectory, aliasesByPackage };
}

/** Longest allocated prefix of a repo-relative path, or null when the path is not allocated. */
function rootOf(relative, allocation) {
  let best = null;
  for (const side of ['language', 'platform']) {
    for (const prefix of allocation[side]) {
      // An import usually omits the extension of the file it reaches.
      const extensionless = prefix.replace(/\.[^./]+$/, '');
      if (relative === prefix || relative === extensionless || relative.startsWith(`${prefix}/`)) {
        if (best === null || prefix.length > best.prefix.length) best = { side, prefix };
      }
    }
  }
  return best === null ? null : best.side;
}

function sourceFiles(repoRoot, directory = repoRoot, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (toPosix(path.relative(repoRoot, full)) === '.claude/worktrees') continue;
      sourceFiles(repoRoot, full, found);
    } else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
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
      if (isRequire || callee.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The repo-relative path an import reaches, or null when it is not a workspace or relative import. */
function targetOf(specifier, fromFile, { repoRoot, directories, tables }) {
  if (specifier.startsWith('.')) {
    return toPosix(path.relative(repoRoot, path.resolve(path.dirname(fromFile), specifier)));
  }
  const fromRelative = toPosix(path.relative(repoRoot, fromFile));
  const owner = directories
    .filter((dir) => fromRelative.startsWith(`${dir}/`))
    .sort((a, b) => b.length - a.length)[0];
  const candidates = [];
  if (owner !== undefined) {
    for (const [alias, dir] of tables.aliasesByPackage.get(owner) ?? []) candidates.push([alias, dir]);
  }
  for (const [name, dir] of tables.nameToDirectory) candidates.push([name, dir]);
  let best = null;
  for (const [name, dir] of candidates) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      if (best === null || name.length > best.name.length) best = { name, dir };
    }
  }
  if (best === null) return null;
  const subpath = specifier.slice(best.name.length).replace(/^\//, '');
  return subpath === '' ? best.dir : `${best.dir}/${subpath}`;
}

function run(repoRoot, allocation) {
  const directories = workspaceDirectories(repoRoot);
  const tables = buildAliasTables(repoRoot, directories);
  const context = { repoRoot, directories, tables };
  const violations = [];
  for (const file of sourceFiles(repoRoot)) {
    const relative = toPosix(path.relative(repoRoot, file));
    if (rootOf(relative, allocation) !== 'language') continue;
    const parsed = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
    for (const { specifier, line } of specifiersIn(parsed)) {
      const target = targetOf(specifier, file, context);
      if (target !== null && rootOf(target, allocation) === 'platform') {
        violations.push({ file: relative, line, target });
      }
    }
  }
  return { violations };
}

module.exports = { run };

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');
  const allocation = readJson(path.join(__dirname, 'split-allocation.json'));
  const { violations } = run(repoRoot, allocation);
  if (args.has('--list')) {
    for (const { file, line, target } of violations) console.log(`${file}:${line}  →  ${target}`);
  }
  console.log(`split boundary: ${violations.length} imports from the language side into the platform side`);
  if (violations.length > 0 && !args.has('--report')) process.exit(1);
}
