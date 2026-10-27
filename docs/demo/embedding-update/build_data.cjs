// .work/capture/*  →  data.js, the only input the video page reads. Nothing
// in the video's code, tool answers, records or run figures is written by
// hand. The video is rendered in the site repo, so data.js is written there:
//   node build_data.cjs ../../../../listen-fire-site/video/embedding-update/data.js
//
// data.js sets window.DEMO to:
//   request         what Brightline's user asked its agent, in plain words
//   validatedUnder  "<core version> (<branch>@<commit>)" of the listen-fire checkout
//   embed           the @listen-fire/embed version the product ran on
//   host            the demo product's code: { files, lines, setup, connect, event, loopRule }
//                   files:    [{ path, lines }] every file of host/
//                   lines:    their total
//                   setup:    { file, from, to, code } the createEmbeddedHost call
//                   connect:  [{ file, line, code }] each host.connect call
//                   event:    { file, from, to, code } the companyUpdated function
//                   loopRule: { file, from, to, code } the comment and updateRecord
//                             that make an automation's write raise no event
//   customer        { tenant, name, fields, describe, slackChannels }
//   agent           [{ tool, arguments, answer }] the agent's tool calls, in
//                   order (getStarted's answer cut to its "## Systems" section)
//   program         the automation's source, as saved
//   saved           { id, revision, listeners } saveAutomation's answer
//   created         { company, ms, runs } the person adding Halden Marine
//   won             the person's PATCH Stage → Won:
//                   { fields, record: { before, event, answered, after },
//                     ms, automationWriteMs, run: { runId, status, committed,
//                     costUsd, modelCalls, writes }, post, events, automationWrites }
//                   record.before: GET before the PATCH; event: the payload the
//                   product raised; answered: the PATCH's own answer; after:
//                   GET after it. post: the message #deals gained.
//   owner           the person's PATCH Owner only: { fields, record: { before,
//                   answered, after }, ms, runs, posts, automationWrites }
//   runsTotal       listRuns of the automation after both changes
//   terminal        { host } what the product printed, verbatim
//
// Where each figure comes from:
// - validatedUnder: packages/movement-engine's version, the branch whose head
//   the checkout is at, and its commit, read by capture.sh.
// - ms: measured by change.cjs, from just before the request to its response.
//   The product runs every listening automation before it answers.
// - automationWriteMs: on the product's own clock (host.cjs prints each line
//   with `at <ms>`): from the PATCH request arriving to the automation's
//   write to the company.
// - run.status, committed: inspectRun (`status`, `recordCount`).
// - run.costUsd: the PATCH answer's `spentMicrodollars` / 1e6.
// - run.modelCalls: `model call` lines host.cjs printed during the PATCH.
// - run.writes: inspectRun's writes, each { system, outcome, values }.
// - events: `event` lines the product printed during the PATCH: one, the
//   person's change; the automation's write raised none.
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node build_data.cjs <path to listen-fire-site/video/embedding-update/data.js>');
  process.exit(1);
}
const HERE = __dirname;
const CAP = path.join(HERE, '.work', 'capture');
const raw = (f) => fs.readFileSync(path.join(CAP, f), 'utf8');
const read = (f) => JSON.parse(raw(f));
const text = (f) => raw(f).replace(/\s+$/, '');
const program = (f) => fs.readFileSync(path.join(HERE, 'programs', f), 'utf8').trimEnd();

const lf = read('00_lf.json');
const tenant = JSON.parse(program('tenant.json'));
const changes = JSON.parse(program('changes.json'));
const source = program('automation.mvt');

