// .work/compare/<scenario>/capture/* (compare.sh, once per scenario) and
// .work/capture/* (capture.sh, the review)  →  data.js, the only input the
// video page reads. Nothing in it is written by hand. The video is rendered in
// the site repo:
//   node build_data.cjs ../../../../listen-fire-site/video/agents/data.js
//
// The shape of window.DEMO:
//
//   request, retryEmail, environment   what every option is told (prompts.cjs)
//   cheatsheet       the lf cheat sheet the listen-fire author is given
//   validatedUnder   "<lf version> (<branch>@<commit>)", read from the captures' 00_lf.json
//                    (both scenarios must agree)
//   scenarios        { mcp, attio }, the same three options in each, like for like:
//     crm              what the CRM is and how each option reaches it
//                      mcp: an MCP server with generic tools, every option over MCP;
//                      attio: Attio, lf through @lf/attio, the others through its REST API
//     stressors        { duplicated: [n…], transient: [{ n, status }], renamed:
//                      { from, to, beforePayment, waitMs } }
//     payments[]       the 25 payments: n, phase ("day" | "after rename"),
//                      eventId, email, company, plan (in the CRM when it was
//                      paid), accountManager, expected ("retry email" | "slack"),
//                      stressor (null | "duplicated" | "crm 503" | "crm 429")
//     options          { agent, js, lf }, each:
//       label, means
//       costs            three buckets, then their sum:
//         write            { sessions, modelCalls, usage, costUsd, ms }: authoring
//                          (the used attempt's session; nothing for the agent)
//         maintain         { count, modelCalls, costUsd, ms, list[] }: every time the
//                          host woke the agent after the automation went live; each
//                          { why, for (the payment whose run failed and its error, or
//                          the periodic check's error), payment, reason, modelCalls,
//                          costUsd, ms, replays (js), reruns (lf, `lf runs rerun`,
//                          each with force and lf's output), toldUser, changed,
//                          note (its closing note), before/after (when changed) }
//         run              { payments, median: { modelCalls, costUsd, ms }, total:
//                          { modelCalls, costUsd, ms }, perPayment[] }: each
//                          payment's own model calls, cost and run time, over the 25
//                          (a woken agent's sessions are maintenance, not here)
//         total            { modelCalls, costUsd }: write + maintain + run over the 25
//       artefact          (js, lf) { authored, final }: each { lines, source,
//                         measures } (measure.cjs: lines, decision points,
//                         hand-rolled concerns, I/O sites, credentials); final is
//                         the automation after any wake changed it
//       caught            what was refused before anything ran: lf, every `lf
//                         check` during authoring that reported an error
//                         (verbatim); the others []
//       byStressor        { duplicated: [{ n, actedTwice }], transient: [{ n,
//                         status, result, how }], renamed: { caughtBeforePayments
//                         (lf: the periodic check found it before payment 21),
//                         check (that check's output), payments: [{ n, plan,
//                         outcome, what }] } }
//       outcomes          { correct, partial, actedTwice, wrongRoute, failedLoudly,
//                         skippedSilently } over the 25, after any wake's replay
//                         or rerun
//       wentWrong[]       { n, outcome, what } for every payment not plainly right
//       payments[]        per payment: n, outcome, failedFirst, recoveredBy,
//                         deliveries, sent[], errors[], crm[], ms, costUsd, modelCalls
//       attempts[]        (js, lf) every authoring attempt, the same measures and
//                         costs; `used` names the one the rest shows
//       transcript        (js, lf) the used authoring session condensed
//   review           the daily review (capture.sh, earlier, request worded
//                    "yearly"): chosen, attempts, cost, diff, note
//   labels           { real[], standIn[] }
//
// Where each figure comes from:
// - Model calls, usage, cost: the API's own usage per call (agent_tools.cjs),
//   priced at the option's prices. A woken agent's sessions are wake.cjs's;
//   listen-fire's per-run cost is the run record's own (costMicrodollars).
// - Deliveries, failures, wakes, sent, crm: stress.cjs's record of each plan
//   item (what the fakes and the CRM's log gained from its first send until it
//   and any wake it caused were done). What a check-triggered wake sent is
//   given to the payment whose email or company it names.
// - ms: the agent's sessions per payment; JavaScript, the handler's own runs;
//   listen-fire, the send plus the worker's drain (stress.cjs processedMs).
// - expected: the customer's plan in the CRM stand-in's data
//   (programs/customers.cjs): monthly one retry email, yearly (annual_plan
//   after the rename) one Slack post in #accounts naming the account manager.
//   "correct" is that write exactly once by the end; "partial" the Slack post
//   without the account manager; "actedTwice" more than once; "wrongRoute" the
//   other write; "failedLoudly" nothing sent and an error kept;
//   "skippedSilently" nothing sent and nothing failed. failedFirst: the first
//   run of it failed; recoveredBy: what made it right afterwards.
// - measures: measure.cjs, its method at its top.
const fs = require('fs');
const path = require('path');
const { customers } = require('./programs/customers.cjs');
const { measure } = require('./measure.cjs');

