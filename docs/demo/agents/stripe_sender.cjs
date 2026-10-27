// node stripe_sender.cjs <plan json> <out jsonl>
// The stand-in Stripe, sending one plan of deliveries to one endpoint, the
// same way whichever option is behind it:
//
// - Each delivery is signed as Stripe signs (`Stripe-Signature: t=…,v1=…`, an
//   HMAC-SHA256 of `<t>.<body>` with the endpoint secret), `created` set when
//   it is first sent.
// - An answer other than 2xx, or no answer, is retried with the same event
//   id, as Stripe retries: here after 1 s, 2 s and 4 s (Stripe's own backoff
//   runs over three days; the recording compresses it), then given up.
// - A plan item may be a duplicate: the same event sent again once the first
//   send was answered, as Stripe does when it redelivers an event.
// - A plan item may first tell the CRM stand-in to answer one call about a
//   customer with a 503 (`failCrm`), or rename a plan value (`renamePlan`).
//
// The plan: { url, secret, fakes, crm (its base URL), crmCalls (its log),
//   items: [{ payment, kind: "original" | "duplicate", file, failCrm?, renamePlan? }] }
// Each delivery, as one JSON line: the item, every attempt (status, answer,
// ms), and what the fakes and the CRM gained from the first attempt to the
// last answer (sent mail, Slack messages, CRM calls).
const fs = require('fs');
const { createHmac } = require('crypto');

const [planFile, out] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const BACKOFF_MS = [1000, 2000, 4000];

async function json(url, init) {
  const answer = await fetch(url, init);
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
  return answer.json();
}
const snapshot = async () => ({
  outbox: (await json(`${plan.fakes}/fake-gmail/state`)).outbox ?? [],
  slack: await json(`${plan.fakes}/admin/slack/message/state`),
  crmLines: fs.readFileSync(plan.crmCalls, 'utf8').split('\n').filter(Boolean).length,
});

async function send(body) {
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', plan.secret).update(`${t}.${body}`).digest('hex');
  const started = Date.now();
  try {
    const answer = await fetch(plan.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)', 'stripe-signature': `t=${t},v1=${signature}` }, body });
    const text = await answer.text();
    return { status: answer.status, answer: text.length > 4000 ? `${text.slice(0, 4000)}…` : text, ms: Date.now() - started };
  } catch (error) {
    return { status: null, answer: String(error.message ?? error), ms: Date.now() - started };
  }
}

async function main() {
  const channels = await json(`${plan.fakes}/admin/slack/channel/state`);
  const bodies = new Map();
  for (const item of plan.items) {
    if (item.failCrm) await json(`${plan.crm}/admin/fail-once`, { method: 'POST', body: JSON.stringify({ crm_id: item.failCrm }) });
    if (item.renamePlan) await json(`${plan.crm}/admin/rename-plan`, { method: 'POST', body: JSON.stringify(item.renamePlan) });
    const event = JSON.parse(fs.readFileSync(item.file, 'utf8'));
    if (!bodies.has(event.id)) bodies.set(event.id, JSON.stringify({ ...event, created: Math.floor(Date.now() / 1000) }));
    const body = bodies.get(event.id);
    const before = await snapshot();
    const attempts = [];
    for (let i = 0; ; i++) {
      const attempt = await send(body);
      attempts.push(attempt);
      if (attempt.status !== null && attempt.status >= 200 && attempt.status < 300) break;
      if (i >= BACKOFF_MS.length) break;
      await new Promise((r) => setTimeout(r, BACKOFF_MS[i]));
    }
    const after = await snapshot();
    const hadMail = new Set(before.outbox.map((m) => m.id));
    const hadPosts = new Set(before.slack.map((m) => m.id));
    const crm = fs.readFileSync(plan.crmCalls, 'utf8').split('\n').filter(Boolean).slice(before.crmLines, after.crmLines).map((l) => JSON.parse(l));
    const record = {
      ...item,
      eventId: event.id,
      attempts,
      delivered: attempts.some((a) => a.status !== null && a.status >= 200 && a.status < 300),
      sent: [
        ...after.outbox.filter((m) => !hadMail.has(m.id)).map((m) => ({ kind: 'email', to: m.to, subject: m.subject, body: m.body })),
        ...after.slack.filter((m) => !hadPosts.has(m.id)).map((m) => ({ kind: 'slack', channel: channels.find((c) => c.id === m.channel)?.name ?? m.channel, text: m.text })),
      ],
      crm: crm.filter((c) => c.caller !== 'admin').map((c) => ({ caller: c.caller, tool: c.tool, args: c.args, answered: c.answered ?? 200, found: c.result?.found ?? null, plan: c.result?.plan ?? null })),
    };
    fs.appendFileSync(out, `${JSON.stringify(record)}\n`);
    console.log(`payment ${item.payment} ${item.kind}: ${attempts.map((a) => a.status ?? 'no answer').join(' → ')}, sent ${record.sent.map((s) => s.kind).join('+') || 'nothing'}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
