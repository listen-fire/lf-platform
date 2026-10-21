// Folds the harvest's JSON lines (./harvest.setup.cjs) into the lowering regression's
// fixture: one record per distinct expression text, with every way it reached
// the current code. Usage, from packages/movement-lang:
//
//   node parser/expression/harvest/build_fixture.cjs v1=<a.jsonl> v2=<b.jsonl> current=<c.jsonl>
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '../__test__/__fixtures__/expression_slots.json');

const byRaw = new Map();
for (const arg of process.argv.slice(2)) {
  const [corpus, file] = arg.split('=');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.file.startsWith(path.join('parser', 'expression'))) continue;
    let entry = byRaw.get(record.raw);
    if (!entry) {
      entry = { raw: record.raw, entries: new Set(), versions: new Set(), corpora: new Set(), where: new Set() };
      byRaw.set(record.raw, entry);
    }
    entry.entries.add(record.entry);
    entry.versions.add(record.version);
    entry.corpora.add(corpus);
    if (record.where) entry.where.add(record.where);
  }
}

const sorted = (set) => [...set].sort();
const fixture = [...byRaw.values()]
  .sort((a, b) => (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0))
  .map((e) => ({
    raw: e.raw,
    entries: sorted(e.entries),
    versions: sorted(e.versions),
    corpora: sorted(e.corpora),
    ...(e.where.size > 0 ? { where: sorted(e.where) } : {}),
  }));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 0).replace(/\},\{"raw"/g, '},\n{"raw"') + '\n');
console.log(`${fixture.length} distinct texts → ${path.relative(process.cwd(), OUT)}`);
