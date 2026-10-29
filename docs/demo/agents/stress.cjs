// node stress.cjs <config json>
// One option through the stressors, as its host would run it. The stand-in
// Stripe sends each plan item in turn, signed (`Stripe-Signature`), and
// retries an answer other than 2xx after 1, 2 and 4 s under the same event
// id. What happens next is the option's own:
//
// - agent: the endpoint answers once the per-event session has handled it.
// - js: the endpoint stores and acknowledges; the host waits for the sandbox
//   to run it (GET /idle). A run that threw wakes the agent (wake.cjs).
// - lf: `listen-fire serve --doors-only` stores and acknowledges; the host's worker
//   runs it (`listen-fire drain --until-idle`). A run that failed wakes the agent, which
//   may run it again with `listen-fire runs rerun`. The
//   host also runs `listen-fire check` every `checkEveryMs` and wakes the agent when
//   it finds errors it had not reported before.
//
// Plan items may first tell the CRM stand-in to fail one call (`failCrm`,
// with `failStatus` 503 or 429) or rename a plan value (`renamePlan`, after
// which the host waits `renameWaitMs` before the next delivery, as the next
// payment would not arrive at once).
//
// Writes to <out>/: deliveries.jsonl (each item: attempts, what the fakes and
// the CRM gained from its first send until it and any wake it caused were
// done, the failures, the wakes), wakes.jsonl (each session whole), checks.jsonl
// (every periodic listen-fire check).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHmac } = require('crypto');
const { wake } = require('./wake.cjs');

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = (f) => path.join(config.out, f);
const BACKOFF_MS = [1000, 2000, 4000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The host's own reads of the stand-ins' state. A read is asked again once
// when its connection was reset: after a long wait (a 30 s backoff inside a
// run) the stand-in may close the idle connection just as it is reused.
async function json(url, init) {
  let answer;
  try {
    answer = await fetch(url, init);
  } catch (error) {
    if ((init?.method ?? 'GET') !== 'GET') throw error;
    answer = await fetch(url, init);
  }
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
  return answer.json();
}
const crmLog = () => fs.readFileSync(config.crmCalls, 'utf8').split('\n').filter(Boolean);
const snapshot = async () => ({
  outbox: (await json(`${config.fakes}/fake-gmail/state`)).outbox ?? [],
  slack: await json(`${config.fakes}/admin/slack/message/state`),
  crmLines: crmLog().length,
});
let channels = [];
function gained(before, after) {
  const hadMail = new Set(before.outbox.map((m) => m.id));
  const hadPosts = new Set(before.slack.map((m) => m.id));
  return {
    sent: [
      ...after.outbox.filter((m) => !hadMail.has(m.id)).map((m) => ({ kind: 'email', to: m.to, subject: m.subject, body: m.body })),
      ...after.slack.filter((m) => !hadPosts.has(m.id)).map((m) => ({ kind: 'slack', channel: channels.find((c) => c.id === m.channel)?.name ?? m.channel, text: m.text })),
    ],
    crm: crmLog().slice(before.crmLines, after.crmLines).map((l) => JSON.parse(l)).filter((c) => c.caller !== 'admin').map((c) => ({ caller: c.caller, tool: c.tool, args: c.args, answered: c.answered ?? 200, found: c.result?.found ?? null, plan: c.result?.plan ?? null })),
  };
}

async function send(body) {
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', config.secret).update(`${t}.${body}`).digest('hex');
  const started = Date.now();
  try {
    const answer = await fetch(config.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)', 'stripe-signature': `t=${t},v1=${signature}` }, body });
    const text = await answer.text();
    return { status: answer.status, answer: text.slice(0, 4000), ms: Date.now() - started };
  } catch (error) {
    return { status: null, answer: String(error.message ?? error), ms: Date.now() - started };
  }
}
const ok = (a) => a.status !== null && a.status >= 200 && a.status < 300;

// listen-fire's host: the worker, and the periodic check.
const lfEnv = { ...process.env };
function lf(args) {
  const ran = spawnSync(process.env.LF_BIN || 'listen-fire', args, { cwd: config.lf.project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: lfEnv, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const real = fs.realpathSync(config.lf.project);
  return `${ran.stdout ?? ''}${ran.stderr ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(`${real}/`).join('').split(`${config.lf.project}/`).join('');
}
// The modules' JSON log lines are kept apart: among them @lf/mcp's notes of
// each retry it makes.
let moduleLog = [];
const work = () => {
  const printed = lf(['drain', '--until-idle']).split('\n');
  moduleLog = printed.filter((l) => l.startsWith('{'));
  return printed.filter((l) => !l.startsWith('{')).join('\n').trim();
};
const failedRuns = (drained) => [...drained.matchAll(/^run ([0-9a-f-]{36}) .*? failed — .*(?:\n {2}(.*))?$/gm)].map((m) => ({ runId: m[1], error: m[2] ?? '' }));

let handbook;
let describe;
const wakes = [];
async function wakeFor(reason, why) {
  const started = Date.now();
  const w =
    config.mode === 'js'
      ? await wake({ kind: 'js', reason, js: { ...config.js, dry: jsDry } })
      : await wake({ kind: 'lf', reason, lf: { project: config.lf.project, program: config.lf.program, scratch: config.out, describe, handbook } });
  const record = { why, at: new Date().toISOString(), wallMs: Date.now() - started, ...w };
  wakes.push(record);
  fs.appendFileSync(out('wakes.jsonl'), `${JSON.stringify(record)}\n`);
  console.log(`  woke the agent (${why}): ${w.modelCalls} calls, $${w.costUsd.toFixed(4)}, ${config.mode === 'js' ? `${w.actions.replays.length} replay(s)` : `${w.actions.reruns.length} rerun(s)`}, ${w.actions.toldUser.length} message(s) to the user, ${w.changed ? 'changed' : 'left'} the automation`);
  return { why, modelCalls: w.modelCalls, costUsd: w.costUsd, ms: w.ms, replays: w.actions.replays.length, reruns: w.actions.reruns.length, toldUser: w.actions.toldUser, changed: w.changed };
}

let lastCheckAt = 0;
let lastCheckOutput = null;
async function maybeCheck(force = false) {
  if (config.mode !== 'lf' || (!force && Date.now() - lastCheckAt < config.lf.checkEveryMs)) return null;
  lastCheckAt = Date.now();
  const output = lf(['check']).trim();
  const errors = Number(/(\d+) error\(s\)/.exec(output)?.[1] ?? 0);
  const fresh = errors > 0 && output !== lastCheckOutput;
  lastCheckOutput = output;
  const record = { at: new Date().toISOString(), errors, output, woke: fresh };
  fs.appendFileSync(out('checks.jsonl'), `${JSON.stringify(record)}\n`);
  if (!fresh) return null;
  console.log(`  listen-fire check found ${errors} error(s)`);
  const before = await snapshot();
  const w = await wakeFor(`The host's periodic \`listen-fire check\` found new errors:\n\n${output}`, 'lf check');
  const g = gained(before, await snapshot());
  fs.appendFileSync(out('deliveries.jsonl'), `${JSON.stringify({ payment: null, kind: 'check wake', check: output, wakes: [w], ...g })}\n`);
  return w;
}

let jsDry;
async function main() {
  fs.mkdirSync(config.out, { recursive: true });
  channels = await json(`${config.fakes}/admin/slack/channel/state`);
  if (config.mode === 'lf') {
    const { loadHandbook, PROJECT_MODULES } = require('./handbook.cjs');
    handbook = loadHandbook(config.lf.lfSrc, PROJECT_MODULES);
    // Read live, as the authoring agent's was when it was made: `listen-fire catalog`
    // over the scratch program that imports every credential.
    describe = () => {
      const ran = spawnSync(process.env.LF_BIN || 'listen-fire', ['catalog'], { cwd: config.lf.describeProject, encoding: 'utf8', env: lfEnv, maxBuffer: 64 * 1024 * 1024 });
      return `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim();
    };
    await maybeCheck(true);
  }
  if (config.mode === 'js') {
    const { openSandbox } = require('./sandbox.cjs');
    jsDry = await openSandbox({ fakes: config.fakes, crmUrl: config.js.crmUrl, crmToken: config.js.crmToken, dryRun: true });
  }
  const bodies = new Map();
  for (const item of config.items) {
    if (item.failCrm) await json(`${config.crm}/admin/fail-once`, { method: 'POST', body: JSON.stringify({ crm_id: item.failCrm, status: item.failStatus }) });
    if (item.renamePlan) {
      await json(`${config.crm}/admin/rename-plan`, { method: 'POST', body: JSON.stringify(item.renamePlan) });
      console.log(`renamed ${item.renamePlan.from} to ${item.renamePlan.to}; the next payment in ${config.renameWaitMs / 1000} s`);
      for (const until = Date.now() + config.renameWaitMs; Date.now() < until; await sleep(500)) await maybeCheck();
    }
    await maybeCheck();
    const event = JSON.parse(fs.readFileSync(item.file, 'utf8'));
    if (!bodies.has(event.id)) bodies.set(event.id, JSON.stringify({ ...event, created: Math.floor(Date.now() / 1000) }));
    const before = await snapshot();
    const started = Date.now();
    const attempts = [];
    for (let i = 0; ; i++) {
      const attempt = await send(bodies.get(event.id));
      attempts.push(attempt);
      if (ok(attempt) || i >= BACKOFF_MS.length) break;
      await sleep(BACKOFF_MS[i]);
    }
    let drained = null;
    let retryNotes = [];
    let failures = [];
    const logBefore = config.mode === 'js' && fs.existsSync(config.js.logFile) ? fs.readFileSync(config.js.logFile, 'utf8').split('\n').filter(Boolean).length : 0;
    if (config.mode === 'lf') {
      drained = work();
      retryNotes = moduleLog.filter((l) => /retrying/.test(l));
      failures = failedRuns(drained);
    } else if (config.mode === 'js') {
      for (;;) {
        if ((await json(`${config.js.receiver}/idle`)).pending === 0) break;
        await sleep(50);
      }
      const runs = fs.existsSync(config.js.logFile) ? fs.readFileSync(config.js.logFile, 'utf8').split('\n').filter(Boolean).slice(logBefore).map((l) => JSON.parse(l)) : [];
      failures = runs.filter((r) => r.threw).map((r) => ({ eventId: r.eventId, error: r.threw }));
    }
    const processedMs = Date.now() - started;
    const itemWakes = [];
    for (const f of failures) {
      const reason =
        config.mode === 'lf'
          ? `A run failed.\n\nRun ${f.runId} (payment_failed:Payment Failed): ${f.error}\n\n\`listen-fire runs show ${f.runId}\` has its event, trace and attempts.`
          : `The handler failed on event ${f.eventId}.\n\n${f.error}\n\nThe event is stored; sandbox_log has the run.`;
      itemWakes.push(await wakeFor(reason, 'run failed'));
    }
    const g = gained(before, await snapshot());
    const record = { ...item, eventId: event.id, attempts, delivered: attempts.some(ok), processedMs, drained, retryNotes, failures, wakes: itemWakes, ...g };
    fs.appendFileSync(out('deliveries.jsonl'), `${JSON.stringify(record)}\n`);
    console.log(`payment ${item.payment} ${item.kind}: ${attempts.map((a) => a.status ?? 'no answer').join(' → ')}, ${failures.length ? `failed (${failures.length})` : 'ok'}, sent ${g.sent.map((s) => s.kind).join('+') || 'nothing'}`);
  }
  await maybeCheck(true);
  if (jsDry) await jsDry.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
