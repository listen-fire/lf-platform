// The per-event agent: a fresh session (the same model as every other agent
// here) for each event Stripe delivers, told what the user asked for, our
// retry email, the operating environment every option is told
// (programs/environment.txt), and the event as Stripe delivered it. Its tools
// reach the same stand-ins the other options reach:
//
//   crm__<tool>       the CRM's MCP tools, as its server lists them (mcp), or
//   crm_request       one request to the CRM's REST API (rest; crm_access.cjs)
//   send_email        a new message from the billing mailbox (the fake Gmail's send API)
//   post_to_slack     a message in a channel (the fake Slack's chat.postMessage)
//   memory_get/_set/_list   a key-value memory kept across sessions (a JSON file)
//
// receivers.cjs puts it behind a webhook endpoint (openAgent). Run directly,
//   node baseline.cjs <fakes url> <crm url> <crm token> <out json> <event file>...
// it handles each event file in turn, as capture.sh's first recording did.
// ANTHROPIC_API_KEY comes from the environment.
const fs = require('fs');
const path = require('path');
const { session, PRICES } = require('./agent_tools.cjs');
const { openCrm } = require('./crm_access.cjs');

const { request, retryEmail: RETRY_EMAIL, environment: ENVIRONMENT, checkAgent } = require('./prompts.cjs');

const SYSTEM = `You are an assistant for Ledgerline's team, with tools for their CRM, their billing mailbox and their Slack, and a memory that lasts between sessions. A while ago the user told you:

> ${request}

You are woken each time Stripe sends Ledgerline a webhook, with the event. Handle it as the user asked, with your tools.

Our retry email:

${RETRY_EMAIL}

${ENVIRONMENT}

${checkAgent} Finish with one line saying what you did.`;

async function json(url, init) {
  const answer = await fetch(url, init);
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}: ${await answer.text()}`);
  return answer.json();
}

function rfc2822({ to, subject, body }) {
  return [`From: billing@ledgerline.io`, `To: ${to.join(', ')}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
}

async function openAgent({ fakes: F, crmUrl, crmToken, memoryFile }) {
  const crm = await openCrm({ url: crmUrl, token: crmToken, caller: 'agent' });
  const crmToolNames = new Set(crm.agentTools().map((t) => t.name));
  const fakes = {
    outbox: async () => (await json(`${F}/fake-gmail/state`)).outbox ?? [],
    slack: async () => json(`${F}/admin/slack/message/state`),
    channels: async () => json(`${F}/admin/slack/channel/state`),
  };
  const memory = () => (memoryFile && fs.existsSync(memoryFile) ? JSON.parse(fs.readFileSync(memoryFile, 'utf8')) : {});
  const tools = [
    ...crm.agentTools(),
    {
      name: 'send_email',
      description: 'Send a new email from the billing mailbox (billing@ledgerline.io).',
      input_schema: {
        type: 'object',
        properties: { to: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain text.' } },
        required: ['to', 'subject', 'body'],
      },
    },
    {
      name: 'post_to_slack',
      description: "Post a message in a channel of Ledgerline's Slack.",
      input_schema: { type: 'object', properties: { channel: { type: 'string', description: 'The channel name, without #.' }, text: { type: 'string' } }, required: ['channel', 'text'] },
    },
    { name: 'memory_get', description: 'Read a value from your memory, by key. Answers null when there is none.', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
    { name: 'memory_set', description: 'Keep a value in your memory under a key, for later sessions.', input_schema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
    { name: 'memory_list', description: 'The keys in your memory, optionally only those starting with a prefix.', input_schema: { type: 'object', properties: { prefix: { type: 'string' } } } },
  ];
  const handleTool = async (name, input) => {
    if (crmToolNames.has(name)) return crm.agentRun(name, input);
    if (name === 'send_email') {
      const raw = Buffer.from(rfc2822(input), 'utf8').toString('base64url');
      const sent = await json(`${F}/gmail/v1/users/me/messages/send`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer stand-in' }, body: JSON.stringify({ raw }) });
      return `sent (${sent.id})`;
    }
    if (name === 'post_to_slack') {
      const channel = (await fakes.channels()).find((c) => c.name === String(input.channel).replace(/^#/, ''));
      if (!channel) throw new Error(`channel_not_found: ${input.channel}`);
      const posted = await json(`${F}/slack/chat.postMessage`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer xoxb-stand-in' }, body: JSON.stringify({ channel: channel.id, text: input.text }) });
      if (posted.ok === false) throw new Error(posted.error);
      return `posted in #${channel.name}`;
    }
    if (name === 'memory_get') return JSON.stringify(memory()[String(input.key)] ?? null);
    if (name === 'memory_set') {
      const all = memory();
      all[String(input.key)] = String(input.value);
      if (memoryFile) fs.writeFileSync(memoryFile, JSON.stringify(all, null, 1));
      return 'kept';
    }
    if (name === 'memory_list') return JSON.stringify(Object.keys(memory()).filter((k) => k.startsWith(String(input.prefix ?? ''))));
    throw new Error(`no tool ${name}`);
  };
  return {
    tools,
    /** One event: the session, and what the fakes gained during it. */
    handle: async (event) => {
      const before = { outbox: new Set((await fakes.outbox()).map((m) => m.id)), slack: new Set((await fakes.slack()).map((m) => m.id)) };
      const user = `Stripe webhook:\n\n\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``;
      const result = await session({ system: SYSTEM, user, tools, handle: handleTool });
      const emails = (await fakes.outbox()).filter((m) => !before.outbox.has(m.id)).map((m) => ({ to: m.to, subject: m.subject, body: m.body }));
      const channels = await fakes.channels();
      const posts = (await fakes.slack()).filter((m) => !before.slack.has(m.id)).map((m) => ({ channel: channels.find((c) => c.id === m.channel)?.name ?? m.channel, text: m.text }));
      return { customerEmail: event.data?.object?.customer_email ?? null, ...result, emails, posts };
    },
    close: () => crm.close(),
  };
}

module.exports = { openAgent, SYSTEM, PRICES };

if (require.main === module) {
  const [F, crmUrl, crmToken, out, ...eventFiles] = process.argv.slice(2);
  (async () => {
    const agent = await openAgent({ fakes: F, crmUrl, crmToken, memoryFile: null });
    const events = [];
    for (const file of eventFiles) {
      const event = JSON.parse(fs.readFileSync(file, 'utf8'));
      const r = await agent.handle(event);
      events.push({ file: path.basename(file), eventId: event.id, ...r });
      console.log(`${path.basename(file)} ${r.customerEmail}: ${r.modelCalls} call(s), $${r.costUsd.toFixed(4)}, ${r.ms} ms, ${r.emails.length} email(s), ${r.posts.length} post(s)`);
    }
    await agent.close();
    fs.writeFileSync(out, `${JSON.stringify({ system: SYSTEM, prices: PRICES, tools: agent.tools.map((t) => ({ name: t.name, description: t.description })), events }, null, 1)}\n`);
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
