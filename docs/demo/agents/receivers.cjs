// node receivers.cjs js <handler file> <kv file> <store jsonl> <log jsonl> <fakes> <crm url> <crm token> <secret>
// node receivers.cjs agent <memory file> <log jsonl> <fakes> <crm url> <crm token> <secret>
//
// The webhook endpoint in front of the JavaScript option and the per-event
// agent, so the stand-in Stripe delivers to every option the same way. Each
// checks Stripe's signature (401 when it does not verify).
//
// - js, as lf serve does with its doors: the delivery is stored (<store
//   jsonl>) and acknowledged 200 before the handler runs. A repeat of an event
//   id already stored is acknowledged and stored again (the handler is the one
//   to dedupe, as a sandbox leaves it). The handler then runs in the sandbox
//   (sandbox.cjs, its kv in <kv file>), one event at a time, read fresh from
//   <handler file> for each run so a fix takes effect. A handler that throws is
//   logged as failed and not run again by itself.
//     GET  /idle                { pending }: events stored and not yet run
//     POST /replay { eventId }  run the stored event through the handler now,
//                               for real; answers the run's record
// - agent: a fresh agent session for the event (baseline.cjs's agent, with a
//   key-value memory in <memory file>), answered when the session ends: 200,
//   or 500 when the harness itself failed.
//
// Every run is appended to <log jsonl>. Prints `listening <port>`.
const fs = require('fs');
const http = require('http');
const { createHmac, timingSafeEqual } = require('crypto');

const [mode, ...args] = process.argv.slice(2);

function verified(header, body, secret) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${parts.t}.${body}`).digest('hex'));
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const readBody = (req) =>
  new Promise((done) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => done(body));
  });
const answer = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

async function js() {
  const [handlerFile, kvFile, storeFile, logFile, fakes, crmUrl, crmToken, secret] = args;
  const { openSandbox } = require('./sandbox.cjs');
  const sandbox = await openSandbox({ fakes, crmUrl, crmToken, dryRun: false, kvFile });
  const queue = [];
  let running = false;
  const runOne = async (event, how) => {
    const ran = await sandbox.run(fs.readFileSync(handlerFile, 'utf8'), event);
    const record = { at: new Date().toISOString(), eventId: event.id, how, ...ran, returned: ran.returned === null ? null : JSON.parse(JSON.stringify(ran.returned)) };
    fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`);
    return record;
  };
  const drain = async () => {
    if (running) return;
    running = true;
    while (queue.length > 0) {
      await runOne(queue[0], 'delivered');
      queue.shift();
    }
    running = false;
  };
  return async (req, res) => {
    if (req.method === 'GET' && req.url === '/idle') return answer(res, 200, { pending: queue.length });
    const body = await readBody(req);
    if (req.url === '/replay') {
      const { eventId } = JSON.parse(body);
      const stored = fs.readFileSync(storeFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event.id === eventId);
      if (!stored) return answer(res, 404, { error: `no stored event ${eventId}` });
      return answer(res, 200, await runOne(stored.event, 'replayed'));
    }
    if (!verified(req.headers['stripe-signature'], body, secret)) return answer(res, 401, { error: 'bad signature' });
    const event = JSON.parse(body);
    fs.appendFileSync(storeFile, `${JSON.stringify({ at: new Date().toISOString(), event })}\n`);
    queue.push(event);
    answer(res, 200, { received: true });
    drain();
  };
}

async function agent() {
  const [memoryFile, logFile, fakes, crmUrl, crmToken, secret] = args;
  const { openAgent } = require('./baseline.cjs');
  const a = await openAgent({ fakes, crmUrl, crmToken, memoryFile });
  return async (req, res) => {
    const body = await readBody(req);
    if (!verified(req.headers['stripe-signature'], body, secret)) return answer(res, 401, { error: 'bad signature' });
    const event = JSON.parse(body);
    const started = Date.now();
    let status = 200;
    let record;
    try {
      record = await a.handle(event);
    } catch (error) {
      status = 500;
      record = { harnessError: String(error.message ?? error) };
    }
    fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), eventId: event.id, status, ms: Date.now() - started, ...record })}\n`);
    answer(res, status, { received: status === 200 });
  };
}

async function main() {
  const handler = mode === 'js' ? await js() : mode === 'agent' ? await agent() : null;
  if (!handler) throw new Error(`no receiver ${mode}`);
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => answer(res, 500, { error: String(error.message ?? error) }));
  });
  server.listen(0, '127.0.0.1', () => console.log(`listening ${server.address().port}`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
