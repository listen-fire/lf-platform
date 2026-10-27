// node run_js.cjs <handler file> <fakes url> <crm url> <crm token> <out json> <event file>...
// The JavaScript option's day: the handler the model wrote, run on each event
// in turn in the sandbox (sandbox.cjs) against the stand-ins, for real. For
// each event: what the handler returned or threw, its log, its CRM calls,
// what it sent, and how long it took.
const fs = require('fs');
const path = require('path');
const { openSandbox } = require('./sandbox.cjs');

const [handlerFile, fakes, crmUrl, crmToken, out, ...eventFiles] = process.argv.slice(2);

async function main() {
  const source = fs.readFileSync(handlerFile, 'utf8');
  const sandbox = await openSandbox({ fakes, crmUrl, crmToken, dryRun: false });
  const events = [];
  for (const file of eventFiles) {
    const event = { ...JSON.parse(fs.readFileSync(file, 'utf8')), created: Math.floor(Date.now() / 1000) };
    const ran = await sandbox.run(source, event);
    events.push({ file: path.basename(file), eventId: event.id, billingEmail: event.data.object.customer_email, ...ran, returned: ran.returned === null ? null : JSON.parse(JSON.stringify(ran.returned)) });
    console.log(`${path.basename(file)} ${event.data.object.customer_email}: ${ran.threw ? `threw ${ran.threw.split('\n')[0]}` : 'returned'}, sent ${ran.sent.map((s) => s.kind).join('+') || 'nothing'}, ${ran.ms} ms`);
  }
  await sandbox.close();
  fs.writeFileSync(out, `${JSON.stringify({ events }, null, 1)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
