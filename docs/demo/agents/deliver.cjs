// node deliver.cjs <hook url> <signing secret> <serve log> <event file>:
// sends one event as Stripe does: `created` set to now, the body signed with
// the endpoint's secret in a `Stripe-Signature` header (`t=…,v1=…`, an
// HMAC-SHA256 of `<t>.<body>`). Then waits for `lf serve` to print the run it
// started. Prints { runId, ms, line, answer, body }: ms runs from just before
// the POST to the moment the run's settled line appears in the serve log, and
// body is the exact JSON that was sent.
const fs = require('fs');
const { createHmac } = require('crypto');

const [url, secret, serveLog, eventFile] = process.argv.slice(2);
const RUN_LINE = /^run ([0-9a-f-]{36}) .*$/gm;
const runLines = () => [...fs.readFileSync(serveLog, 'utf8').matchAll(RUN_LINE)];

async function main() {
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  const seen = runLines().length;
  const t = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ ...event, created: t });
  const signature = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const started = Date.now();
  const answer = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)', 'stripe-signature': `t=${t},v1=${signature}` },
    body,
  });
  const answerText = await answer.text();
  if (answer.status !== 202) throw new Error(`the hook answered ${answer.status}: ${answerText}`);
  if (JSON.parse(answerText).duplicate === true) throw new Error(`the hook took ${event.id} as a repeat and ran nothing: ${answerText}`);
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 20))) {
    const lines = runLines();
    if (lines.length > seen) {
      const ms = Date.now() - started;
      console.log(JSON.stringify({ runId: lines[seen][1], ms, line: lines[seen][0], answer: JSON.parse(answerText), body: JSON.parse(body) }));
      return;
    }
  }
  throw new Error('no run settled within 120s');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
