// The package set is 0.15's all the way down: every package it names, and every
// core package those resolve as their peers, is from release 0.15. A module
// whose peer resolved to the current release would run 0.15 code against the
// current engine's objects and classes without a word.

import fs from 'node:fs';
import path from 'node:path';

import * as facade from '..';

const ROOT = path.resolve(__dirname, '..');
const CORE = ['@listen-fire/engine', '@listen-fire/engine-contracts', '@listen-fire/movement-lang'];

type Manifest = { name: string; version: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

function manifest(dir: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

/** The directory `name` resolves to from `dir`, by Node's own walk, or undefined. */
function resolvedFrom(dir: string, name: string): string | undefined {
  for (let at = dir; ; at = path.dirname(at)) {
    const candidate = path.join(at, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(at) === at) return undefined;
  }
}

function jsFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') jsFiles(full, found);
    else if (entry.isFile() && /\.c?js$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Whether `text` names the package `name` as a module specifier: quoted
 *  whole, or with a subpath (`'@listen-fire/engine/public/x'`), never as the
 *  prefix of another name (`@listen-fire/engine-contracts`). */
function namedIn(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`["'\`]${escaped}(?:/[^"'\`]*)?["'\`]`).test(text);
}

/**
 * The core packages a package declares or actually requires. An undeclared
 * require resolves through pnpm's hoisted fallback, which holds the current
 * release, so it is checked as strictly as a declared one.
 */
function coreUsedBy(dir: string): string[] {
  const { dependencies, peerDependencies } = manifest(dir);
  const used = new Set(CORE.filter((c) => c in (dependencies ?? {}) || c in (peerDependencies ?? {})));
  for (const file of jsFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const core of CORE) if (namedIn(text, core)) used.add(core);
  }
  return [...used];
}

/** The packages of the set: everything it names but the libraries its own
 *  copies of the platform's modules use, which carry no core of their own. */
const LIBRARIES: readonly string[] = ['zod'];
const named = Object.keys(manifest(ROOT).dependencies ?? {}).filter((n) => !LIBRARIES.includes(n));

describe('the 0.15 package set', () => {
  it('names its release', () => {
    expect(facade.LANGUAGE_VERSION).toBe('0.15.3');
  });

  it.each(CORE)('%s is 0.15.3', (name) => {
    const dir = resolvedFrom(ROOT, name);
    expect(dir && manifest(dir).version).toBe('0.15.3');
  });

  it.each(named.filter((n) => !CORE.includes(n)))('%s resolves the core it uses to 0.15.3', (name) => {
    const dir = resolvedFrom(ROOT, name);
    if (dir === undefined) throw new Error(`${name} is not installed`);
    const used = coreUsedBy(dir);
    expect(used.length).toBeGreaterThan(0);
    for (const core of used) {
      const coreDir = resolvedFrom(dir, core);
      expect([core, coreDir && manifest(coreDir).version]).toEqual([core, '0.15.3']);
    }
  });
});