const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node build_data.cjs <path to listen-fire-site/video/agents/data.js>');
  process.exit(1);
}
const R = path.join(__dirname, '.work', 'capture');
const r = (f) => JSON.parse(fs.readFileSync(path.join(R, f), 'utf8'));
const rt = (f) => fs.readFileSync(path.join(R, f), 'utf8').replace(/\s+$/, '');
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}… (${s.length} characters)` : s);
const closingNote = (steps) => [...(steps ?? [])].reverse().find((s) => s.role === 'assistant' && s.blocks.some((b) => b.type === 'text'))?.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') ?? '';

/** One scenario's recording (compare.sh SCENARIO=<name>, in
 *  .work/compare/<name>/capture): its stressors, payments and three options. */
const CRMS = {
  mcp: 'MCP vs MCP: the CRM is an MCP server with generic tools (plan a plain string; describe_fields answers the options as data). Every option reaches it over MCP: listen-fire through @lf/mcp, JavaScript and the per-event agent through the MCP SDK client.',
  attio: "Native connector vs REST: the CRM is Attio (plan a select attribute). listen-fire reaches it through its native connector @lf/attio, which publishes the select's options to lf check; JavaScript and the per-event agent through Attio's REST API with a plain HTTP helper.",
};
function scenario(name) {
const C = path.join(__dirname, '.work', 'compare', name, 'capture');
const has = (f) => fs.existsSync(path.join(C, f));
const c = (f) => JSON.parse(fs.readFileSync(path.join(C, f), 'utf8'));
const ct = (f) => fs.readFileSync(path.join(C, f), 'utf8').replace(/\s+$/, '');
const lines = (f) => (has(f) ? ct(f).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lf = c('00_lf.json');
const items = c('plan_items.json');
const renamed = items.find((i) => i.renamePlan);
const payments = [...new Set(items.map((i) => i.payment))].map((n) => {
  const item = items.find((i) => i.payment === n && i.kind === 'original');
  const event = JSON.parse(fs.readFileSync(item.file, 'utf8'));
  const invoice = event.data.object;
  const customer = customers.find((x) => x.stripe.id === invoice.customer);
  const after = n >= renamed.payment;
  return {
    n,
    phase: after ? 'after rename' : 'day',
    eventId: event.id,
    email: invoice.customer_email,
    company: customer.crm.company,
    contact: customer.crm.name,
    plan: after && customer.crm.plan === renamed.renamePlan.from ? renamed.renamePlan.to : customer.crm.plan,
    accountManager: customer.crm.account_manager,
    hostedInvoiceUrl: invoice.hosted_invoice_url,
    expected: customer.crm.plan === 'monthly' ? 'retry email' : 'slack',
    stressor: items.some((i) => i.payment === n && i.kind === 'duplicate') ? 'duplicated' : item.failCrm ? `crm ${item.failStatus}` : null,
  };
});
const stressors = {
  duplicated: payments.filter((p) => p.stressor === 'duplicated').map((p) => p.n),
  transient: items.filter((i) => i.failCrm).map((i) => ({ n: i.payment, status: i.failStatus })),
  renamed: { ...renamed.renamePlan, beforePayment: renamed.payment, waitMs: 45000 },
};
const paymentOf = (s) => {
  const text = s.kind === 'email' ? [].concat(s.to).join(' ') + String(s.body ?? '') : String(s.text ?? '');
  return payments.find((p) => (s.kind === 'email' && [].concat(s.to).join(' ').includes(p.email)) || (s.kind === 'slack' && text.includes(p.company)))?.n ?? null;
};

function judge(p, sent, errors) {
  const emails = sent.filter((s) => s.kind === 'email');
  const posts = sent.filter((s) => s.kind === 'slack');
  const right = p.expected === 'retry email' ? emails : posts;
  const wrong = p.expected === 'retry email' ? posts : emails;
  const what = [];
  let outcome;
  if (wrong.length > 0) {
    outcome = 'wrongRoute';
    what.push(`a ${p.plan} customer got ${p.expected === 'slack' ? 'the retry email' : 'a Slack post'}`);
  } else if (right.length > 1) {
    outcome = 'actedTwice';
    what.push(`sent ${right.length} times`);
  } else if (right.length === 1) {
    outcome = p.expected === 'slack' && !String(right[0].text ?? '').includes(p.accountManager) ? 'partial' : 'correct';
  } else if (errors.length > 0) {
    outcome = 'failedLoudly';
    what.push(`nothing sent; ${String(errors.at(-1)).split('\n')[0]}`);
  } else {
    outcome = 'skippedSilently';
    what.push('nothing sent, nothing failed');
  }
  for (const e of emails) if (!String(e.body ?? '').includes(p.hostedInvoiceUrl)) what.push('the email has no link to the invoice');
  for (const s of posts) {
    if (s.channel !== 'accounts') what.push(`posted in #${s.channel}`);
    if (!String(s.text ?? '').includes(p.accountManager)) what.push(`the post does not name the account manager (${p.accountManager})`);
  }
  return { outcome, what };
}
const OUTCOMES = ['correct', 'partial', 'actedTwice', 'wrongRoute', 'failedLoudly', 'skippedSilently'];
const outcomesOf = (rows) => Object.fromEntries(OUTCOMES.map((o) => [o, rows.filter((x) => x.outcome === o).length]));

