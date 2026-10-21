// The engine's purity, pinned. A pure engine file reaches the database, the
// model provider, billing, adapter implementations and run recording only
// through the `EngineHost` it is handed — never by importing them. That is
// what lets an embedder (a test, the browser, another process) run the engine
// on a host of its own (DESIGN §6). The platform guards its own side of the
// seam (the legacy engine, the host implementations) in its tests.
//
// Imports are read with the TypeScript compiler, not a regex, so a multi-line
// import or an `import { type X }` is classified the way the compiler sees it.
// Type-only imports are allowed from anywhere: they vanish at compile time.

import { builtinModules } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { HOST_FAMILIES, hostMethodPaths } from '../../../public/host';

/** The engine package, its paths mirroring the platform's `apps/api/src`. */
const PKG_DIR = path.resolve(__dirname, '../../..');
const ENGINE_DIR = path.join(PKG_DIR, 'services/movement_engine');
const REPO_DIR = path.resolve(PKG_DIR, '../..');

/** Engine files that must import no host code. */
const PURE_FILES = [
  'address.ts',
  'ai_tiers.ts',
  'binding.ts',
  'call_depth.ts',
  'errors.ts',
  'host.ts',
  'host_adapter.ts',
  'program_check.ts',
  'provenance.ts',
  'rust_engine.ts',
  'rust_host.ts',
  'rust_run.ts',
  'rust_stats.ts',
  'rust_wire.ts',
  'run_types.ts',
  'segment_context.ts',
  'segment_limits.ts',
];

/** The kit every host builds on: it implements the host, so it is not held to
 *  the rule, but it is the one other file the engine package keeps here. */
const HOST_KIT_FILES = ['host_kit.ts', 'test_host.ts'];

/** The platform's host implementations (they wire the engine to Postgres, the
 *  work queue and the run recorder), by name: no engine file may import one. */
const HOST_SIDE_FILES = [
  ...HOST_KIT_FILES,
  'await_description.ts',
  'await_resume.ts',
  'await_wake.ts',
  'callback_fire.ts',
  'callback_sink.ts',
  'callback_store.ts',
  'cancel_gate.ts',
  'limit_pause.ts',
  'limit_resume.ts',
  'park_sink.ts',
  'resume_step.ts',
  'run_engine_record.ts',
  'run_host.ts',
  'run_host_store.ts',
  'run_lease.ts',
  'single_flight.ts',
  'timer_resume.ts',
];

/** A movement_engine file of the engine package. */
function engineFile(file: string): string {
  return path.join(ENGINE_DIR, file);
}

/** The host-side modules that turn a file descriptor into bytes, or bytes
 *  into a URL. */
const BYTE_READERS = ['retrieve', 'redeem', 'expose', 'fetch-stream'];

/** Module paths are relative to apps/api/src, without extension. */
const FORBIDDEN: Array<{ matches: (module: string) => boolean; reason: string }> = [
  { matches: under('lib/kysely'), reason: 'the database client (the host owns storage)' },
  { matches: under('generated/kysely'), reason: 'generated database code (types only)' },
  { matches: under('generated/prisma'), reason: 'generated database code (types only)' },
  { matches: (m) => m === 'prisma' || m.startsWith('@prisma/'), reason: 'the database client' },
  { matches: under('lib/anthropic'), reason: 'the model provider (the host supplies `llm`)' },
  { matches: under('lib/llm_usage'), reason: 'billing context (the host wraps model calls)' },
  {
    matches: under('lib/run_spend'),
    reason:
      "a priced call's spend meter (the host meters its calls; the engine keeps the run's ledger)",
  },
  {
    matches: under('services/translation_graph/segment_scope'),
    reason: "a segment's host scope (the engine holds only the segment's id)",
  },
  {
    matches: under('services/translation_graph/adapters'),
    reason: 'adapter implementations (the host supplies `adapters`)',
  },
  {
    matches: under('services/translation_graph/runs'),
    reason: 'run recording (the host supplies `trace`)',
  },
  { matches: under('services/translation_graph/movement'), reason: 'the production host itself' },
  { matches: under('services/document'), reason: 'document storage (the host supplies `files`)' },
  {
    matches: (m) =>
      BYTE_READERS.some((reader) => m === `services/translation_graph/engine/files/${reader}`),
    reason: 'a file byte reader (bytes stay on the host: the engine holds descriptors)',
  },
  { matches: under('services/work'), reason: 'the work queue (the host supplies `park`)' },
  { matches: under('services/interaction'), reason: 'run failure reporting (host side)' },
  { matches: under('services/webhook_sync'), reason: 'inbound sync (host side)' },
  {
    matches: (m) =>
      HOST_SIDE_FILES.some((f) => m === `services/movement_engine/${f.replace(/\.ts$/, '')}`),
    reason: 'a host-side movement_engine module',
  },
];

