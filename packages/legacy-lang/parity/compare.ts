// The wasm side of the parity harness (run.sh): replays every check the
// TypeScript side wrote (`reference.jsonl`) through the language's committed
// artifact (movement-lang's wasm, `checkSourceInRust`) and compares, code by
// code, writing the table to PARITY.md beside this file.
//
// Per record, each diagnostic is paired with an identical one on the other
// side (matched); a leftover pair with the same code and span differs only in
// its message (message mismatch); what is still left is missing in the wasm
// or extra in it. Order is not compared here: the "exact" count says how many
// records also agree on it; the others are listed with both orders in
// `<work-dir>/reordered.txt`. Refused records (the artifact's parser or
// catalog would not take them) are listed by reason in `<work-dir>/refused.txt`.
//
// Usage (run.sh does this): node -r <ts-node>/register/transpile-only parity/compare.ts <work-dir>
import { checkSourceInRust, RustCheckRefused } from 'movement-lang/checker/rust_checker';
import type { CatalogSnapshot } from 'movement-lang/service/snapshot';
import { canonical } from '../conformance/checks_corpus';

declare function require(id: string): any;
declare const process: { argv: string[]; hrtime: { bigint(): bigint }; env: Record<string, string | undefined> };
const fs = require('fs');
const path = require('path');

type Plain = { code?: string; message?: string; span?: unknown };
interface Tally { ts: number; wasm: number; matched: number; missing: number; extra: number; mismatched: number }
interface Corpus { records: number; exact: number; sameSet: number }

const work = process.argv[2];
const OUT = path.join(__dirname, 'PARITY.md');
const SAMPLES = Number(process.env.PARITY_SAMPLES ?? 12);

const table = new Map<string, CatalogSnapshot>();
for (const line of fs.readFileSync(path.join(work, 'snapshots.jsonl'), 'utf8').split('\n')) {
  if (line === '') continue;
  const row = JSON.parse(line);
  table.set(row.key, row.snapshot);
}

const codes = new Map<string, Tally>();
const corpora = new Map<string, Corpus>();
const samples = new Map<string, string[]>();
const reordered: string[] = [];
const refusals = new Map<string, { count: number; example: string }>();
let refused = 0;
let crashed = 0;
const tally = (code: string): Tally => {
  let t = codes.get(code);
  if (t === undefined) {
    t = { ts: 0, wasm: 0, matched: 0, missing: 0, extra: 0, mismatched: 0 };
    codes.set(code, t);
  }
  return t;
};
const codeOf = (d: Plain): string => d.code ?? '?';
const sample = (code: string, text: string, source: string, span: unknown): void => {
  const list = samples.get(code) ?? [];
  samples.set(code, list);
  if (list.length >= SAMPLES) return;
  const line = startLine(span);
  list.push(`${text}\n  line ${line}: ${(source.split('\n')[line - 1] ?? '').trim()}`);
};

function startLine(span: unknown): number {
  if (typeof span !== 'object' || span === null || !('start' in span)) return 1;
  const { start } = span;
  return typeof start === 'object' && start !== null && 'line' in start && typeof start.line === 'number' ? start.line : 1;
}

