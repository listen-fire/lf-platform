// .work/capture/*  →  data.js, the only input the video page reads. Nothing
// in the video's code, diagnostics or run figures is written by hand. The
// video itself is rendered in the site repo, so data.js is written there:
//   node build_data.cjs ../../../../listen-fire-site/video/recruiting/data.js
//
// The shape (window.DEMO):
//   request         what the user asked for (programs/request.txt)
//   v1, v2          the draft and the fixed program, as written
//   diagnostics     the draft's `listen-fire check --json` diagnostics (file made a basename)
//   validatedUnder  "<listen-fire version> (<branch>@<commit>)", see below
//   saved           { ok, listeners: [{ kind, config }] }
//   base            { name, table, fields, stages, candidates: [{ Name, Role, Stage, Interviewer }] }
//                   the Hiring base as seeded, before either edit
//   edits[]         one per edit to the base, in order:
//     name, candidate, field, from, to   the edit (a candidate's Stage changed)
//     fired         whether a run happened
//     serve         what listen-fire serve printed while the edit was handled
//     delivery      { id, eventCount, runs }: listen-fire's record of the webhook ping
//     run           null when nothing fired; else { status, committed, costUsd,
//                   modelCalls, ms, runMs, writeRecords }
//     writes[]      { target, action, values }: what the fakes hold after the
//                   edit that they did not hold before it, the edit's own
//                   change to the field left out
//     sent          emails Gmail sent during the edit (the draft is not sent)
//   terminal        { checkDraft, checkFixed, serve }: verbatim terminal text
//
// Where each figure comes from:
// - validatedUnder: `listen-fire --version`, and the listen-fire branch LF_SRC was
//   built from with its commit (LF_BRANCHES=main). A release records its
//   version alone.
// - saved: listen-fire has no save step. `ok` is the fixed program's `listen-fire check --json`;
//   the listener is the program's own `listen to …` line, its kind the module
//   the listened connection is made from.
// - run.status, committed, costUsd, writeRecords: `listen-fire runs show --json`
//   (`status`, `writes`, `costMicrodollars` / 1e6, `writeRecords`).
// - run.modelCalls: listen-fire does not count model calls; this is the number of
//   `extraction` entries in the run's trace (the program makes none).
// - run.ms: measured by capture.sh (deliver.cjs), from just before the cell is
//   changed to the moment listen-fire serve prints the settled run. run.runMs is listen-fire's
//   own startedAt to finishedAt.
// - writes: the fakes' state after minus before. The fake Airtable keeps a
//   written cell under the field's id; it is named here from the seeded
//   table's fields. A Drive copy's source is the seeded file whose content the
//   copy carries.
// - A run that did not fire: no run line in the serve log, `listen-fire deliveries`
//   shows the ping with no runs, `listen-fire runs` gained nothing, and the fakes
//   changed only by the edit itself.
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node build_data.cjs <path to listen-fire-site/video/recruiting/data.js>');
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

function listener(source) {
  const listen = /^listen to (\w+)\s*(\{.*\})?\s*fire /m.exec(source);
  if (!listen) throw new Error('the fixed program has no listen');
  const adapter = new RegExp(`^${listen[1]}\\s*=\\s*connect (\\w+)`, 'm').exec(source)[1];
  const module = new RegExp('`@lf/(\\w+)` as ' + adapter + '\\b').exec(source)[1];
  const config = listen[2] ? JSON.parse(listen[2].replace(/(\w+)\s*:/g, '"$1":')) : {};
  return { kind: module, config };
}

function validatedUnder() {
  if (!lf.commit) return lf.version;
  if (lf.branches.length === 0) return `${lf.version}+${lf.commit}`;
  if (lf.branches.length === 1 && lf.branches[0].commit !== lf.commit) {
    throw new Error(`LF_SRC (${lf.commit}) is not ${lf.branches[0].branch}'s tip (${lf.branches[0].commit})`);
  }
  return `${lf.version} (${lf.branches.map((b) => `${b.branch}@${b.commit}`).join(' + ')})`;
}

const seeded = JSON.parse(program('hiring_base.json')).entities;
const baseMeta = seeded.find((e) => e.entity_type === 'base').data;
const table = seeded.find((e) => e.entity_type === `table:${baseMeta.id}`).data;
const fieldName = Object.fromEntries(table.fields.flatMap((f) => [[f.id, f.name], [f.name, f.name]]));
const stage = table.fields.find((f) => f.name === 'Stage');
const seededRows = seeded.filter((e) => e.entity_type === `record:${baseMeta.id}:${table.id}`).map((e) => e.data);
const driveSeed = JSON.parse(program('drive.json')).entities.map((e) => e.data);
const channels = read('13_slack_channels.json');