const ALLOWED: Array<(module: string) => boolean> = [
  (m) => m === 'movement-lang' || m.startsWith('movement-lang/'),
  // The contracts the engine speaks: data shapes and the protocol schema.
  (m) => m === 'engine-contracts' || m.startsWith('engine-contracts/'),
  (m) => m === 'zod',
  (m) => m.startsWith('node:') || builtinModules.includes(m),
  under('lib/utils'),
  // The spend vocabulary both sides speak: budgets, cost lines, the cap.
  under('lib/run_cost'),
  under('lib/models'),
  under('lib/prompts'),
  under('services/logger'),
  // Shared engine helpers that are pure computation over engine data:
  // resource stamping and filtering, the model choice for an extraction's
  // size.
  (m) => m === 'services/translation_graph/engine/files/resources',
  (m) => m === 'services/translation_graph/engine/batched_extraction/model_choice',
  under('services/translation_graph/uniqueness'),
  under('services/translation_graph/required_fields'),
  under('services/translation_graph/types'),
  under('services/translation_graph/mutation_context'),
  // The adapter protocol: the contract the engine calls adapters through, no
  // implementation.
  under('services/translation_graph/adapter'),
  (m) => PURE_FILES.some((f) => m === `services/movement_engine/${f.replace(/\.ts$/, '')}`),
];

/** Shared helpers on the engine's path that live outside this directory:
 *  held to the same no-clock, no-mint rule as the pure files. */
const PURE_HELPERS = [path.join(PKG_DIR, 'services/translation_graph/engine/files/resources.ts')];

/** `a.b.c` for a chain of property reads off an identifier; undefined for
 *  anything else (a call, an element access). */
function propertyPath(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const base = propertyPath(node.expression);
    return base === undefined ? undefined : `${base}.${node.name.text}`;
  }
  return undefined;
}


/** Every place `file` reads a clock or mints an id itself, as `line: what`.
 *  The engine asks the host for both (`clock.now`, `ids.mint`), so a
 *  recorded run replays to the same instants and ids. */
