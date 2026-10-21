// The wasm side of the check-answer parity (answers.sh): replays every record
// of the checker parity's corpus (`reference.jsonl`) through the committed
// artifact's `checkAnswerInRust` and compares its stamps and import link with
// the TypeScript's (`answers.jsonl`, from answer_reference.ts). Stamps compare
// as a set (the engine files them by path); a link's libraries by path.
//
// A program whose check blocks never runs, so its answer reaches no engine:
// the counts say how many of the programs that would run agree.
//
// Usage (answers.sh does this): node -r <ts-node>/register/transpile-only parity/answer_compare.ts <work-dir>
import { checkAnswerInRust } from 'movement-lang/checker/rust_checker';
import type { CatalogSnapshot } from 'movement-lang/service/snapshot';
import { canonical } from '../conformance/checks_corpus';

declare function require(id: string): any;
declare const process: { argv: string[] };
const fs = require('fs');
const path = require('path');

const work = process.argv[2];
const table = new Map<string, CatalogSnapshot>();
for (const line of fs.readFileSync(path.join(work, 'snapshots.jsonl'), 'utf8').split('\n')) {
  if (line === '') continue;
  const row = JSON.parse(line);
  table.set(row.key, row.snapshot);
}
const lines = (file: string): string[] => fs.readFileSync(path.join(work, file), 'utf8').split('\n').filter((l: string) => l !== '');
const reference = lines('reference.jsonl');
const answers = lines('answers.jsonl');

interface Tally { records: number; stampsEqual: number; linksEqual: number }
const running: Tally = { records: 0, stampsEqual: 0, linksEqual: 0 };
const blocked: Tally = { records: 0, stampsEqual: 0, linksEqual: 0 };
let skipped = 0;
let crashed = 0;
const samples: string[] = [];

/** A link with its libraries in path order. */
function normalLink(link: unknown): string {
  if (typeof link !== 'object' || link === null) return 'null';
  const files = 'files' in link && Array.isArray(link.files) ? [...link.files] : undefined;
  files?.sort((a, b) => String(a?.path).localeCompare(String(b?.path)));
  return canonical(files === undefined ? link : { ...link, files });
}

reference.forEach((line, i) => {
  const record = JSON.parse(line);
  const ts = JSON.parse(answers[i] ?? '{"error":"no answer"}');
  const snapshot = table.get(record.snapshot);
  if (snapshot === undefined || ts.error !== undefined) {
    skipped += 1;
    return;
  }
  let wasm;
  try {
    wasm = checkAnswerInRust(record.source, snapshot, {
      languageVersion: record.version,
      ...(record.upgradingFrom !== undefined ? { upgradingFrom: record.upgradingFrom } : {}),
    });
  } catch {
    crashed += 1;
    return;
  }
  const tally = ts.blocked === true ? blocked : running;
  tally.records += 1;
  const set = (stamps: unknown[]) => new Set(stamps.map(s => canonical(s)));
  const tsStamps = set(ts.stamps);
  const wasmStamps = set(wasm.stamps);
  const stampsEqual = tsStamps.size === wasmStamps.size && [...tsStamps].every(s => wasmStamps.has(s));
  const linkEqual = normalLink(ts.link) === normalLink(wasm.link);
  if (stampsEqual) tally.stampsEqual += 1;
  if (linkEqual) tally.linksEqual += 1;
  if ((!stampsEqual || !linkEqual) && samples.length < 60) {
    let text = `## v${record.version} blocked=${ts.blocked} ${record.corpus}\n`;
    for (const s of tsStamps) if (!wasmStamps.has(s)) text += `  only ts:   ${s}\n`;
    for (const s of wasmStamps) if (!tsStamps.has(s)) text += `  only wasm: ${s}\n`;
    if (!linkEqual) text += `  link ts:   ${normalLink(ts.link)}\n  link wasm: ${normalLink(wasm.link)}\n`;
    samples.push(`${text}${record.source}\n`);
  }
});
fs.writeFileSync(path.join(work, 'answer_samples.txt'), samples.join('\n'));
for (const [what, t] of [['would run', running], ['blocked by the check', blocked]] as const) {
  console.log(`${what}: ${t.records} records; stamps equal ${t.stampsEqual}; links equal ${t.linksEqual}`);
}
console.log(`skipped ${skipped} (snapshot or the TypeScript failed); crashed ${crashed}; samples in ${work}/answer_samples.txt`);