const named = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [fieldName[k] ?? k, v]));
const byId = (list, key = 'id') => new Map(list.map((e) => [e[key], e]));
const addedOf = (before, after, key = 'id') => {
  const had = byId(before, key);
  return after.filter((e) => !had.has(e[key]));
};

function writesOf(n, edit) {
  const writes = [];
  const problems = [];

  const rowsBefore = byId(read(`${n}_before_airtable_candidates.json`));
  for (const row of read(`${n}_after_airtable_candidates.json`)) {
    const was = rowsBefore.get(row.id);
    if (!was) { problems.push(`a candidate row ${row.id} appeared`); continue; }
    const now = named(row.fields);
    const then = named(was.fields);
    const changed = Object.fromEntries(Object.entries(now).filter(([k, v]) => JSON.stringify(then[k]) !== JSON.stringify(v)));
    if (row.id === edit.record) {
      if (changed[edit.field] !== edit.to) problems.push(`the edit did not set ${edit.field} to ${edit.to}`);
      delete changed[edit.field];
    }
    if (Object.keys(changed).length > 0) {
      writes.push({ target: `Airtable ${baseMeta.name} › ${table.name}`, action: 'update', record: now.Name, values: changed });
    }
  }

  const folders = byId(driveSeed);
  for (const file of addedOf(read(`${n}_before_drive_files.json`), read(`${n}_after_drive_files.json`))) {
    const source = driveSeed.find((s) => s.mimeType === file.mimeType && s.content !== null && s.content === file.content);
    const folder = file.parents.map((p) => folders.get(p)?.name ?? p).join(', ');
    writes.push({
      target: `Google Drive › ${folder}`,
      action: source ? 'copy' : 'create',
      values: { Name: file.name, ...(source ? { 'Copied from': source.name } : {}), Link: file.webViewLink },
    });
  }

  for (const m of addedOf(read(`${n}_before_slack_messages.json`), read(`${n}_after_slack_messages.json`))) {
    const channel = channels.find((c) => c.id === m.channel);
    writes.push({ target: `Slack #${channel ? channel.name : m.channel}`, action: 'post', values: { Message: m.text } });
  }

  const mailBefore = read(`${n}_before_gmail.json`);
  const mailAfter = read(`${n}_after_gmail.json`);
  for (const d of addedOf(mailBefore.drafts, mailAfter.drafts, 'draftId')) {
    writes.push({
      target: `Gmail drafts (${mailAfter.mailbox.emailAddress})`,
      action: 'draft',
      values: { To: d.to, Subject: d.subject, Body: d.body },
    });
  }
  const sent = addedOf(mailBefore.outbox, mailAfter.outbox).length + addedOf(mailBefore.messages, mailAfter.messages).length;
  return { writes, sent, problems };
}

function editOf(n, name) {
  const edit = read(`${n}_${name}_edit.json`);
  const ping = read(`${n}_${name}_delivery.json`);
  const candidate = seededRows.find((r) => r.id === edit.record).fields.Name;
  const { writes, sent, problems } = writesOf(n, edit);
  const runsBefore = read(`${n}_before_lf_runs.json`).runs;
  const runsAfter = read(`${n}_after_lf_runs.json`).runs;
  const deliveriesBefore = read(`${n}_before_lf_deliveries.json`).deliveries;
  const newDeliveries = addedOf(deliveriesBefore, read(`${n}_after_lf_deliveries.json`).deliveries);
  if (newDeliveries.length !== 1) problems.push(`listen-fire recorded ${newDeliveries.length} deliveries for the ${name} edit`);
  const delivery = newDeliveries[0] ?? null;
  const fired = ping.runId !== null;

  let run = null;
  if (fired) {
    const r = read(`${n}_${name}_run.json`).run;
    const payload = r.event?.payload ?? {};
    if (payload.record !== edit.record || payload.previous?.[edit.field] !== edit.from || payload.fields?.[edit.field] !== edit.to) {
      problems.push(`run ${r.runId} did not come from the ${name} edit`);
    }
    if (!delivery || delivery.id !== r.deliveryId) problems.push(`run ${r.runId} is not the ${name} edit's delivery's run`);
    run = {
      status: r.status,
      committed: r.writes,
      costUsd: r.costMicrodollars / 1e6,
      modelCalls: (r.trace ?? []).filter((t) => t.kind === 'extraction').length,
      ms: ping.ms,
      runMs: Date.parse(r.finishedAt) - Date.parse(r.startedAt),
      writeRecords: r.writeRecords.map(({ adapter, recordType, action, committed, values }) => ({ adapter, recordType, action, committed, values })),
    };
  } else {
    if (runsAfter.length !== runsBefore.length) problems.push(`listen-fire runs grew during the ${name} edit`);
    if (delivery && delivery.runs.length !== 0) problems.push(`the ${name} edit's delivery started runs`);
  }

  return {
    name,
    candidate,
    field: edit.field,
    from: edit.from,
    to: edit.to,
    fired,
    serve: ping.logged,
    delivery: delivery && { id: delivery.id, eventCount: delivery.eventCount, runs: delivery.runs },
    run,
    writes,
    sent,
    problems,
  };
}