function entropyReads(file: string, text = fs.readFileSync(file, 'utf8')): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const reads: string[] = [];
  const at = (node: ts.Node, what: string): void => {
    reads.push(`${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${what}`);
  };
  // Local names bound to the crypto module itself (a default or namespace
  // import): a `random*` member read off one is a mint.
  const cryptoNames = new Set(['crypto']);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      if (module === 'uuid' || module === 'nanoid' || module.startsWith('uuid/')) at(node, `imports '${module}'`);
      if (module === 'crypto' || module === 'node:crypto') {
        const clause = node.importClause;
        if (clause?.name !== undefined) cryptoNames.add(clause.name.text);
        const bindings = clause?.namedBindings;
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const name = (element.propertyName ?? element.name).text;
            if (name.startsWith('random')) at(node, `imports ${name} from '${module}'`);
          }
        } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          cryptoNames.add(bindings.name.text);
        }
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const read = propertyPath(node);
      const [head, second, third] = read?.split('.') ?? [];
      if (
        read === 'Date.now' ||
        read === 'Math.random' ||
        read === 'performance.now' ||
        read === 'process.hrtime' ||
        read === 'process.hrtime.bigint' ||
        (head !== undefined && cryptoNames.has(head) && second?.startsWith('random') === true && third === undefined) ||
        (head === 'globalThis' && second === 'crypto' && third !== undefined)
      ) {
        at(node, read ?? '');
        return;
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Date' &&
      (node.arguments === undefined || node.arguments.length === 0)
    ) {
      at(node, 'new Date()');
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
      at(node, 'Date()');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

function under(prefix: string): (module: string) => boolean {
  return (m) => m === prefix || m.startsWith(`${prefix}/`);
}

/** A relative specifier becomes a path under the engine package (which mirrors
 *  apps/api/src); a bare one stays, but the package's own. */
function moduleOf(fromFile: string, specifier: string): string {
  if (specifier.startsWith('movement-engine/')) return specifier.slice('movement-engine/'.length);
  if (!specifier.startsWith('.')) return specifier;
  const resolved = path.relative(PKG_DIR, path.resolve(path.dirname(fromFile), specifier));
  return resolved
    .split(path.sep)
    .join('/')
    .replace(/\.(ts|js)$/, '')
    .replace(/\/index$/, '');
}

/** Every specifier the file loads at run time, with the value names it takes
 *  from it when it names them (undefined: the whole module). */
function valueImports(file: string): Array<{ specifier: string; names?: string[] }> {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports: Array<{ specifier: string; names?: string[] }> = [];
  const valueNames = (elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): string[] =>
    elements.filter((element) => !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const named = clause !== undefined && clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings);
        imports.push({ specifier: node.moduleSpecifier.text, ...(named ? { names: valueNames(bindings.elements) } : {}) });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!isTypeOnlyExport(node)) {
        const clause = node.exportClause;
        const named = clause !== undefined && ts.isNamedExports(clause);
        imports.push({ specifier: node.moduleSpecifier.text, ...(named ? { names: valueNames(clause.elements) } : {}) });
      }
    } else if (ts.isCallExpression(node) && isLoaderCall(node)) {
      const [arg] = node.arguments;
      if (arg !== undefined && ts.isStringLiteralLike(arg)) imports.push({ specifier: arg.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

/** The engine's embedders reach it through its public entries
 *  (`movement-engine/public/<entry>`), which re-export the engine's modules.
 *  The seam is about those modules, so an import of an entry is judged by the
 *  module each name it takes comes from (or every module the entry re-exports
 *  when it takes the whole entry). A name the entry declares itself stays
 *  `public/<entry>`, which no rule allows. */
function throughPublicEntry(specifier: string, names: string[] | undefined): string[] {
  const entry = /^movement-engine\/(public\/[a-z-]+)$/.exec(specifier)?.[1];
  if (entry === undefined) return [specifier];
  const sources = exportSources(path.join(PKG_DIR, `${entry}.ts`));
  if (names === undefined) return [...new Set([...sources.values()].map((module) => `movement-engine/${module}`))];
  return [...new Set(names.map((name) => `movement-engine/${sources.get(name) ?? entry}`))];
}

/** Each value name a module exports, with the module (relative to the engine
 *  package, or bare) it comes from; `export *` is followed. */
function exportSources(file: string): Map<string, string> {
  const own = path.relative(PKG_DIR, file).split(path.sep).join('/').replace(/\.ts$/, '');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const sources = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (statement.moduleSpecifier === undefined) {
        // `export { name }` of the module's own declaration.
        if (clause !== undefined && ts.isNamedExports(clause)) {
          for (const element of clause.elements) if (!element.isTypeOnly) sources.set(element.name.text, own);
        }
        continue;
      }
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const bare = !specifier.startsWith('.');
      const target = bare ? undefined : path.resolve(path.dirname(file), specifier);
      const targetFile = bare
        ? resolvedFrom(file, specifier)
        : [`${target}.ts`, path.join(target ?? '', 'index.ts')].find((f) => fs.existsSync(f));
      // A bare package keeps its own name: the seam's rules speak of packages
      // by name (`engine-contracts`, `movement-lang`).
      const module =
        bare || targetFile === undefined
          ? specifier
          : path.relative(PKG_DIR, targetFile).split(path.sep).join('/').replace(/(\/index)?\.ts$/, '');
      if (clause === undefined) {
        if (targetFile === undefined) continue;
        for (const [name, from] of exportSources(targetFile)) sources.set(name, bare || from === targetOwn(targetFile) ? module : from);
        for (const name of declaredValueExports(targetFile)) sources.set(name, module);
      } else if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) if (!element.isTypeOnly) sources.set(element.name.text, module);
      }
    }
  }
  return sources;
}

