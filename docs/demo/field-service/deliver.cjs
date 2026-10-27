// node deliver.cjs <door url> <app secret> <serve log> <from> <profile name> <text>
// Sends one Meta-shaped WhatsApp delivery, signed `x-hub-signature-256` with
// the app secret as Meta signs it, then waits for `lf serve` to print the run
// it started. Prints { runId, ms, door }: ms runs from just before the POST to
// the moment the run's settled line appears in the serve log.
const fs = require('fs');
const { createHmac } = require('crypto');

const [door, secret, serveLog, from, profileName, text] = process.argv.slice(2);
const RUN_LINE = /^run ([0-9a-f-]{36}) .*$/gm;
const runLines = () => [...fs.readFileSync(serveLog, 'utf8').matchAll(RUN_LINE)];

async function main() {
  const seen = runLines().length;
  const now = Date.now();
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba-field-service',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '+447700900000', phone_number_id: '100200300' },
          contacts: [{ profile: { name: profileName }, wa_id: from }],
          messages: [{ from, id: `wamid.${now}`, timestamp: String(Math.floor(now / 1000)), type: 'text', text: { body: text } }],
        },
      }],
    }],
  });
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  const started = Date.now();
  const answer = await fetch(door, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` },
    body,
  });
  const doorAnswer = await answer.text();
  if (answer.status !== 200) throw new Error(`the door answered ${answer.status}: ${doorAnswer}`);
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 25))) {
    const lines = runLines();
    if (lines.length > seen) {
      const ms = Date.now() - started;
      console.log(JSON.stringify({ runId: lines[seen][1], ms, line: lines[seen][0], door: JSON.parse(doorAnswer) }));
      return;
    }
  }
  throw new Error('no run settled within 120s');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