const started = process.hrtime.bigint();
const reference: string[] = fs.readFileSync(path.join(work, 'reference.jsonl'), 'utf8').split('\n').filter((l: string) => l !== '');
reference.forEach((line, index) => {
  const record = JSON.parse(line);
  const { source, version, upgradingFrom } = record as { source: string; version: number; upgradingFrom?: number };
  const ts: Plain[] = record.ts;
  const corpus = corpora.get(record.corpus) ?? { records: 0, exact: 0, sameSet: 0 };
  corpora.set(record.corpus, corpus);
  corpus.records += 1;
  const snapshot = table.get(record.snapshot);
  if (snapshot === undefined) throw new Error(`no snapshot ${record.snapshot}`);
  let wasm: Plain[];
  try {
    wasm = JSON.parse(
      canonical(checkSourceInRust(source, snapshot, { languageVersion: version, ...(upgradingFrom !== undefined ? { upgradingFrom } : {}) })),
    );
  } catch (error) {
    const reason = `${error instanceof RustCheckRefused ? 'refused' : 'crashed'}: ${String(error instanceof Error ? error.message : error).split(' at line ')[0]}`;
    if (error instanceof RustCheckRefused) refused += 1;
    else crashed += 1;
    const entry = refusals.get(reason) ?? { count: 0, example: `record ${index}, v${version}: ${source}` };
    entry.count += 1;
    refusals.set(reason, entry);
    return;
  }
  if (canonical(ts) === canonical(wasm)) corpus.exact += 1;
  const left: Array<Plain | undefined> = [...wasm];
  const unmatched: Plain[] = [];
  for (const d of ts) {
    tally(codeOf(d)).ts += 1;
    const i = left.findIndex(r => r !== undefined && canonical(r) === canonical(d));
    if (i === -1) unmatched.push(d);
    else {
      left[i] = undefined;
      tally(codeOf(d)).matched += 1;
    }
  }
  for (const d of wasm) tally(codeOf(d)).wasm += 1;
  let sameSet = true;
  for (const d of unmatched) {
    sameSet = false;
    const i = left.findIndex(r => r !== undefined && r.code === d.code && canonical(r.span) === canonical(d.span));
    if (i === -1) {
      tally(codeOf(d)).missing += 1;
      sample(codeOf(d), `MISSING v${version} ${canonical(d.span)} ${d.message}`, source, d.span);
    } else {
      tally(codeOf(d)).mismatched += 1;
      sample(codeOf(d), `MESSAGE v${version}\n  ts:   ${d.message}\n  wasm: ${left[i]?.message}`, source, d.span);
      left[i] = undefined;
    }
  }
  for (const r of left) {
    if (r === undefined) continue;
    sameSet = false;
    tally(codeOf(r)).extra += 1;
    sample(codeOf(r), `EXTRA v${version} ${canonical(r.span)} ${r.message}`, source, r.span);
  }
  if (sameSet) {
    corpus.sameSet += 1;
    if (canonical(ts) !== canonical(wasm)) {
      const spell = (ds: Plain[]) => ds.map(d => `${codeOf(d)} ${canonical(d.span)}`).join('\n    ');
      reordered.push(`## record ${index}, v${version}\n  ts:\n    ${spell(ts)}\n  wasm:\n    ${spell(wasm)}\n${source}\n`);
    }
  }
});
const seconds = Number(process.hrtime.bigint() - started) / 1e9;

const sorted = <T>(map: Map<string, T>): Array<[string, T]> => [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
fs.writeFileSync(path.join(work, 'samples.txt'), sorted(samples).map(([c, s]) => `## ${c}\n${s.join('\n')}\n`).join(''));
fs.writeFileSync(path.join(work, 'reordered.txt'), reordered.join(''));
fs.writeFileSync(
  path.join(work, 'refused.txt'),
  [...refusals.entries()].sort((a, b) => b[1].count - a[1].count).map(([reason, { count, example }]) => `## ${count} × ${reason}\n${example}\n\n`).join(''),
);

const atParity = (t: Tally) => t.ts > 0 && t.missing === 0 && t.extra === 0 && t.mismatched === 0;
const seen = sorted(codes).filter(([, t]) => t.ts > 0);
const sum = (f: (t: Tally) => number) => [...codes.values()].reduce((n, t) => n + f(t), 0);
const records = [...corpora.values()].reduce((n, c) => n + c.records, 0);
const exact = [...corpora.values()].reduce((n, c) => n + c.exact, 0);
const report = [
  '# Checker parity: the wasm against TypeScript, version 5\n',
  'Written by `packages/legacy-lang/parity/run.sh`. Do not edit by hand.\n',
  `- Codes at parity: **${seen.filter(([, t]) => atParity(t)).length} of ${seen.length}** codes the TypeScript checker reports on this corpus.`,
  `- Diagnostics matched: ${sum(t => t.matched)} of ${sum(t => t.ts)}; ${sum(t => t.extra)} extra in the wasm.`,
  `- Records with exactly the TypeScript's diagnostics, in its order: ${exact} of ${records}.`,
  `- Wasm side: ${seconds.toFixed(1)}s; ${refused} records the artifact refused; ${crashed} crashes (refused.txt names them).\n`,
  'A code is at parity when every diagnostic of it on the corpus is matched exactly and the wasm reports none extra.\n',
  '| corpus | records | exact | same diagnostics, any order |\n|---|---|---|---|',
  ...sorted(corpora).map(([name, c]) => `| ${name} | ${c.records} | ${c.exact} | ${c.sameSet} |`),
  '\n## By code\n\n| code | TS | matched | missing in the wasm | extra in the wasm | message differs | parity |\n|---|---|---|---|---|---|---|',
  ...sorted(codes).map(([c, t]) => `| ${c} | ${t.ts} | ${t.matched} | ${t.missing} | ${t.extra} | ${t.mismatched} | ${atParity(t) ? 'yes' : ''} |`),
].join('\n') + '\n';
fs.writeFileSync(OUT, report);
console.log(report.split('\n## By code')[0]);