/** An option's run through the stressors: per payment, from stress.cjs's
 *  deliveries (and what check wakes sent), plus the receiver's own figures. */
function run(dir, perEvent) {
  const records = lines(`${dir}/deliveries.jsonl`);
  const loose = records.filter((d) => d.payment === null);
  const wakes = lines(`${dir}/wakes.jsonl`);
  const rows = payments.map((p) => {
    const sends = records.filter((d) => d.payment === p.n);
    const sent = [...sends.flatMap((d) => d.sent), ...loose.flatMap((d) => d.sent).filter((s) => paymentOf(s) === p.n)];
    const failures = sends.flatMap((d) => d.failures ?? []);
    const own = perEvent(p, sends);
    const errors = [...failures.map((f) => f.error), ...own.errors];
    const ranAgain = sends.flatMap((d) => d.wakes ?? []).find((w) => w.replays > 0 || (w.reruns ?? 0) > 0);
    const replayed = Boolean(ranAgain) || loose.some((d) => d.sent.some((s) => paymentOf(s) === p.n));
    const { outcome, what } = judge(p, sent, errors);
    const failedFirst = failures.length > 0;
    return {
      n: p.n,
      outcome,
      what,
      failedFirst,
      recoveredBy: failedFirst && ['correct', 'partial', 'actedTwice'].includes(outcome) ? (replayed ? (ranAgain && (ranAgain.reruns ?? 0) > 0 ? "the woken agent's rerun" : "the woken agent's replay") : 'unknown') : null,
      deliveries: sends.map((d) => ({ kind: d.kind, statuses: d.attempts.map((a) => a.status), woke: (d.wakes ?? []).length })),
      sent,
      errors,
      crm: sends.flatMap((d) => d.crm),
      ms: own.ms ?? sum(sends.map((d) => d.processedMs ?? 0)),
      costUsd: own.costUsd ?? 0,
      modelCalls: own.modelCalls ?? 0,
      ...(own.extra ?? {}),
    };
  });
  const checkWakeIndex = records.findIndex((d) => d.kind === 'check wake');
  const firstAfterRename = records.findIndex((d) => d.payment === renamed.payment);
  return { rows, wakes, records, caughtBeforePayments: checkWakeIndex >= 0 && checkWakeIndex < firstAfterRename, check: checkWakeIndex >= 0 ? records[checkWakeIndex].check : null };
}

