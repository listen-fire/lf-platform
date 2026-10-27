// .work/capture/*  →  data.js, the only input the video page reads. Nothing
// in the video's code, diagnostics or run figures is written by hand. The
// video itself is rendered in the site repo, so data.js is written there:
//   node build_data.cjs ../../../../listen-fire-site/video/field-service/data.js
//
// Where each figure comes from (lf reports some of them differently from the
// platform's inspectRun):
// - validatedUnder: `lf --version`, plus the listen-fire commit when lf ran
//   from a checkout's modules (LF_SRC); a release records its version alone.
// - saved: lf has no save step. `ok` is the fixed program's `lf check --json`;
//   the listener is the program's own `listen to …` line, its kind the module
//   the listened connection is made from.
// - runs[].status, committed, costUsd: `lf runs show --json` (`status`,
//   `writes`, `costMicrodollars` / 1e6).
// - runs[].modelCalls: lf does not count model calls; this is the number of
//   `extraction` entries in the run's trace.
// - runs[].urgency: the extraction's own output in the trace (Job.urgency).
// - runs[].ms: measured by capture.sh (deliver.cjs), from just before the
//   signed delivery is sent to the moment lf serve prints the settled run.
// - runs[].writes: what the fakes hold after the run that they did not hold
//   before it (sheet rows, Slack messages), so only that run's writes.
// - terminal: what `lf check` printed on the draft and on the fix, and what
//   `lf serve` printed up to being ready, verbatim but for colour codes and
//   the temporary project's path (made project-relative by capture.sh).
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node build_data.cjs <path to listen-fire-site/video/field-service/data.js>');
  process.exit(1);
}
const HERE = __dirname;
const CAP = path.join(HERE, '.work', 'capture');
const read = (f) => JSON.parse(fs.readFileSync(path.join(CAP, f), 'utf8'));
const text = (f) => fs.readFileSync(path.join(CAP, f), 'utf8').replace(/\s+$/, '');
const program = (f) => fs.readFileSync(path.join(HERE, 'programs', f), 'utf8').trimEnd();

const lf = read('00_lf.json');
const draft = read('10_check_draft.json');
const fixed = read('11_check_fixed.json');
const v2 = program('fixed.mvt');

// The listen, read off the program: `listen to <conn> { … } fire …`, and the
// connection's `<conn> = connect <adapter>` with the adapter's import.
function listener(source) {
  const listen = /^listen to (\w+)\s*(\{.*\})?\s*fire /m.exec(source);
  if (!listen) throw new Error('the fixed program has no listen');
  const adapter = new RegExp(`^${listen[1]}\\s*=\\s*connect (\\w+)`, 'm').exec(source)[1];
  const module = new RegExp('`@lf/(\\w+)` as ' + adapter + '\\b').exec(source)[1];
  const config = listen[2] ? JSON.parse(listen[2].replace(/(\w+)\s*:/g, '"$1":')) : {};
  return { kind: module, config };
}

const jobLog = JSON.parse(program('job_log.json')).entities[0].data;
const table = jobLog.sheets[0].tables[0];
const columns = table.columnProperties.map((c) => c.columnName);
const channels = read('13_slack_channels.json');

const cell = (v) => {
  const value = v?.userEnteredValue ?? v;
  if (value === null || typeof value !== 'object') return value;
  return value.stringValue ?? value.numberValue ?? value.boolValue ?? value.formulaValue ?? null;
};
const added = (before, after) => {
  const had = new Set(read(before).map((e) => e.id));
  return read(after).filter((e) => !had.has(e.id));
};

function writesOf(n) {
  const rows = added(`${n}_before_sheet_rows.json`, `${n}_after_sheet_rows.json`).map((row) => {
    if (row.spreadsheet_id !== jobLog.spreadsheetId) throw new Error(`a row landed in an unexpected spreadsheet ${row.spreadsheet_id}`);
    const values = Object.fromEntries(columns.map((name, i) => [name, cell(row.values[i])]));
    return { target: `${jobLog.properties.title} › ${table.name}`, action: 'append', values };
  });
  const posts = added(`${n}_before_slack_messages.json`, `${n}_after_slack_messages.json`).map((m) => {
    const channel = channels.find((c) => c.id === m.channel);
    return { target: `Slack #${channel ? channel.name : m.channel}`, action: 'post', values: { Message: m.text } };
  });
  return [...rows, ...posts];
}

function runOf(n, name) {
  const run = read(`${n}_${name}_run.json`).run;
  const delivery = read(`${n}_${name}_delivery.json`);
  const message = read(`${n}_${name}_message.json`);
  const trace = run.trace ?? [];
  const extractions = trace.filter((t) => t.kind === 'extraction');
  const job = extractions.flatMap((t) => t.entities?.Job ?? [])[0];
  if (run.event?.payload?.from !== message.from || run.event?.payload?.body !== message.text) {
    throw new Error(`run ${run.runId} did not come from the ${name} delivery`);
  }
  return {
    status: run.status,
    committed: run.writes,
    costUsd: run.costMicrodollars / 1e6,
    modelCalls: extractions.length,
    ms: delivery.ms,
    message: { from: run.event.payload.from, text: run.event.payload.body },
    urgency: job?.fields?.urgency ?? null,
    writes: writesOf(n),
  };
}

const data = {
  request: fs.readFileSync(path.join(CAP, '01_request.txt'), 'utf8').trim(),
  v1: program('draft.mvt'),
  v2,
  diagnostics: draft.diagnostics.map(({ file, ...d }) => ({ ...d, file: path.basename(file) })),
  validatedUnder: lf.commit ? `${lf.version}+${lf.commit}` : lf.version,
  saved: { ok: fixed.ok, listeners: [listener(v2)] },
  sheet: { name: jobLog.properties.title, columns },
  runs: [runOf(20, 'routine'), runOf(30, 'urgent')],
  terminal: {
    checkDraft: text('10_check_draft.txt'),
    checkFixed: text('11_check_fixed.txt'),
    serve: text('14_serve_ready.txt'),
  },
};

const [routine, urgent] = data.runs;
const pages = (r) => r.writes.filter((w) => w.target.startsWith('Slack ')).length;
const problems = [
  ...data.runs.filter((r) => r.status !== 'completed').map((r) => `a run ${r.status}`),
  ...(draft.diagnostics.filter((d) => d.severity === 'error').length !== 1 ? ['the draft is not refused with exactly one error'] : []),
  ...(!fixed.ok ? ['the fix does not check clean'] : []),
  ...data.runs.filter((r) => r.writes.filter((w) => w.action === 'append').length !== 1).map((r) => `the ${r.urgency} run did not log exactly one job`),
  ...(pages(routine) !== 0 ? ['the routine run paged someone'] : []),
  ...(pages(urgent) !== 1 ? ['the urgent run did not page the on-call engineer'] : []),
  ...Object.entries(data.terminal).filter(([, t]) => t === '').map(([k]) => `the terminal capture ${k} is empty`),
];
if (problems.length > 0) throw new Error(`refusing to build data.js: ${problems.join('; ')}`);

fs.writeFileSync(OUT, `window.DEMO=${JSON.stringify(data, null, 1)};\n`);
for (const r of data.runs) {
  console.log(`${r.urgency}: ${r.status}, ${r.committed} write(s), ${r.modelCalls} model call(s), $${r.costUsd}, ${r.ms} ms`);
}
console.log(`${OUT} (validated under lf ${data.validatedUnder})`);