/** A module's own name as `exportSources` labels its declarations. */
function targetOwn(file: string): string {
  return path.relative(PKG_DIR, file).split(path.sep).join('/').replace(/\.ts$/, '');
}

/** The source file a bare specifier names, resolved from `file`'s package. */
function resolvedFrom(file: string, specifier: string): string | undefined {
  try {
    const resolved = require.resolve(specifier, { paths: [path.dirname(file)] });
    return resolved.endsWith('.ts') ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** The value names a module declares and exports itself. */
function declaredValueExports(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const exported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  return source.statements.flatMap((statement) => {
    if (!exported(statement)) return [];
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      return [statement.name.text];
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
    }
    return [];
  });
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  );
}

function isLoaderCall(node: ts.CallExpression): boolean {
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require')
  );
}


describe('the engine/host seam', () => {
  it('classifies every movement_engine file of the engine package as pure or host kit, exactly once', () => {
    const onDisk = fs
      .readdirSync(ENGINE_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .sort();
    const listed = [...PURE_FILES, ...HOST_KIT_FILES].sort();
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual(onDisk);
  });

  it('pure engine files import no host code', () => {
    const violations: string[] = [];
    for (const file of PURE_FILES) {
      const filePath = path.join(ENGINE_DIR, file);
      for (const { specifier: written, names } of valueImports(filePath)) {
        for (const specifier of throughPublicEntry(written, names)) {
          const module = moduleOf(filePath, specifier);
          const via = specifier === written ? '' : ` (through '${written}')`;
          const forbidden = FORBIDDEN.find((rule) => rule.matches(module));
          if (forbidden !== undefined) {
            violations.push(`${file} imports '${specifier}'${via}: ${forbidden.reason}`);
          } else if (!ALLOWED.some((allowed) => allowed(module))) {
            violations.push(
              `${file} imports '${specifier}'${via}: not on the seam's allow list (reach it through the host, or allow it here with the reason)`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('pure engine files read no clock and mint no id of their own', () => {
    const violations = [...PURE_FILES.map(engineFile), ...PURE_HELPERS].flatMap((file) =>
      entropyReads(file).map((read) => `${path.relative(PKG_DIR, file)}:${read}`),
    );
    expect(violations).toEqual([]);
  });

  it('flags each way of reading a clock or minting an id', () => {
    const probe = [
      "import { randomUUID } from 'node:crypto';",
      "import { v4 } from 'uuid';",
      'const a = Date.now();',
      'const b = new Date();',
      'const c = Math.random();',
      'const d = crypto.randomUUID();',
      'const e = performance.now();',
      "const f = new Date('2026-10-07T09:00:00.000Z');",
      'function pinnedNow() { return new Date(); }',
      "import nodeCrypto from 'node:crypto';",
      'const g = nodeCrypto.randomBytes(4);',
      'const h = globalThis.crypto.getRandomValues(new Uint8Array(4));',
      'const i = Date();',
      'const j = process.hrtime();',
      'const k = process.hrtime.bigint();',
      "import * as cryptoModule from 'crypto';",
      'const l = cryptoModule.randomInt(3);',
    ].join('\n');
    expect(entropyReads(path.join(ENGINE_DIR, 'probe.ts'), probe)).toEqual([
      "1: imports randomUUID from 'node:crypto'",
      "2: imports 'uuid'",
      '3: Date.now',
      '4: new Date()',
      '5: Math.random',
      '6: crypto.randomUUID',
      '7: performance.now',
      '9: new Date()',
      '11: nodeCrypto.randomBytes',
      '12: globalThis.crypto.getRandomValues',
      '13: Date()',
      '14: process.hrtime',
      '15: process.hrtime.bigint',
      '17: cryptoModule.randomInt',
    ]);
  });

  it('flags a value import from host code and lets a type-only one through', () => {
    const probe = path.join(ENGINE_DIR, 'probe.ts');
    const classify = (text: string) => {
      const source = ts.createSourceFile(probe, text, ts.ScriptTarget.Latest, true);
      const [statement] = source.statements;
      if (statement === undefined || !ts.isImportDeclaration(statement)) {
        throw new Error('probe must be one import');
      }
      return isTypeOnlyImport(statement);
    };
    expect(classify(`import { getQb } from '../../lib/kysely';`)).toBe(false);
    expect(classify(`import type { Kysely } from '../../lib/kysely';`)).toBe(true);
    expect(classify(`import { type Kysely } from '../../lib/kysely';`)).toBe(true);
    expect(classify(`import { type Kysely, getQb } from '../../lib/kysely';`)).toBe(false);
    expect(classify(`import '../../lib/kysely';`)).toBe(false);
    expect(moduleOf(probe, '../../lib/kysely')).toBe('lib/kysely');
    expect(FORBIDDEN.some((rule) => rule.matches(moduleOf(probe, './park_sink')))).toBe(true);
    expect(
      FORBIDDEN.some((rule) =>
        rule.matches(moduleOf(probe, '../translation_graph/engine/files/retrieve')),
      ),
    ).toBe(true);
    expect(FORBIDDEN.some((rule) => rule.matches(moduleOf(probe, 'movement-engine/lib/run_spend')))).toBe(
      true,
    );
    expect(
      FORBIDDEN.some((rule) => rule.matches(moduleOf(probe, '../translation_graph/segment_scope'))),
    ).toBe(true);
  });
});

// ── Generated database code ─────────────────────────────────────────────────
//
// The engine, the contracts it speaks, the test host and the adapter
// protocol's server kit are what an embedder imports without the run host.
// None of them may reach the run host's generated database code, not even by
// a type: a type import still loads the module for the compiler, so an
// embedder compiling against them would need the run host's schema.

const CONTRACTS_DIR = path.join(REPO_DIR, 'packages/engine-contracts');

/** The roots an embedder imports. */
const EMBEDDABLE_ROOTS = [
  ...PURE_FILES.map(engineFile),
  engineFile('test_host.ts'),
  path.join(REPO_DIR, 'packages/module-kit/index.ts'),
  path.join(CONTRACTS_DIR, 'index.ts'),
];

/** A resolved file or bare specifier that is generated database code or a
 *  database client. */
function isDatabaseCode(resolvedOrSpecifier: string): boolean {
  return (
    /\/src\/generated\//.test(resolvedOrSpecifier) ||
    /\/src\/prisma(\/|\.ts$|$)/.test(resolvedOrSpecifier) ||
    /\/src\/lib\/kysely\.ts$/.test(resolvedOrSpecifier) ||
    /\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(kysely|@prisma|\.prisma)\//.test(resolvedOrSpecifier) ||
    /^(kysely|@prisma\/|prisma$)/.test(resolvedOrSpecifier)
  );
}

/** Every specifier the file names, type-only ones included. */
function allImports(file: string, text = fs.readFileSync(file, 'utf8')): string[] {
  return ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
}

const RESOLUTION: ts.CompilerOptions = {
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
};

function resolved(specifier: string, fromFile: string): string | undefined {
  return ts.resolveModuleName(specifier, fromFile, RESOLUTION, ts.sys).resolvedModule?.resolvedFileName;
}

/** Source files this repo owns: followed. A library's own files are not. */
function isRepoSource(file: string): boolean {
  if (file.endsWith('.d.ts')) return false;
  const real = fs.realpathSync(file);
  return real.startsWith(REPO_DIR) && !real.includes('/node_modules/');
}

/** Every chain from a root to database code, as `root <= … <= file → specifier`. */
function databaseReach(roots: readonly string[]): string[] {
  const parent = new Map<string, string>();
  const seen = new Set(roots.map((r) => fs.realpathSync(r)));
  const queue = [...seen];
  const reach: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined) break;
    for (const specifier of allImports(file)) {
      const target = resolved(specifier, file);
      if (isDatabaseCode(specifier) || (target !== undefined && isDatabaseCode(target))) {
        const chain = [file];
        for (let at = parent.get(file); at !== undefined; at = parent.get(at)) chain.push(at);
        reach.push(`${chain.map((f) => path.relative(REPO_DIR, f)).join(' <= ')} → '${specifier}'`);
        continue;
      }
      if (target === undefined || !isRepoSource(target)) continue;
      const real = fs.realpathSync(target);
      if (seen.has(real)) continue;
      seen.add(real);
      parent.set(real, file);
      queue.push(real);
    }
  }
  return reach;
}

function contractFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__embed_smoke__') continue;
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (entry.name.endsWith('.ts')) files.push(at);
    }
  };
  walk(CONTRACTS_DIR);
  return files;
}


describe('generated database code stays out of what an embedder imports', () => {
  it('no pure engine file and no contract file imports database code, not even a type', () => {
    const violations: string[] = [];
    for (const file of [...PURE_FILES.map(engineFile), ...contractFiles()]) {
      for (const specifier of allImports(file)) {
        const target = resolved(specifier, file);
        if (isDatabaseCode(specifier) || (target !== undefined && isDatabaseCode(target))) {
          violations.push(`${path.relative(REPO_DIR, file)} imports '${specifier}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the contracts package imports nothing of the run host', () => {
    const violations: string[] = [];
    for (const file of contractFiles()) {
      for (const specifier of allImports(file)) {
        const target = resolved(specifier, file);
        if (target !== undefined && fs.realpathSync(target).startsWith(path.join(REPO_DIR, 'apps/'))) {
          violations.push(`${path.relative(REPO_DIR, file)} imports '${specifier}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the engine, the contracts, the test host and the module kit reach no database code, by any path', () => {
    expect(databaseReach(EMBEDDABLE_ROOTS)).toEqual([]);
  });

  it('a type import of generated code counts as reaching it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-guard-'));
    try {
      fs.mkdirSync(path.join(dir, 'src/generated/kysely/core'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/generated/kysely/core/Team.ts'), 'export type Team = string;\n');
      const root = path.join(dir, 'root.ts');
      fs.writeFileSync(root, "import type { Team } from './src/generated/kysely/core/Team';\nexport type T = Team;\n");
      expect(allImports(root)).toContain('./src/generated/kysely/core/Team');
      expect(databaseReach([root])).not.toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the host manifest is documented', () => {
  it('is the contract docs/contracts/host-families.md documents, method by method', () => {
    const doc = fs.readFileSync(path.join(REPO_DIR, 'docs/contracts/host-families.md'), 'utf8');
    const documented = [...doc.matchAll(/^#### `([A-Za-z.]+)`/gm)].map((match) => match[1]);
    expect(documented.sort()).toEqual(hostMethodPaths().sort());
    const families = [...doc.matchAll(/^### `([A-Za-z.]+)`/gm)].map((match) => match[1]);
    expect(families.sort()).toEqual(Object.keys(HOST_FAMILIES).sort());
  });
});