/** `retriedBy`: who retried a transient CRM failure within the run, when one was. */
function byStressor(rows, extra = {}, retriedBy = 'the code itself') {
  const row = (n) => rows.find((x) => x.n === n);
  return {
    duplicated: stressors.duplicated.map((n) => ({ n, actedTwice: row(n).outcome === 'actedTwice' })),
    transient: stressors.transient.map(({ n, status }) => {
      const x = row(n);
      const ok = ['correct', 'partial', 'actedTwice'].includes(x.outcome);
      const failedCalls = x.crm.filter((q) => q.answered === status).length;
      const how = !ok ? 'lost' : x.failedFirst ? x.recoveredBy : failedCalls > 0 && x.crm.length > failedCalls ? `the call was retried by ${retriedBy}` : 'unaffected';
      return { n, status, result: ok ? 'recovered' : 'lost', how, outcome: x.outcome };
    }),
    renamed: { ...extra, payments: rows.filter((x) => x.n >= renamed.payment).map((x) => ({ n: x.n, plan: payments[x.n - 1].plan, outcome: x.outcome, failedFirst: x.failedFirst, what: x.what.join('; ') })) },
  };
}
const wentWrongOf = (rows) => rows.filter((x) => x.outcome !== 'correct' || x.what.length > 0 || x.failedFirst).map((x) => ({ n: x.n, outcome: x.outcome, failedFirst: x.failedFirst, recoveredBy: x.recoveredBy, what: x.what.join('; ') }));
/** The line of a wake's reason that says what went wrong. */
const whatWentWrong = (reason) =>
  clip(
    String(reason ?? '')
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .find((l) => /error|fail|refus|unknown|not a value|isn't/i.test(l)) ?? String(reason ?? '').split('\n')[0],
    240,
  );
/** Cost to maintain: every time the host woke the agent after the automation
 *  went live, what for, and what it did. A wake belongs to the payment whose
 *  run woke it; a check wake to no payment. */
function maintainOf(records, wakes) {
  const owners = records.flatMap((d) => (d.wakes ?? []).map((w) => ({ n: d.payment, w })));
  const list = wakes.map((w) => {
    const owner = owners.find((o) => o.w.why === w.why && o.w.ms === w.ms);
    const n = owner?.n ?? null;
    return {
      why: w.why,
      for: w.why === 'lf check' ? `the periodic lf check found an error: ${whatWentWrong(w.reason)}` : `payment ${n}'s run failed: ${whatWentWrong(w.reason)}`,
      payment: n,
      reason: clip(w.reason, 600),
      modelCalls: w.modelCalls,
      costUsd: w.costUsd,
      ms: w.ms,
      replays: w.actions.replays.length,
      reruns: (w.actions.reruns ?? []).map((x) => ({ runId: x.runId, force: x.force, output: clip(x.output, 600) })),
      toldUser: w.actions.toldUser,
      changed: w.changed,
      note: closingNote(w.steps),
      before: w.changed ? w.before : undefined,
      after: w.changed ? w.after : undefined,
    };
  });
  return { count: list.length, modelCalls: sum(list.map((w) => w.modelCalls)), costUsd: sum(list.map((w) => w.costUsd)), ms: sum(list.map((w) => w.ms)), list };
}
/** Cost to run, per event: each payment's own model calls, cost and time (a
 *  woken agent's sessions are maintenance, not here), as the median payment
 *  and over all 25. */
function runOf(rows) {
  return {
    payments: rows.length,
    median: { modelCalls: median(rows.map((x) => x.modelCalls)), costUsd: median(rows.map((x) => x.costUsd)), ms: median(rows.map((x) => x.ms)) },
    total: { modelCalls: sum(rows.map((x) => x.modelCalls)), costUsd: sum(rows.map((x) => x.costUsd)), ms: sum(rows.map((x) => x.ms)) },
    perPayment: rows.map((x) => ({ n: x.n, modelCalls: x.modelCalls, costUsd: x.costUsd, ms: x.ms })),
  };
}
/** The three buckets, and their sum over the 25 payments. */
function costsOf(write, maintain, run) {
  return {
    write,
    maintain,
    run,
    total: { modelCalls: write.modelCalls + maintain.modelCalls + run.total.modelCalls, costUsd: write.costUsd + maintain.costUsd + run.total.costUsd },
  };
}
function condensed(session, writeTool) {
  const steps = [];
  for (const step of session.steps) {
    if (step.role === 'assistant') {
      for (const b of step.blocks) {
        if (b.type === 'thinking' && b.summary) steps.push({ kind: 'reasoning', text: b.summary });
        if (b.type === 'text' && b.text.trim()) steps.push({ kind: 'said', text: b.text });
      }
    } else {
      const input = step.name === writeTool ? { source: `(${String(step.input.source ?? '').split('\n').length} lines)` } : step.input;
      const whole = ['lf_check', 'test_run', 'test_handler'].includes(step.name);
      steps.push({ kind: 'tool', name: step.name, input, output: whole ? step.output : clip(step.output, 800), isError: step.isError });
    }
  }
  return steps;
}
const writeOf = (s) => ({ sessions: 1, modelCalls: s.modelCalls, usage: s.usage, costUsd: s.costUsd, ms: s.ms });
const artefact = (kind, file) => {
  if (!has(file)) return null;
  const source = fs.readFileSync(path.join(C, file), 'utf8');
  return { lines: source.trimEnd().split('\n').length, source, measures: measure(kind, source) };
};
const attemptNs = (dir) => (fs.existsSync(path.join(C, dir)) ? fs.readdirSync(path.join(C, dir)).filter((f) => /^attempt_\d+\.json$/.test(f)).map((f) => Number(/\d+/.exec(f)[0])).sort((a, b) => a - b) : []);

// 1. The per-event agent.
const sessions = lines('agent/sessions.jsonl');
const agentRun = run('agent/stress', (p) => {
  const mine = sessions.filter((s) => s.eventId === p.eventId);
  return {
    errors: mine.filter((s) => s.harnessError).map((s) => s.harnessError),
    ms: sum(mine.map((s) => s.ms)),
    costUsd: sum(mine.map((s) => s.costUsd ?? 0)),
    modelCalls: sum(mine.map((s) => s.modelCalls ?? 0)),
    extra: {
      sessions: mine.length,
      notes: mine.map((s) => closingNote(s.steps)),
      memory: mine.flatMap((s) => (s.steps ?? []).filter((x) => x.role === 'tool' && x.name.startsWith('memory_')).map((x) => `${x.name} ${JSON.stringify(x.input)} → ${clip(String(x.output), 120)}`)),
      toolErrors: mine.flatMap((s) => (s.steps ?? []).filter((x) => x.role === 'tool' && x.isError).map((x) => `${x.name}: ${clip(String(x.output), 200)}`)),
    },
  };
});
function inconsistencies(rows) {
  const out = [];
  const emails = rows.flatMap((x) => x.sent.filter((s) => s.kind === 'email').map((s) => ({ n: x.n, ...s })));
  const greetings = new Map();
  for (const e of emails) {
    const p = payments[e.n - 1];
    const first = String(e.body ?? '').split('\n')[0].trim();
    const form = first === `Hi ${p.contact},` ? 'full name' : first === `Hi ${p.contact.split(' ')[0]},` ? 'first name' : `other ("${first}")`;
    greetings.set(form, [...(greetings.get(form) ?? []), e.n]);
  }
  if (greetings.size > 1) out.push({ what: 'greeting', detail: [...greetings].map(([form, ns]) => `${form}: payments ${ns.join(', ')}`).join('; ') });
  return out;
}
const NOTHING_WRITTEN = { sessions: 0, modelCalls: 0, usage: {}, costUsd: 0, ms: 0 };
const agent = {
  label: 'Wake the agent for every event',
  means: 'A model session per delivery, with the CRM, email, Slack and a memory as tools.',
  costs: costsOf(NOTHING_WRITTEN, maintainOf(agentRun.records, []), runOf(agentRun.rows)),
  artefact: null,
  caught: [],
  byStressor: byStressor(agentRun.rows, { caughtBeforePayments: false }, 'the agent'),
  outcomes: outcomesOf(agentRun.rows),
  wentWrong: wentWrongOf(agentRun.rows),
  inconsistencies: inconsistencies(agentRun.rows),
  payments: agentRun.rows.map(({ what, ...x }) => x),
};

// 2. JavaScript.
function jsAttempt(k) {
  const s = c(`js/attempt_${k}.json`);
  const invocations = lines(`js/invocations_${k}.jsonl`);
  const ran = run(`js/stress_${k}`, (p) => {
    const mine = invocations.filter((x) => x.eventId === p.eventId);
    return { errors: [], ms: sum(mine.map((x) => x.ms)), extra: { runs: mine.map((x) => ({ how: x.how, threw: x.threw, logs: x.logs, kv: x.kv })) } };
  });
  return {
    attempt: k,
    costs: costsOf(writeOf(s), maintainOf(ran.records, ran.wakes), runOf(ran.rows)),
    testRuns: s.steps.filter((x) => x.role === 'tool' && x.name === 'test_handler').length,
    artefact: { authored: artefact('js', `js/handler_${k}_authored.js`), final: artefact('js', `js/handler_${k}_final.js`) },
    outcomes: outcomesOf(ran.rows),
    byStressor: byStressor(ran.rows, { caughtBeforePayments: false, note: 'nothing checks the handler between events' }, "the handler's own code"),
    note: closingNote(s.steps),
    ran,
    session: s,
  };
}
// 3. listen-fire.
const lfCrmModule = lf.scenario === 'attio' ? '@lf/attio' : '@lf/mcp';
const errorsIn = (output) => Number(/(\d+) error\(s\)/.exec(output)?.[1] ?? NaN);
function lfAttempt(k) {
  const s = c(`lf/attempt_${k}.json`);
  const checks = s.steps.filter((x) => x.role === 'tool' && x.name === 'lf_check').map((x) => ({ output: x.output, errors: errorsIn(x.output), codes: [...new Set([...x.output.matchAll(/ error (MOV_[A-Z0-9_]+)/g)].map((m) => m[1]))] }));
  const dir = `lf/stress_${k}`;
  const ran = has(`${dir}/deliveries.jsonl`) ? run(dir, () => ({ errors: [] })) : null;
  if (ran) {
    for (const row of ran.rows) {
      const runIds = ran.records.filter((d) => d.payment === row.n).flatMap((d) => [...String(d.drained ?? '').matchAll(/^run ([0-9a-f-]{36})/gm)].map((m) => m[1]));
      const shown = runIds.filter((id) => has(`${dir}/runs/${id}.json`)).map((id) => c(`${dir}/runs/${id}.json`).run);
      row.costUsd = sum(shown.map((x) => x.costMicrodollars / 1e6));
      row.modelCalls = sum(shown.map((x) => (x.trace ?? []).filter((t) => t.kind === 'extraction').length));
      row.runs = shown.map((x) => ({ runId: x.runId, status: x.status, error: x.error ?? null }));
    }
  }
  return {
    attempt: k,
    costs: ran ? costsOf(writeOf(s), maintainOf(ran.records, ran.wakes), runOf(ran.rows)) : null,
    testRuns: s.steps.filter((x) => x.role === 'tool' && x.name === 'test_run').length,
    checks: checks.map((x) => x.errors),
    finalCheckOk: c(`lf/attempt_${k}_check.json`).ok === true,
    artefact: { authored: artefact('lf', `lf/program_${k}_authored.mvt`), final: artefact('lf', `lf/program_${k}_final.mvt`) },
    outcomes: ran ? outcomesOf(ran.rows) : null,
    byStressor: ran ? byStressor(ran.rows, { caughtBeforePayments: ran.caughtBeforePayments, check: ran.check, periodicChecks: lines(`${dir}/checks.jsonl`).map((x) => ({ errors: x.errors, woke: x.woke })) }, `${lfCrmModule}'s backoff (the program has no retry)`) : null,
    note: closingNote(s.steps),
    caught: checks.filter((x) => x.errors > 0).map((x) => ({ output: x.output, codes: x.codes })),
    ran,
    session: s,
  };
}
function option(label, means, attempts, writeTool, extra) {
  const used = attempts[0];
  const { rows } = used.ran;
  return {
    label,
    means,
    costs: used.costs,
    artefact: used.artefact,
    ...extra(used),
    byStressor: used.byStressor,
    outcomes: used.outcomes,
    wentWrong: wentWrongOf(rows),
    payments: rows.map(({ what, ...x }) => x),
    used: used.attempt,
    attempts: attempts.map(({ ran: _r, session: _s, caught: _c, ...a }) => ({ ...a, wentWrong: _r ? wentWrongOf(_r.rows) : null })),
    transcript: condensed(used.session, writeTool),
    prices: used.session.prices,
  };
}
const jsAttempts = attemptNs('js').map(jsAttempt);
const lfAttempts = attemptNs('lf').map(lfAttempt);
const js = option('Write a JavaScript script for a sandbox', 'The model writes a handler once; the sandbox stores each delivery and runs it.', jsAttempts, 'write_handler', () => ({ caught: [] }));
const lfOption = option('Write a listen-fire program', 'The model writes a program once, checked by lf check; lf stores each delivery and runs it.', lfAttempts, 'write_program', (used) => ({ caught: used.caught }));
agent.prices = js.prices;

const problems = [
  ...(payments.length !== 25 ? [`${payments.length} payments`] : []),
  ...(agentRun.rows.some((x) => x.deliveries.length === 0) ? ['the agent missed a payment'] : []),
  ...(jsAttempts.length === 0 || !jsAttempts[0].ran ? ['no JavaScript run'] : []),
  ...(lfAttempts.length === 0 || !lfAttempts[0].ran ? ['no listen-fire run'] : []),
  ...(lfAttempts[0] && !lfAttempts[0].finalCheckOk ? ['the used listen-fire attempt does not check clean'] : []),
  ...(lfAttempts[0]?.ran ? lfAttempts[0].ran.rows.filter((x) => x.modelCalls > 0).map((x) => `listen-fire payment ${x.n} made a model call`) : []),
  ...(lf.scenario !== name ? [`the capture says scenario ${lf.scenario}`] : []),
].map((x) => `${name}: ${x}`);
return {
  lf,
  problems,
  jsAttempts,
  lfAttempts,
  data: {
    crm: CRMS[name],
    stressors,
    payments: payments.map(({ hostedInvoiceUrl, contact, ...p }) => p),
    options: { agent, js, lf: lfOption },
  },
};
}

