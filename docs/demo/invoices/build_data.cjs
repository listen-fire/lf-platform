// .work/capture/*  →  data.js, the only input the video page reads. Nothing
// in the video's code, diagnostics or run figures is written by hand. The
// video itself is rendered in the site repo, so data.js is written there:
//   node build_data.cjs ../../../../listen-fire-site/video/invoices/data.js
//
// data.js sets window.DEMO to:
//   request         what the user asked for (programs/request.txt)
//   v1, v2          the draft and the fixed program
//   diagnostics     the draft's `lf check --json` diagnostics (file made a basename)
//   validatedUnder  "<lf version> (<branch>@<commit>)", or the version alone for a release
//   saved           { ok, listeners: [{ kind, config }] }
//   sheet           { name, table, columns }   the Ledger spreadsheet's table
//   drive           { root }                   the granted folder invoices are filed under
//   pdfs            [{ name, bytes, sha256 }]  the invoices as printed, before they were mailed
//   runs[]          one per supplier email:
//     status, committed, costUsd, modelCalls, ms, runMs
//     email         { from, subject, attachment: { name, bytes } }
//     invoice       { supplier, number, date, due, amount, currency }  the extraction's output
//     flagged       whether the run posted to #finance
//     writes[]      { target, action, values }  what the run wrote, in its order:
//                   Drive folders and files (a file with { Name, Bytes, SHA-256, Type, Intact }),
//                   Ledger rows, Slack messages
//   terminal        { checkDraft, checkFixed, serve }
//
// Where each figure comes from (lf reports some of them differently from the
// platform's inspectRun):
// - validatedUnder: `lf --version`, plus the listen-fire branch and commit when
//   lf ran from a checkout's modules (LF_SRC), and "uncommitted changes" when
//   the checkout had any; a release records its version alone.
// - saved: lf has no save step. `ok` is the fixed program's `lf check --json`;
//   the listener is the program's own `listen to …` line, its kind the module
//   the listened connection is made from.
// - runs[].status, committed, costUsd: `lf runs show --json` (`status`,
//   `writes`, `costMicrodollars` / 1e6).
// - runs[].modelCalls: lf does not count model calls; this is the number of
//   `extraction` entries in the run's trace.
// - runs[].invoice: the extraction's own output in the trace (Invoice).
// - runs[].ms: the run's `finishedAt` less the moment mail.cjs dropped the
//   email into the fake mailbox (`sentAt`), so it includes the wait for
//   Gmail's next poll (a minute apart). runMs: `finishedAt` less `startedAt`.
// - runs[].writes: lf's own record of the run's writes (`writeRecords`), each
//   matched to what the fakes gained during the run, which must be exactly
//   those writes. lf names a write's record by id; where it was written is the
//   fakes' (a Drive item's folders, a Slack message's channel). A Drive file's
//   Bytes, SHA-256 and Type are the fake's own record of the upload; Intact
//   says they are the PDF as printed and application/pdf.
// - terminal: what `lf check` printed on the draft and on the fix, and what
//   `lf serve` printed up to being ready, verbatim but for colour codes and
//   the temporary project's path (made project-relative by capture.sh).
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node build_data.cjs <path to listen-fire-site/video/invoices/data.js>');
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
const pdfs = read('02_pdfs.json');

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

const ledger = JSON.parse(program('ledger.json')).entities[0].data;
const table = ledger.sheets[0].tables[0];
const columns = table.columnProperties.map((c) => c.columnName);
const driveRoot = JSON.parse(program('drive.json')).entities[0].data;
const channels = read('13_slack_channels.json');

const added = (before, after) => {
  const had = new Set(read(before).map((e) => e.id));
  return read(after).filter((e) => !had.has(e.id));
};
const FOLDER = 'application/vnd.google-apps.folder';

function writesOf(n, records) {
  const files = read(`${n}_after_drive_files.json`);
  const byId = new Map(files.map((f) => [f.id, f]));
  const pathOf = (f) => {
    const names = [];
    for (let at = byId.get(f.parents?.[0]); at; at = byId.get(at.parents?.[0])) names.unshift(at.name);
    return names.join(' › ');
  };
  const gained = {
    google_drive: added(`${n}_before_drive_files.json`, `${n}_after_drive_files.json`),
    google_sheets: added(`${n}_before_sheet_rows.json`, `${n}_after_sheet_rows.json`),
    slack: added(`${n}_before_slack_messages.json`, `${n}_after_slack_messages.json`),
  };
  for (const [adapter, items] of Object.entries(gained)) {
    const wrote = records.filter((r) => r.adapter === adapter).length;
    if (items.length !== wrote) throw new Error(`run ${n}: lf records ${wrote} ${adapter} write(s), the fake gained ${items.length}`);
  }
  return records.map((r) => {
    if (r.action !== 'create') throw new Error(`run ${n}: an unexpected ${r.action} of ${r.adapter} ${r.recordType}`);
    switch (r.adapter) {
      case 'google_drive': {
        const f = gained.google_drive.find((g) => g.id === r.recordId);
        if (!f) throw new Error(`run ${n}: Drive has no ${r.recordType} ${r.recordId}`);
        if (f.mimeType === FOLDER) return { target: `Drive ${pathOf(f)}`, action: 'create folder', values: { Name: f.name } };
        const printed = pdfs.find((p) => p.name === f.name);
        return {
          target: `Drive ${pathOf(f)}`,
          action: 'upload',
          values: {
            Name: f.name,
            Bytes: f.size,
            'SHA-256': f.sha256Checksum,
            Type: f.mimeType,
            Intact: printed !== undefined && printed.sha256 === f.sha256Checksum && printed.bytes === f.size && f.mimeType === 'application/pdf',
          },
        };
      }
      case 'google_sheets': {
        const row = gained.google_sheets[0];
        if (row.spreadsheet_id !== ledger.spreadsheetId) throw new Error(`a row landed in an unexpected spreadsheet ${row.spreadsheet_id}`);
        if (r.recordType !== `${table.name} (table)`) throw new Error(`run ${n}: a row went to ${r.recordType}, not ${table.name}`);
        const values = Object.fromEntries(columns.filter((c) => c in r.values).map((c) => [c, r.values[c]]));
        return { target: `${ledger.properties.title} › ${table.name}`, action: 'append', values };
      }
      case 'slack': {
        const m = gained.slack.find((g) => g.id === r.recordId);
        if (!m) throw new Error(`run ${n}: Slack has no message ${r.recordId}`);
        const channel = channels.find((c) => c.id === m.channel);
        return { target: `Slack #${channel ? channel.name : m.channel}`, action: 'post', values: { Message: m.text } };
      }
      default:
        throw new Error(`run ${n}: a write to an unexpected module ${r.adapter}`);
    }
  });
}