const edits = [editOf(20, 'screen'), editOf(30, 'interview')];
const [screen, interview] = edits;

const data = {
  request: fs.readFileSync(path.join(CAP, '01_request.txt'), 'utf8').trim(),
  v1: program('draft.mvt'),
  v2,
  diagnostics: draft.diagnostics.map(({ file, ...d }) => ({ ...d, file: path.basename(file) })),
  validatedUnder: validatedUnder(),
  saved: { ok: fixed.ok, listeners: [listener(v2)] },
  base: {
    name: baseMeta.name,
    table: table.name,
    fields: table.fields.map((f) => f.name),
    stages: stage.options.choices.map((c) => c.name),
    candidates: seededRows.map(({ fields: { Name, Role, Stage, Interviewer } }) => ({ Name, Role, Stage, Interviewer })),
  },
  edits: edits.map(({ problems, ...e }) => e),
  terminal: {
    checkDraft: text('10_check_draft.txt'),
    checkFixed: text('11_check_fixed.txt'),
    serve: text('14_serve_ready.txt'),
  },
};

const errors = draft.diagnostics.filter((d) => d.severity === 'error');
const kinds = (e) => e.writes.map((w) => `${w.target.split(' ')[0]}:${w.action}`).sort().join(',');
const copy = interview.writes.find((w) => w.action === 'copy');
const airtable = interview.writes.find((w) => w.target.startsWith('Airtable '));
const post = interview.writes.find((w) => w.action === 'post');
const mail = interview.writes.find((w) => w.action === 'draft');
const priya = seededRows.find((r) => r.fields.Name === interview.candidate).fields;
const problems = [
  ...edits.flatMap((e) => e.problems),
  ...(errors.length !== 1 ? [`the draft is refused with ${errors.length} errors, not exactly one`] : []),
  ...(errors[0]?.code !== 'MOV_ENUM_UNKNOWN_VALUE' ? [`the draft's error is ${errors[0]?.code}, not MOV_ENUM_UNKNOWN_VALUE`] : []),
  ...(!fixed.ok ? ['the fix does not check clean'] : []),
  ...(screen.fired ? ['the Screen edit fired a run'] : []),
  ...(screen.writes.length !== 0 ? [`the Screen edit wrote ${screen.writes.length} thing(s)`] : []),
  ...(!screen.serve.some((l) => /ran nothing/.test(l)) ? ['listen-fire serve did not say the Screen edit ran nothing'] : []),
  ...(!interview.fired ? ['the Interview edit did not fire'] : []),
  ...(interview.run && interview.run.status !== 'completed' ? [`the Interview run ${interview.run.status}`] : []),
  ...(kinds(interview) !== 'Airtable:update,Gmail:draft,Google:copy,Slack:post' ? [`the Interview run wrote ${kinds(interview)}`] : []),
  ...(interview.run && interview.run.committed !== interview.writes.length ? ['listen-fire counts different writes from the fakes'] : []),
  ...(copy && (copy.target !== 'Google Drive › Scorecards' || copy.values['Copied from'] !== 'Interview scorecard') ? ['the scorecard is not a copy of the template in Scorecards'] : []),
  ...(airtable && copy && (airtable.record !== interview.candidate || airtable.values.Scorecard !== copy.values.Link) ? ["the candidate's Scorecard is not the copy's link"] : []),
  ...(post && copy && (post.target !== 'Slack #hiring' || !post.values.Message.includes(copy.values.Link) || !post.values.Message.includes(priya.Interviewer)) ? ['the #hiring post does not name the interviewer and the scorecard'] : []),
  ...(mail && mail.values.To !== priya.Email ? ['the draft is not to the candidate'] : []),
  ...edits.filter((e) => e.sent !== 0).map((e) => `the ${e.name} edit sent email`),
  ...Object.entries(data.terminal).filter(([, t]) => t === '').map(([k]) => `the terminal capture ${k} is empty`),
];
if (problems.length > 0) throw new Error(`refusing to build data.js: ${problems.join('; ')}`);

fs.writeFileSync(OUT, `window.DEMO=${JSON.stringify(data, null, 1)};\n`);
for (const e of data.edits) {
  if (!e.fired) console.log(`${e.name}: ${e.candidate} ${e.from} → ${e.to}, no run, ${e.writes.length} write(s)`);
  else console.log(`${e.name}: ${e.candidate} ${e.from} → ${e.to}, ${e.run.status}, ${e.run.committed} write(s), ${e.run.modelCalls} model call(s), $${e.run.costUsd}, ${e.run.ms} ms (run ${e.run.runMs} ms)`);
}
console.log(`${OUT} (validated under listen-fire ${data.validatedUnder})`);