// The review, as capture.sh recorded it.
const chosen = Number(rt('40_review/chosen.txt'));
const reviewAttempts = fs
  .readdirSync(path.join(R, '40_review'))
  .filter((f) => /^attempt_\d+\.json$/.test(f))
  .map((f) => Number(/\d+/.exec(f)[0]))
  .sort((a, b) => a - b)
  .map((k) => {
    const s = r(`40_review/attempt_${k}.json`);
    return { attempt: k, modelCalls: s.modelCalls, usage: s.usage, costUsd: s.costUsd, ms: s.ms, checkOk: r(`40_review/attempt_${k}_check.json`).ok === true, exceptionsHandled: (rt(`40_review/attempt_${k}_dry_runs.txt`).match(/^run .* completed/gm) ?? []).length, diff: rt(`40_review/attempt_${k}.diff`) };
  });
const chosenReview = r(`40_review/attempt_${chosen}.json`);
const prompts = require('./prompts.cjs');

const SCENARIOS = ['mcp', 'attio'];
const built = Object.fromEntries(SCENARIOS.map((name) => [name, scenario(name)]));
const lfOf = (b) => (b.lf.branches.length > 0 ? `${b.lf.version} (${b.lf.branches.map((x) => `${x.branch}@${x.commit}`).join(', ')})` : b.lf.commit ? `${b.lf.version} (${b.lf.commit})` : b.lf.version);
const validatedUnder = [...new Set(SCENARIOS.map((name) => lfOf(built[name])))];

