// node author_js.cjs <fakes url> <crm url> <crm token> <unused> <handler file> <out json>
// The JavaScript option's authoring: one real model session (the same model
// as every other agent here) writes a handler for a sandbox. Its system
// prompt is a general platform's (since 2026-11-03): the sandbox, how a
// handler is triggered, its globals (sandbox.cjs) and the user's connected
// accounts. The user's request is the first message. Its tools:
//
//   web_search, web_fetch   the web every option searches (web.cjs): how
//                    Stripe's events and Attio's REST API look is found there
//   write_handler    replace handler.js
//   test_handler     run handler.js once on a webhook body the agent writes:
//                    CRM calls are real, email and Slack are recorded and not
//                    sent, kv is a store of the test runs' own
//
// No example event is given, and no CRM reference: a platform knows neither.
// (Before 2026-11-03: an example event, the CRM's reference tool and a
// read_handler tool.) The fourth argument, once the example event, is kept
// for compare.sh's call and not read.
const fs = require('fs');
const path = require('path');
const { session, PRICES } = require('./agent_tools.cjs');
const { openSandbox } = require('./sandbox.cjs');

const [fakes, crmUrl, crmToken, , handlerFile, out] = process.argv.slice(2);
const { request, environment, jsDelivery, checkJs } = require('./prompts.cjs');
const { webTools, runWeb } = require('./web.cjs');

// A general platform's prompt: what the sandbox is, how a handler is
// triggered, its globals and the user's connected accounts; nothing about
// what Stripe sends or how the CRM answers (web search finds those).
const system = (crmDoc) => `You are an agent that sets up automations for your user on a JavaScript automation platform. An automation is a handler: you write it once, and the platform runs it in a sandbox for every webhook its endpoint receives, with no model involved.

Write handler.js. It defines \`async function handler(event)\`, which the sandbox calls with each webhook's JSON body, parsed, once the platform has checked the sender's signature. The user's connected accounts send their webhooks to the endpoint: Stripe. Besides standard JavaScript, the sandbox has these globals:

- ${crmDoc}
- \`email\`: \`await email.send({ to, subject, body })\` sends a plain-text email from the user's mailbox, billing@ledgerline.io. \`to\` is an address or a list of them.
- \`slack\`: \`await slack.post({ channel, text })\` posts in a channel of the user's Slack, by its name.
- \`kv\`: a key-value store kept across runs. \`await kv.get(key)\` answers the value or null; \`await kv.set(key, value)\` keeps any JSON value; \`await kv.delete(key)\`.
- \`console.log\`, which goes to the platform's log; \`setTimeout\`.

${jsDelivery}

${environment}

${checkJs} When you are done, finish with a short note to the user.`;

async function main() {
  const sandbox = await openSandbox({ fakes, crmUrl, crmToken, dryRun: true });
  const SYSTEM = system(sandbox.crmDoc);
  const tools = [
    ...webTools,
    { name: 'write_handler', description: 'Replace handler.js with this source, whole.', input_schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
    {
      name: 'test_handler',
      description: "Run handler.js once on a webhook body you give (JSON). Calls to the user's accounts are real, except that email.send and slack.post are recorded and not sent; kv starts empty. Answers what it returned or threw, its log, its CRM calls and what it would have sent.",
      input_schema: { type: 'object', properties: { event: { type: 'object', description: 'The webhook body, as the sender would send it.' } }, required: ['event'] },
    },
  ];
  if (fs.existsSync(handlerFile)) fs.rmSync(handlerFile);
  const handle = async (name, input) => {
    switch (name) {
      case 'write_handler':
        if (typeof input.source !== 'string' || input.source.trim() === '') throw new Error('source must be the whole file');
        fs.writeFileSync(handlerFile, input.source);
        return `wrote handler.js (${input.source.split('\n').length} lines)`;
      case 'test_handler': {
        if (!fs.existsSync(handlerFile)) throw new Error('handler.js does not exist yet');
        const event = typeof input.event === 'string' ? JSON.parse(input.event) : input.event;
        if (event === null || typeof event !== 'object') throw new Error('event must be the webhook body, a JSON object');
        return JSON.stringify(await sandbox.run(fs.readFileSync(handlerFile, 'utf8'), event), null, 1);
      }
      default: {
        const answer = runWeb(name, input);
        if (answer === undefined) throw new Error(`no tool ${name}`);
        return answer;
      }
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