function runOf(n, name) {
  const run = read(`${n}_${name}_run.json`).run;
  const delivery = read(`${n}_${name}_delivery.json`);
  const email = read(`${n}_${name}_email.json`);
  const trace = run.trace ?? [];
  const extractions = trace.filter((t) => t.kind === 'extraction');
  const invoice = extractions.flatMap((t) => t.entities?.Invoice ?? [])[0];
  const payload = run.event?.payload ?? {};
  if (payload.id !== delivery.messageId || payload.subject !== email.subject) {
    throw new Error(`run ${run.runId} did not come from the ${name} invoice's email`);
  }
  const records = run.writeRecords ?? [];
  if (records.some((r) => !r.committed) || records.length !== run.writes) {
    throw new Error(`run ${run.runId} reports ${run.writes} write(s) but records ${records.filter((r) => r.committed).length} committed`);
  }
  const attachment = (payload.attachments ?? [])[0];
  const writes = writesOf(n, records);
  return {
    status: run.status,
    committed: run.writes,
    costUsd: run.costMicrodollars / 1e6,
    modelCalls: extractions.length,
    ms: Date.parse(run.finishedAt) - Date.parse(delivery.sentAt),
    runMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt),
    email: { from: payload.from, subject: payload.subject, attachment: attachment ? { name: attachment.filename, bytes: attachment.size } : null },
    invoice: invoice?.fields ?? null,
    flagged: writes.some((w) => w.target.startsWith('Slack ')),
    writes,
  };
}

const checkout = lf.commit ? [`${lf.branch ? `${lf.branch}@` : ''}${lf.commit}`, lf.uncommitted].filter(Boolean).join(' + ') : null;
const data = {
  request: fs.readFileSync(path.join(CAP, '01_request.txt'), 'utf8').trim(),
  v1: program('draft.mvt'),
  v2,
  diagnostics: draft.diagnostics.map(({ file, ...d }) => ({ ...d, file: path.basename(file) })),
  validatedUnder: checkout ? `${lf.version} (${checkout})` : lf.version,
  saved: { ok: fixed.ok, listeners: [listener(v2)] },
  sheet: { name: ledger.properties.title, table: table.name, columns },
  drive: { root: driveRoot.name },
  pdfs,
  runs: [runOf(20, 'small'), runOf(30, 'large')],
  terminal: {
    checkDraft: text('10_check_draft.txt'),
    checkFixed: text('11_check_fixed.txt'),
    serve: text('14_serve_ready.txt'),
  },
};

const [small, large] = data.runs;
const uploads = (r) => r.writes.filter((w) => w.action === 'upload');
const problems = [
  ...data.runs.filter((r) => r.status !== 'completed').map((r) => `a run ${r.status}`),
  ...(draft.diagnostics.filter((d) => d.severity === 'error').length !== 1 ? ['the draft is not refused with exactly one error'] : []),
  ...(!fixed.ok ? ['the fix does not check clean'] : []),
  ...data.runs.filter((r) => !Number.isFinite(r.ms) || !Number.isFinite(r.runMs)).map((r) => `the ${r.email.attachment?.name} run has no timing`),
  ...data.runs.filter((r) => r.modelCalls !== 1).map((r) => `the ${r.email.attachment?.name} run made ${r.modelCalls} model calls, not one`),
  ...data.runs.filter((r) => uploads(r).length !== 1 || !uploads(r)[0].values.Intact).map((r) => `the ${r.email.attachment?.name} run did not file its PDF intact`),
  ...data.runs.filter((r) => r.writes.filter((w) => w.action === 'append').length !== 1).map((r) => `the ${r.email.attachment?.name} run did not add exactly one ledger row`),
  ...(small.flagged ? ['the small invoice was flagged in #finance'] : []),
  ...(!large.flagged ? ['the large invoice was not flagged in #finance'] : []),
  ...Object.entries(data.terminal).filter(([, t]) => t === '').map(([k]) => `the terminal capture ${k} is empty`),
];
if (problems.length > 0) throw new Error(`refusing to build data.js: ${problems.join('; ')}`);

fs.writeFileSync(OUT, `window.DEMO=${JSON.stringify(data, null, 1)};\n`);
for (const r of data.runs) {
  console.log(`${r.invoice.supplier} ${r.invoice.amount}: ${r.status}, ${r.committed} write(s), ${r.modelCalls} model call(s), $${r.costUsd}, ${r.ms} ms from the email (${r.runMs} ms running)`);
}
console.log(`${OUT} (validated under lf ${data.validatedUnder})`);