const data = {
  request: prompts.request,
  retryEmail: prompts.retryEmail,
  environment: prompts.environment,
  cheatsheet: prompts.cheatsheet,
  validatedUnder: validatedUnder[0],
  scenarios: Object.fromEntries(SCENARIOS.map((name) => [name, built[name].data])),
  review: {
    request: rt('01_request.txt'),
    chosen,
    prices: chosenReview.prices,
    attempts: reviewAttempts,
    modelCalls: chosenReview.modelCalls,
    usage: chosenReview.usage,
    costUsd: chosenReview.costUsd,
    ms: chosenReview.ms,
    diff: rt(`40_review/attempt_${chosen}.diff`),
    note: closingNote(chosenReview.steps),
  },
  labels: {
    real: ['every model session: claude-sonnet-5-5, live (authoring, per-event, woken)', 'the JavaScript handler, run in node on every delivery against the stand-ins', 'lf check, lf serve, lf drain and every listen-fire run, with its real modules (@lf/stripe, @lf/mcp, @lf/attio, @lf/gmail, @lf/slack)', 'the daily review, a live session over the real lf runs and lf check'],
    standIn: ['Stripe (signed invoice.payment_failed deliveries from a local sender)', "Stripe's API, for any read @lf/stripe makes beyond the event (listen-fire's fake Stripe, seeded with the same customers)", 'the MCP scenario\'s CRM (a local MCP server with generic tools: plan a plain string, the options answered as data)', 'the Attio scenario\'s CRM (fake-channels\' Attio, behind a local door that adds the token check, the call log and the injected 503 and 429)', 'Gmail and Slack (fake-channels)', 'the sandbox (node vm with crm, email, slack and kv, behind a store-then-acknowledge endpoint)', "the agent provider's host (stress.cjs: the worker, the periodic lf check, waking the agent)"],
  },
};

