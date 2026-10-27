// node author_js.cjs <fakes url> <crm url> <crm token> <example event> <handler file> <out json>
// The JavaScript option's authoring: one real model session (the same model
// as every other agent here) writes a handler for a sandbox. It is given the
// request, our retry email, the sandbox's globals (sandbox.cjs) and one
// example event. Its tools:
//
//   crm_list_tools   the CRM's tools/list, as the sandbox's MCP client gets it
//                    (mcp), or crm_api_reference, the CRM's REST API
//                    reference (rest): crm_access.cjs's discovery
//   read_handler     handler.js as it stands
//   write_handler    replace handler.js
//   test_handler     run handler.js once on the example event: CRM calls are
//                    real, email and Slack are recorded and not sent, kv is
//                    a store of the test runs' own
//
// The test run is the one a sandbox gives: the same single run on the same
// example event the listen-fire option's `lf run --dry-run` gets.
const fs = require('fs');
const path = require('path');
const { session, PRICES } = require('./agent_tools.cjs');
const { openSandbox } = require('./sandbox.cjs');

const [fakes, crmUrl, crmToken, exampleFile, handlerFile, out] = process.argv.slice(2);
const { request, retryEmail, environment, jsDelivery, checkJs } = require('./prompts.cjs');
const example = JSON.parse(fs.readFileSync(exampleFile, 'utf8'));

const system = (crmDoc) => `You are an agent that sets up automations for your user. Automations run in a JavaScript sandbox: you write a handler once, and the sandbox calls it for every event, with no model involved.

When your user asks for one, write handler.js. It defines \`async function handler(event)\`. The sandbox calls it with each Stripe webhook event sent to the user's endpoint, parsed from JSON, after checking Stripe's signature. Besides standard JavaScript, it has these globals:

- ${crmDoc}
- \`email\`: \`await email.send({ to, subject, body })\` sends a plain-text email from the billing mailbox, billing@ledgerline.io. \`to\` is an address or a list of them.
- \`slack\`: \`await slack.post({ channel, text })\` posts in a channel of the team's Slack, by its name.
- \`kv\`: a key-value store kept across events. \`await kv.get(key)\` answers the value or null; \`await kv.set(key, value)\` keeps any JSON value; \`await kv.delete(key)\`.
- \`console.log\`, which goes to the sandbox's log.

${jsDelivery}

${environment}

Our retry email:

${retryEmail}

An example of the event Stripe sends:

\`\`\`json
${JSON.stringify(example, null, 2)}
\`\`\`

${checkJs} When you are done, finish with a short note to the user.`;

async function main() {
  const sandbox = await openSandbox({ fakes, crmUrl, crmToken, dryRun: true });
  const SYSTEM = system(sandbox.crmDoc);
  const tools = [
    sandbox.discovery.tool,
    { name: 'read_handler', description: 'handler.js as it stands.', input_schema: { type: 'object', properties: {} } },
    { name: 'write_handler', description: 'Replace handler.js with this source, whole.', input_schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
    {
      name: 'test_handler',
      description: 'Run handler.js once on the example event. CRM calls are real; email.send and slack.post are recorded and not sent; kv starts empty for the test runs. Answers what it returned or threw, its log, its CRM calls and what it would have sent.',
      input_schema: { type: 'object', properties: {} },
    },
  ];
  if (fs.existsSync(handlerFile)) fs.rmSync(handlerFile);
  const handle = async (name, input) => {
    switch (name) {
      case sandbox.discovery.tool.name:
        return sandbox.discovery.run();
      case 'read_handler':
        return fs.existsSync(handlerFile) ? fs.readFileSync(handlerFile, 'utf8') : '(handler.js does not exist yet)';
      case 'write_handler':
        if (typeof input.source !== 'string' || input.source.trim() === '') throw new Error('source must be the whole file');
        fs.writeFileSync(handlerFile, input.source);
        return `wrote handler.js (${input.source.split('\n').length} lines)`;
      case 'test_handler':
        if (!fs.existsSync(handlerFile)) throw new Error('handler.js does not exist yet');
        return JSON.stringify(await sandbox.run(fs.readFileSync(handlerFile, 'utf8'), example), null, 1);
      default:
        throw new Error(`no tool ${name}`);
    }
  };
  const user = request;
  const result = await session({ system: SYSTEM, user, tools, handle, maxCalls: 60 });
  await sandbox.close();
  const source = fs.existsSync(handlerFile) ? fs.readFileSync(handlerFile, 'utf8') : null;
  fs.writeFileSync(out, `${JSON.stringify({ system: SYSTEM, user, tools: tools.map((t) => ({ name: t.name, description: t.description })), prices: PRICES, source, ...result }, null, 1)}\n`);
  console.log(`js authoring: ${result.modelCalls} model call(s), $${result.costUsd.toFixed(4)}, ${result.ms} ms, stop ${result.stopReason}, handler ${source ? `${source.split('\n').length} lines` : 'none'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
