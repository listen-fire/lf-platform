// node grade.cjs <t1|t2> <authored project> <events dir> <out json>
// (env LF_BIN, FAKES; LF_MODULES_DIR and LF_SERVE_MODULE as run.sh sets them)
//
// The deterministic grader. It copies the authored project (run state left
// behind: a fresh store), resets the task's Airtable records, drives the
// program through the real `listen-fire`, and compares what the fake Airtable
// then holds with what the request asks for. Pass is every check right.
//
//   t1  `listen-fire run --event` on four Telegram updates in order
//       (events.cjs), then the Members table, row by row.
//   t2  `listen-fire drain --until-idle` with the clock moved on
//       (LF_CLOCK_AHEAD_MS): now (the listen arms), the next Monday 09:00:30
//       UTC, the tickets changed, the Thursday after (nothing due), the
//       Monday after that; the Digests table after each.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const world = require('./world.cjs');

const [task, authored, eventsDir, out] = process.argv.slice(2);
const LF_BIN = process.env.LF_BIN;
const FAKES = process.env.FAKES;
const graded = path.join(path.dirname(out), `${path.basename(out, '.json')}_project`);
fs.rmSync(graded, { recursive: true, force: true });
fs.cpSync(authored, graded, { recursive: true });
for (const f of fs.readdirSync(path.join(graded, '.lf'))) if (/^state\.db/.test(f)) fs.rmSync(path.join(graded, '.lf', f));

const steps = [];
function lf(args, aheadMs) {
  const ran = spawnSync(LF_BIN, args, { cwd: graded, encoding: 'utf8', timeout: 180_000, env: { ...process.env, ...(aheadMs !== undefined ? { LF_CLOCK_AHEAD_MS: String(aheadMs) } : {}) } });
  const said = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
  steps.push({ args, aheadMs, exit: ran.status, out: said.split(graded).join('.') });
  return ran.status;
}

const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

async function t1() {
  const { EXPECTED } = require('./tasks/t1_members/events.cjs');
  await world.reset(FAKES, 't1');
  for (const f of fs.readdirSync(eventsDir).filter((f) => /^\d\d\.json$/.test(f)).sort()) lf(['run', '--event', path.join(eventsDir, f)]);
  const rows = await world.rows(FAKES, 'appCOMMUNITY', 'tblMEMBERS');
  expect('four members, one per Telegram user', rows.length === 4, rows.map((r) => r.fields));
  for (const [id, want] of Object.entries(EXPECTED)) {
    const mine = rows.filter((r) => text(r.fields['Telegram Id']) === id);
    if (mine.length !== 1) {
      expect(`member ${id}: one row`, false, `${mine.length} rows`);
      continue;
    }
    const got = mine[0].fields;
    for (const [field, value] of Object.entries(want)) expect(`member ${id}: ${field}`, text(got[field]) === value, { want: value, got: got[field] ?? null });
  }
}

/** A breakdown's lines as { name: count }: "Priya: 3", "- Priya: 3 open". */
function parseBreakdown(breakdown) {
  const counts = {};
  for (const line of text(breakdown).split('\n')) {
    const m = /^[\s\-*•]*([^:\d\n]+?)\s*[:\-–—]\s*(\d+)/.exec(line);
    if (m) counts[m[1].trim().toLowerCase()] = Number(m[2]);
  }
  return counts;
}

function digestMatches(label, row, want) {
  const total = Object.values(want).reduce((a, b) => a + b, 0);
  expect(`${label}: Open Tickets`, Number(row?.fields['Open Tickets']) === total, { want: total, got: row?.fields['Open Tickets'] ?? null });
  const counts = parseBreakdown(row?.fields.Breakdown);
  for (const [name, n] of Object.entries(want)) {
    const got = counts[name.toLowerCase()];
    expect(`${label}: ${name}`, n === 0 ? got === undefined || got === 0 : got === n, { want: n, got: got ?? null });
  }
  const extra = Object.entries(counts).filter(([name, n]) => n !== 0 && !(name in Object.fromEntries(Object.keys(want).map((k) => [k.toLowerCase(), 1]))));
  expect(`${label}: no other lines with a count`, extra.length === 0, { extra, breakdown: row?.fields.Breakdown ?? null });
}

async function t2() {
  await world.reset(FAKES, 't2');
  const now = Date.now();
  const d = new Date(now);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (((8 - d.getUTCDay()) % 7) || 7), 9, 0, 30);
  const DAY = 86_400_000;
  const digests = () => world.rows(FAKES, 'appSUPPORT', 'tblDIGESTS');
  lf(['drain', '--until-idle'], 0);
  expect('no digest before Monday', (await digests()).length === 0);
  lf(['drain', '--until-idle'], monday - now);
  const first = await digests();
  expect('one digest on the first Monday', first.length === 1, first.map((r) => r.fields));
  digestMatches('first Monday', first[0], { Priya: 3, Tom: 1, Sam: 1, Unassigned: 3, Lena: 0 });
  await world.changeTickets(FAKES);
  lf(['drain', '--until-idle'], monday + 3 * DAY - now);
  expect('no digest on the Thursday', (await digests()).length === 1);
  lf(['drain', '--until-idle'], monday + 7 * DAY - now);
  const second = await digests();
  expect('a second digest on the next Monday', second.length === 2, second.map((r) => r.fields));
  const newest = second.find((r) => r.id !== first[0]?.id);
  digestMatches('second Monday', newest, { Priya: 2, Tom: 0, Sam: 2, Lena: 1, Unassigned: 2 });
}

async function main() {
  const checked = lf(['check']);
  expect('listen-fire check is clean', checked === 0);
  if (checked === 0) await (task === 't1' ? t1() : t2());
  const pass = checks.length > 1 && checks.every((c) => c.ok);
  fs.writeFileSync(out, `${JSON.stringify({ task, pass, checks, steps }, null, 1)}\n`);
  console.log(`${task} grade: ${pass ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.ok).length}/${checks.length} checks)${pass ? '' : `; failed: ${checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