const problems = [
  ...SCENARIOS.flatMap((name) => built[name].problems),
  ...(validatedUnder.length > 1 ? [`the scenarios were recorded on different lf builds: ${validatedUnder.join(' / ')}`] : []),
  ...(!reviewAttempts.find((a) => a.attempt === chosen)?.checkOk ? ['the chosen review revision does not check clean'] : []),
];
if (problems.length > 0) throw new Error(`refusing to build data.js: ${problems.join('; ')}`);

fs.writeFileSync(OUT, `window.DEMO=${JSON.stringify(data, null, 1)};\n`);
const money = (x) => `$${x.toFixed(4)}`;
const stress = (b) => `dup ${b.duplicated.map((d) => (d.actedTwice ? 'twice' : 'once')).join('/')}; transient ${b.transient.map((t) => `${t.status} ${t.result} (${t.how})`).join(' / ')}; rename ${b.renamed.caughtBeforePayments ? 'caught by the periodic check first; ' : ''}${b.renamed.payments.map((d) => `${d.n}:${d.plan}:${d.outcome}${d.failedFirst ? '(failed first)' : ''}`).join(', ')}`;
const m = (a) => (a ? `${a.measures.lines} lines, ${a.measures.decisionPoints} decisions, ${a.measures.handRolledCount} hand-rolled (${Object.entries(a.measures.handRolled).filter(([, v]) => v.present).map(([k]) => k).join(', ')}), ${a.measures.ioSites.count} I/O sites, credentials ${a.measures.credentials.held}` : 'none');
const buckets = (k) =>
  k
    ? `write ${k.write.modelCalls} calls ${money(k.write.costUsd)} ${(k.write.ms / 1000).toFixed(0)} s | maintain ${k.maintain.count} wake(s) ${k.maintain.modelCalls} calls ${money(k.maintain.costUsd)} | run median ${k.run.median.modelCalls} calls ${money(k.run.median.costUsd)} ${k.run.median.ms} ms, 25: ${k.run.total.modelCalls} calls ${money(k.run.total.costUsd)} | total ${k.total.modelCalls} calls ${money(k.total.costUsd)}`
    : 'not run';