// The product's code.
const HOST_FILES = fs.readdirSync(path.join(CAP, 'host')).filter((f) => f.endsWith('.ts')).sort();
const hostLines = (f) => raw(`host/${f}`).replace(/\n$/, '').split('\n');
const span = (file, from, to) => {
  const lines = hostLines(file);
  return from < 0 || to < from ? null : { file: `host/${file}`, from: from + 1, to: to + 1, code: lines.slice(from, to + 1).join('\n') };
};
const blockFrom = (file, startRe) => {
  const lines = hostLines(file);
  const from = lines.findIndex((l) => startRe.test(l));
  const indent = from < 0 ? '' : /^\s*/.exec(lines[from])[0];
  const to = lines.findIndex((l, i) => i > from && new RegExp(`^${indent}\\}[),;]*\\s*$`).test(l));
  return span(file, from, to);
};
const product = hostLines('product.ts');
const setupFrom = product.findIndex((l) => /createEmbeddedHost\(\{/.test(l));
const setupTo = product.findIndex((l, i) => i > setupFrom && /^\s*\}\);\s*$/.test(l));
const crm = hostLines('crm.ts');
const ruleFrom = crm.findIndex((l) => /An automation's write\. It raises no event/.test(l));
const ruleTo = crm.findIndex((l, i) => i > ruleFrom && /^\s{4}\},\s*$/.test(l));
const host = {
  files: HOST_FILES.map((f) => ({ path: `host/${f}`, lines: hostLines(f).length })),
  lines: HOST_FILES.reduce((n, f) => n + hostLines(f).length, 0),
  setup: span('product.ts', setupFrom, setupTo),
  connect: product.flatMap((l, i) => (/this\.host\.connect\(/.test(l) ? [{ file: 'host/product.ts', line: i + 1, code: l.trim() }] : [])),
  event: blockFrom('crm.ts', /^export function companyUpdated\(/),
  loopRule: span('crm.ts', ruleFrom, ruleTo),
};

const systemsOf = (answer) => {
  const from = answer.indexOf('## Systems');
  const to = answer.indexOf('\n## ', from + 1);
  return answer.slice(from, to === -1 ? undefined : to).trimEnd();
};
const agent = ['10_getStarted', '11_describe', '20_save', '21_list'].map((f) => {
  const { params } = read(`${f}.request.json`);
  const answer = text(`${f}.txt`);
  return { tool: params.name, arguments: params.arguments, answer: params.name === 'getStarted' ? systemsOf(answer) : answer };
});
const savedAnswer = read('20_save.txt');

// The product's log lines for one request, each with its time.
const logOf = (prefix) =>
  raw(`${prefix}_host.log`)
    .split('\n')
    .flatMap((l) => {
      const m = /^(.*) at (\d+\.\d+)$/.exec(l);
      return m ? [{ line: m[1], at: Number(m[2]) }] : [];
    });
const companyOf = (prefix, when, id) => read(`${prefix}_${when}_companies.json`).find((c) => c.id === id);
const added = (prefix) => {
  const had = new Set(read(`${prefix}_before_slack_messages.json`).map((m) => m.id));
  return read(`${prefix}_after_slack_messages.json`).filter((m) => !had.has(m.id));
};
const channelName = (id) => read('02_slack_channels.json').find((c) => c.id === id)?.name ?? id;
const runsOf = (prefix) => read(`${prefix}_runs.txt`).runs;

const createdAnswer = read('30_create_answer.json');
const ID = createdAnswer.body.company.id;
const created = { company: createdAnswer.body.company, ms: createdAnswer.ms, runs: createdAnswer.body.runs.length, posts: added('30_create').length };

const [wonChange, ownerChange] = changes.changes;
const wonPrefix = `${wonChange.n}_${wonChange.name}`;
const ownerPrefix = `${ownerChange.n}_${ownerChange.name}`;

const wonAnswer = read(`${wonPrefix}_answer.json`);
const wonLog = logOf(wonPrefix);
const patchAt = wonLog.find((l) => l.line.startsWith('request PATCH '))?.at;
const automationWrites = wonLog.filter((l) => l.line.startsWith('company write automation '));
const events = wonLog.filter((l) => l.line.startsWith('event '));
const inspected = read('50_inspect.txt');
const [wonRun] = wonAnswer.body.runs;
const won = {
  fields: wonChange.fields,
  record: {
    before: companyOf(wonPrefix, 'before', ID),
    event: events.length === 1 ? JSON.parse(events[0].line.replace(/^event \S+ /, '')) : null,
    answered: wonAnswer.body.company,
    after: companyOf(wonPrefix, 'after', ID),
  },
  ms: wonAnswer.ms,
  automationWriteMs: patchAt !== undefined && automationWrites.length > 0 ? Math.round((automationWrites[0].at - patchAt) * 10) / 10 : null,
  run: {
    runId: inspected.runId,
    status: inspected.status,
    committed: inspected.recordCount,
    costUsd: wonRun?.outcome.ok ? wonRun.outcome.spentMicrodollars / 1e6 : null,
    modelCalls: wonLog.filter((l) => l.line.startsWith('model call ')).length,
    writes: (inspected.writes ?? []).map((w) => ({ system: w.adapterType, record: w.recordType, id: w.externalId, outcome: w.outcome, values: w.writtenValues })),
  },
  post: added(wonPrefix).map((m) => ({ channel: `#${channelName(m.channel)}`, text: m.text })),
  events: events.length,
  automationWrites: automationWrites.length,
};

const ownerAnswer = read(`${ownerPrefix}_answer.json`);
const ownerLog = logOf(ownerPrefix);
const owner = {
  fields: ownerChange.fields,
  record: { before: companyOf(ownerPrefix, 'before', ID), answered: ownerAnswer.body.company, after: companyOf(ownerPrefix, 'after', ID) },
  ms: ownerAnswer.ms,
  runs: ownerAnswer.body.runs.length,
  posts: added(ownerPrefix).length,
  events: ownerLog.filter((l) => l.line.startsWith('event ')).length,
  automationWrites: ownerLog.filter((l) => l.line.startsWith('company write automation ')).length,
};

const data = {
  request: text('01_request.txt'),
  validatedUnder: `${lf.version} (${lf.branch ?? 'detached'}@${lf.commit})`,
  embed: lf.embed,
  host,
  customer: {
    tenant: tenant.tenant,
    name: tenant.customer,
    fields: tenant.fields,
    describe: text('11_describe.txt'),
    slackChannels: read('02_slack_channels.json').map((c) => c.name),
  },
  agent,
  program: source,
  saved: { id: savedAnswer.id, revision: savedAnswer.revision, listeners: savedAnswer.listeners },
  created,
  won,
  owner,
  runsTotal: runsOf(ownerPrefix).length,
  terminal: { host: text('60_host.log') },
};

// What the program sets and posts, read off its source.
const onboarding = /write company \{ Onboarding: "([^"]+)" \}/.exec(source)?.[1];
const becomes = /field: "Stage", becomes: "([^"]+)"/.exec(source)?.[1];
const same = (a, b) => a !== undefined && b !== undefined && a !== null && b !== null && Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);
const created0 = { id: ID, ...changes.create };
const wonExpected = { ...created0, ...wonChange.fields, Onboarding: onboarding };
const ownerExpected = { ...wonExpected, ...ownerChange.fields };
const expectedPost = `Deal won: ${created0.Name} (owner: ${created0.Owner})`;
const problems = [
  ...(savedAnswer.saved !== true ? ['the automation did not save'] : []),
  ...(onboarding === undefined || !tenant.fields.find((f) => f.name === 'Onboarding').options.includes(onboarding) ? ["the program's Onboarding is not one of the customer's options"] : []),
  ...(becomes !== wonChange.fields.Stage ? ["the listen's becomes is not the Stage the person sets"] : []),
  ...(created.runs !== 0 || created.posts !== 0 ? ['adding the company ran something'] : []),
  ...(!same(companyOf('30_create', 'after', ID), created0) ? ['the created company is not what was posted'] : []),
  // The Won change: one run, the same record's Onboarding set, one post, no loop.
  ...(!same(won.record.before, created0) ? ['the record before the Won change is not the created one'] : []),
  ...(wonAnswer.body.runs.length !== 1 ? [`the Won change started ${wonAnswer.body.runs.length} runs`] : []),
  ...(runsOf(wonPrefix).length !== 1 ? [`after the Won change the automation has ${runsOf(wonPrefix).length} runs`] : []),
  ...(won.run.status !== 'success' ? [`the run ${won.run.status}`] : []),
  ...(won.run.runId !== wonRun?.runId ? ['the run inspected is not the one the Won change started'] : []),
  ...(!same(won.record.answered, wonExpected) ? ["the PATCH's answer is not the record with Stage Won and its Onboarding set"] : []),
  ...(!same(won.record.after, wonExpected) ? ['the record after the Won change is not Stage Won with its Onboarding set'] : []),
  ...(won.events !== 1 ? [`the Won change raised ${won.events} events (a loop, or none)`] : []),
  ...(won.automationWrites !== 1 ? [`the automation wrote the company ${won.automationWrites} times`] : []),
  ...(won.automationWriteMs === null || won.automationWriteMs <= 0 ? ['no automation write after the PATCH arrived'] : []),
  ...(won.post.length !== 1 || won.post[0].channel !== '#deals' || won.post[0].text !== expectedPost ? ['#deals did not gain exactly the one post'] : []),
  ...(JSON.stringify(won.run.writes.map((w) => [w.system, w.outcome, w.values])) !==
  JSON.stringify([
    ['crm', 'update', { Onboarding: onboarding }],
    ['slack', 'create', { Message: expectedPost }],
  ])
    ? ["the run's own writes are not the update and the post"]
    : []),
  ...(won.run.writes[0]?.id !== ID ? ['the run updated another record than the one it fired for'] : []),
  ...(won.run.committed !== 2 ? [`the run committed ${won.run.committed} writes`] : []),
  ...(won.run.modelCalls !== 0 ? [`the run made ${won.run.modelCalls} model calls`] : []),
  // The Owner change: nothing runs.
  ...(owner.runs !== 0 || runsOf(ownerPrefix).length !== 1 ? ['the Owner change ran the automation'] : []),
  ...(owner.posts !== 0 || owner.automationWrites !== 0 ? ['the Owner change posted or wrote'] : []),
  ...(owner.events !== 1 ? [`the Owner change raised ${owner.events} events`] : []),
  ...(!same(owner.record.after, ownerExpected) || !same(owner.record.answered, ownerExpected) ? ['the record after the Owner change is not just its Owner changed'] : []),
  ...(data.runsTotal !== 1 ? [`the automation ran ${data.runsTotal} times in all`] : []),
  ...(host.setup === null || host.connect.length === 0 || host.event === null || host.loopRule === null ? ["the product's code was not found"] : []),
  ...(data.terminal.host === '' ? ['the host log is empty'] : []),
];
if (problems.length > 0) throw new Error(`refusing to build data.js: ${problems.join('; ')}`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `window.DEMO=${JSON.stringify(data, null, 1)};\n`);
console.log(
  `Won: ${won.record.before.Stage}/${won.record.before.Onboarding} -> ${won.record.after.Stage}/${won.record.after.Onboarding}, ` +
    `1 run (${won.run.status}), ${won.run.committed} writes, ${won.run.modelCalls} model calls, $${won.run.costUsd}, ` +
    `PATCH answered in ${won.ms} ms, automation's write ${won.automationWriteMs} ms after the PATCH arrived; post: ${won.post[0].text}`,
);
console.log(`Owner only: ${owner.runs} runs, ${owner.posts} posts; runs in all: ${data.runsTotal}`);
console.log(`host: ${host.lines} lines in ${host.files.length} files`);
console.log(`${OUT} (validated under ${data.validatedUnder})`);
