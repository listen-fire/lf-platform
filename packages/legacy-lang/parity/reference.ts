// The TypeScript side of the parity harness: every version 5 program the
// repository pins a check or a run for, checked by the platform's TypeScript
// checker as it is now, written as JSON lines for the wasm side (compare.ts)
// to replay. The language release serves version 5 only, so only version 5
// checks are compared; the older versions are the platform's alone.
//
//   - the checks corpus, as the harvest assembles it from the pin (which holds
//     no program text) and the programs it finds in their tests (target/checks/,
//     ../conformance/checks_pin.ts): every check under version 5, and again
//     under version 5 each program pinned at version 3 or 4, where it still
//     parses (what a move up would be checked as);
//   - the engine's pattern programs (crates/movement-engine/tests/oracle/
//     patterns.json), each in the version 5 spelling the Rust engine ran.
//
// Usage (run.sh does this): node -r <ts-node>/register/transpile-only parity/reference.ts <out-dir> [--checks <checks.json>] [--patterns <patterns.json>]
import { checkNow, loadChecks, loadSnapshots, type CheckRecord } from '../conformance/checks_corpus';
import { SNAPSHOT_TABLE_FILE } from '../conformance/checks_pin';
import { CURRENT_LANGUAGE_VERSION } from 'movement-lang/language_version';
import type { CatalogSnapshot } from 'movement-lang/service/snapshot';

declare function require(id: string): any;
declare const process: { argv: string[]; hrtime: { bigint(): bigint } };
const fs = require('fs');
const path = require('path');

const [out, ...flags] = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = flags.indexOf(name);
  return at === -1 ? undefined : flags[at + 1];
};
const checksFile = option('--checks');
const patternsFile = option('--patterns');
const VERSION = CURRENT_LANGUAGE_VERSION;

const table = loadSnapshots(SNAPSHOT_TABLE_FILE);
const lines: string[] = [];
let failed = 0;
const started = process.hrtime.bigint();
function emit(corpus: string, record: CheckRecord): void {
  let ts: unknown[];
  try {
    ts = checkNow(record, table);
  } catch {
    failed += 1; // a program that no longer parses under this version
    return;
  }
  const { source, snapshot, version, upgradingFrom } = record;
  lines.push(JSON.stringify({ corpus, source, snapshot, version, upgradingFrom, ts }));
}

if (checksFile !== undefined) {
  const records = loadChecks(checksFile).filter(r => r.note === undefined);
  for (const record of records) {
    // A move up from a version the language no longer serves is the
    // TypeScript checker's alone; a check that parsed under another version
    // than it checked has no counterpart in the wasm's check.
    if (record.version !== VERSION || record.upgradingFrom !== undefined || (record.parseVersion ?? VERSION) !== VERSION) continue;
    emit(`checks v${VERSION}`, record);
  }
  const moved = new Set<string>();
  for (const record of records) {
    if (record.version < 3 || record.version >= VERSION || record.upgradingFrom !== undefined) continue;
    const key = `${record.snapshot}\u0000${record.source}`;
    if (moved.has(key)) continue;
    moved.add(key);
    emit(`checks under v${VERSION}`, { ...record, version: VERSION, parseVersion: undefined, diagnostics: [] });
  }
}

if (patternsFile !== undefined) {
  const { PATTERNS_CATALOG, sourceOf } = require(path.join(path.dirname(path.resolve(patternsFile)), 'patterns_oracle.ts'));
  const patterns = JSON.parse(fs.readFileSync(patternsFile, 'utf8'));
  const seen = new Set<string>();
  for (const c of patterns.cases) {
    const program = c.program;
    if ((program.version ?? 3) !== VERSION) continue;
    const catalog = program.files !== undefined ? { ...PATTERNS_CATALOG, files: program.files } : PATTERNS_CATALOG;
    const key = `oracle:patterns:${program.files !== undefined ? JSON.stringify(program.files) : ''}`;
    (table as Map<string, CatalogSnapshot>).set(key, catalog);
    const source = sourceOf(program);
    if (seen.has(`${key}\u0000${source}`)) continue;
    seen.add(`${key}\u0000${source}`);
    emit('oracle patterns', { source, snapshot: key, version: VERSION, diagnostics: [] });
  }
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'reference.jsonl'), lines.join('\n') + '\n');
fs.writeFileSync(
  path.join(out, 'snapshots.jsonl'),
  [...table.entries()].map(([key, snapshot]) => JSON.stringify({ key, snapshot })).join('\n') + '\n',
);
const seconds = Number(process.hrtime.bigint() - started) / 1e9;
console.log(`typescript: ${lines.length} checks in ${seconds.toFixed(1)}s (${failed} skipped: no longer parse)`);
