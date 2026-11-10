// A connection or an automation stored with no statement admits nobody. The
// seeds, scripts and doors that mint them all go through the one place that
// states who may use the new row; a raw insert elsewhere is a thing nobody can
// reach, and nothing else would notice until someone tried.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '../../..');

/**
 * Per thing: how a raw insert of it reads, and the files allowed to do it with
 * what in the same file states the new row in the same transaction. A file
 * absent from here may not insert at all.
 */
const GUARDS = [
  {
    thing: 'connection',
    insert: /insertInto\(\s*['"](?:automations\.)?external_service_credentials['"]\s*\)/,
    allowed: {
      'services/credentials/persist_credential.ts': 'stateAtCreation',
      'services/translation_graph/adapters/telegram/handshake.ts': 'stateAtCreation',
    } as Record<string, string | null>,
  },
  {
    thing: 'automation',
    insert: /insertInto\(\s*['"](?:automations\.)?movement['"]\s*\)/,
    allowed: {
      // The one row writer; every caller states what it created (a person's save in
      // `saveAutomation`, a run's in `stateRunCreation`), so it says nothing itself.
      'services/translation_graph/movement/store.ts': null,
      'scripts/dev/movement.ts': 'stateRunCreation',
    } as Record<string, string | null>,
  },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return entry === '__test__' || entry === 'generated' || entry === 'test' ? [] : sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe.each(GUARDS)('no $thing is inserted without saying who may reach it', ({ insert, allowed }) => {
  const inserting = sourceFiles(SRC)
    .filter((file) => insert.test(readFileSync(file, 'utf8')))
    .map((file) => relative(SRC, file));

  it('inserts only in the files that state it', () => {
    expect(inserting.filter((file) => !(file in allowed))).toEqual([]);
  });

  it.each(Object.entries(allowed).flatMap(([file, statedBy]) => (statedBy === null ? [] : [{ file, statedBy }])))(
    '$file states the new row in the same file',
    ({ file, statedBy }) => {
      expect(readFileSync(join(SRC, file), 'utf8')).toContain(statedBy);
    },
  );
});
