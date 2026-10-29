// The CLI requires the command modules a run will load before clime does, so a
// command that cannot load says why rather than clime's retry's syntax error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { requireCommandModules } from '../load_commands';

let commandsDir: string;

beforeEach(() => {
  commandsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-commands-'));
  fs.writeFileSync(path.join(commandsDir, 'works.js'), 'globalThis.__loaded = [...(globalThis.__loaded ?? []), "works"];');
  fs.writeFileSync(path.join(commandsDir, 'broken.js'), 'throw new Error("DATABASE_URL is not set");');
  fs.writeFileSync(path.join(commandsDir, 'works.d.ts'), 'export {};');
  (globalThis as { __loaded?: string[] }).__loaded = [];
});

afterEach(() => {
  fs.rmSync(commandsDir, { recursive: true, force: true });
});

function load(...args: string[]): void {
  requireCommandModules({ commandsDir, extension: '.js', argv: ['node', 'cli.js', ...args] });
}

describe('loading the commands a run needs', () => {
  it('lets a named command’s own load error out', () => {
    expect(() => load('broken', '--help')).toThrow('DATABASE_URL is not set');
  });

  it('loads only the named command', () => {
    load('works', '--team', 'team-1');

    expect((globalThis as { __loaded?: string[] }).__loaded).toEqual(['works']);
  });

  it('leaves an unknown command for clime to report', () => {
    expect(() => load('nope')).not.toThrow();
  });

  it('loads every command for the listing, so a broken one says why there too', () => {
    expect(() => load('--help')).toThrow('DATABASE_URL is not set');
  });
});
