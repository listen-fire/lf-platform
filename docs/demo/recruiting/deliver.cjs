// node deliver.cjs <fake url> <serve log> <record id> <field> <from> <to> <expect: run|none>
// One edit to a candidate in the fake Airtable, as a person makes it in the
// base: the record's cell is changed, then Airtable's webhook ping goes to
// every webhook of the base that takes the change (the fake's control door
// queues the change, with its previous value, and pings listen-fire serve signed as
// Airtable signs). Then it waits for `listen-fire serve` to print the run it started.
// Prints { ms, runId, line, deliveries, logged }: ms runs from just before the
// edit to the moment the run's settled line appears in the serve log; logged
// is what listen-fire serve printed meanwhile (colour codes stripped). With `none`, it
// waits 5s past the ping's answer and prints runId null when no run appeared
// (and fails if one did).
const fs = require('fs');

const [fake, serveLog, recordId, field, from, to, expect] = process.argv.slice(2);
const RUN_LINE = /^run ([0-9a-f-]{36}) .*$/gm;
const runLines = () => [...fs.readFileSync(serveLog, 'utf8').matchAll(RUN_LINE)];
const logSize = () => fs.statSync(serveLog).size;
const loggedSince = (offset) => fs.readFileSync(serveLog).subarray(offset).toString('utf8')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').filter((l) => l !== '');
const BASE = 'appHIRE01';
const TABLE = 'tblCAND01';

async function call(method, path, body) {
  const answer = await fetch(`${fake}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await answer.text();
  if (answer.status !== 200) throw new Error(`${method} ${path} answered ${answer.status}: ${text}`);
  return JSON.parse(text);
}

async function main() {
  const seen = runLines().length;
  const offset = logSize();
  const started = Date.now();
  await call('PATCH', `/airtable/v0/${BASE}/${TABLE}/${recordId}`, { fields: { [field]: to } });
  const pinged = await call('POST', '/airtable/control/deliver', {
    baseId: BASE, changeType: 'update', tableId: TABLE, recordId, fields: { [field]: to }, previous: { [field]: from },
  });
  const deliveries = pinged.deliveries.map(({ targetUrl, status, body }) => ({ door: new URL(targetUrl).pathname, status, body }));
  if (deliveries.length !== 1 || deliveries[0].status !== 200) throw new Error(`the ping did not reach listen-fire serve: ${JSON.stringify(deliveries)}`);
  if (expect === 'none') {
    await new Promise((r) => setTimeout(r, 5000));
    const lines = runLines();
    if (lines.length > seen) throw new Error(`a run appeared: ${lines[seen][0]}`);
    console.log(JSON.stringify({ ms: null, runId: null, line: null, deliveries, logged: loggedSince(offset) }));
    return;
  }
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 25))) {
    const lines = runLines();
    if (lines.length > seen) {
      const ms = Date.now() - started;
      console.log(JSON.stringify({ ms, runId: lines[seen][1], line: lines[seen][0], deliveries, logged: loggedSince(offset) }));
      return;
    }
  }
  throw new Error('no run settled within 120s');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