for (const name of SCENARIOS) {
  const { data: d, jsAttempts, lfAttempts } = built[name];
  console.log(`== ${name}: ${d.crm}`);
  console.log(`agent: ${buckets(d.options.agent.costs)}\n  ${JSON.stringify(d.options.agent.outcomes)}\n  ${stress(d.options.agent.byStressor)}`);
  for (const [kind, list] of [['js', jsAttempts], ['lf', lfAttempts]]) {
    for (const a of list) {
      console.log(`${kind} ${a.attempt}: ${buckets(a.costs)}${a.checks ? `; authoring checks ${JSON.stringify(a.checks)}` : ''}`);
      for (const w of a.costs?.maintain.list ?? []) console.log(`  wake: ${w.for} → ${w.modelCalls} calls ${money(w.costUsd)}, ${w.replays} replay(s), ${w.reruns.length} rerun(s), told the user ${w.toldUser.length}, ${w.changed ? 'changed' : 'left'} the automation`);
      console.log(`  authored: ${m(a.artefact.authored)}\n  final:    ${m(a.artefact.final)}`);
      console.log(`  ${JSON.stringify(a.outcomes)}\n  ${a.byStressor ? stress(a.byStressor) : 'not run'}`);
    }
  }
}
console.log(`${OUT} (validated under lf ${data.validatedUnder})`);
