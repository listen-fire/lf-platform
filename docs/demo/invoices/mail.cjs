// node mail.cjs <fakes url> <serve log> <message.json> <pdf>: drops one
// supplier's email into the fake Gmail mailbox, the PDF attached as its
// bytes, then waits for `listen-fire serve` to print the run its poll started. Prints
// { messageId, runId, sentAt, line }: sentAt is just before the email lands,
// so the run's finish time less it includes the wait for Gmail's next poll.
const fs = require('fs');
const path = require('path');

const [fakes, serveLog, messageFile, pdf] = process.argv.slice(2);
const RUN_LINE = /^run ([0-9a-f-]{36}) .*$/gm;
const runLines = () => [...fs.readFileSync(serveLog, 'utf8').matchAll(RUN_LINE)];

async function main() {
  const message = JSON.parse(fs.readFileSync(messageFile, 'utf8'));
  const seen = runLines().length;
  const sentAt = new Date().toISOString();
  const answer = await fetch(`${fakes}/fake-gmail/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...message,
      attachments: [{ filename: path.basename(pdf), contentType: 'application/pdf', contentBase64: fs.readFileSync(pdf).toString('base64') }],
    }),
  });
  if (answer.status !== 200) throw new Error(`the fake Gmail answered ${answer.status}: ${await answer.text()}`);
  const { id } = await answer.json();
  for (const deadline = Date.now() + 180_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 25))) {
    const lines = runLines();
    if (lines.length > seen) {
      console.log(JSON.stringify({ messageId: id, runId: lines[seen][1], sentAt, line: lines[seen][0] }));
      return;
    }
  }
  throw new Error('no run settled within 180s');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
