// The JavaScript option's sandbox: what a handler the model writes can reach,
// and how it is run. The handler is plain JavaScript run in a fresh `vm`
// context per event, with three globals besides the language's own:
//
//   crm     the CRM, as the scenario reaches it (crm_access.cjs): an MCP
//           client (listTools, callTool) or Attio's REST API (request)
//   email   send({ to, subject, body }): a new message from the billing
//           mailbox (the fake Gmail's send API)
//   slack   post({ channel, text }): a message in a channel, by name (the
//           fake Slack's chat.postMessage)
//   kv      get(key), set(key, value), delete(key): a key-value store kept
//           across events (a JSON file); the test run gets an empty one
//
// and a console whose lines are kept, and the runtime's timers (setTimeout,
// clearTimeout), as every JavaScript runtime a sandbox runs on has them. With `dryRun`, email and Slack record
// what would be sent and send nothing (the authoring test run); the CRM is
// always real.
const fs = require('fs');
const vm = require('vm');
const { openCrm } = require('./crm_access.cjs');

async function json(url, init) {
  const answer = await fetch(url, init);
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}: ${await answer.text()}`);
  return answer.json();
}

function rfc2822({ to, subject, body }) {
  return [`From: billing@ledgerline.io`, `To: ${to.join(', ')}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
}

async function openSandbox({ fakes, crmUrl, crmToken, dryRun, kvFile }) {
  const access = await openCrm({ url: crmUrl, token: crmToken, caller: dryRun ? 'js-authoring' : 'js' });
  let record = { sent: [], crm: [], logs: [], kv: [] };
  const crm = access.sandboxGlobal(() => record);
  const email = {
    send: async ({ to, subject, body } = {}) => {
      const list = (Array.isArray(to) ? to : [to]).filter((t) => typeof t === 'string' && t !== '');
      if (list.length === 0) throw new Error('email.send: no recipient');
      record.sent.push({ kind: 'email', to: list, subject, body });
      if (dryRun) return { id: 'not-sent (test run)' };
      const raw = Buffer.from(rfc2822({ to: list, subject: String(subject ?? ''), body: String(body ?? '') }), 'utf8').toString('base64url');
      return json(`${fakes}/gmail/v1/users/me/messages/send`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer stand-in' }, body: JSON.stringify({ raw }) });
    },
  };
  const slack = {
    post: async ({ channel, text } = {}) => {
      const name = String(channel ?? '').replace(/^#/, '');
      const found = (await json(`${fakes}/admin/slack/channel/state`)).find((c) => c.name === name || c.id === name);
      if (!found) throw new Error(`slack.post: channel_not_found (${channel})`);
      record.sent.push({ kind: 'slack', channel: found.name, text });
      if (dryRun) return { ok: true, ts: 'not-sent (test run)' };
      const posted = await json(`${fakes}/slack/chat.postMessage`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer xoxb-stand-in' }, body: JSON.stringify({ channel: found.id, text }) });
      if (posted.ok === false) throw new Error(`slack.post: ${posted.error}`);
      return posted;
    },
  };
  let memory = {};
  const load = () => (kvFile && fs.existsSync(kvFile) ? JSON.parse(fs.readFileSync(kvFile, 'utf8')) : memory);
  const save = (all) => (kvFile ? fs.writeFileSync(kvFile, JSON.stringify(all, null, 1)) : (memory = all));
  const kv = {
    get: async (key) => {
      const value = load()[String(key)];
      record.kv.push({ op: 'get', key: String(key), found: value !== undefined });
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    },
    set: async (key, value) => {
      const all = load();
      all[String(key)] = value === undefined ? null : JSON.parse(JSON.stringify(value));
      save(all);
      record.kv.push({ op: 'set', key: String(key) });
    },
    delete: async (key) => {
      const all = load();
      delete all[String(key)];
      save(all);
      record.kv.push({ op: 'delete', key: String(key) });
    },
  };
  const line = (...args) => record.logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  const console = { log: line, info: line, warn: line, error: line };

  /** One event through the handler: what it returned or threw, its log, its
   *  CRM calls and what it sent. */
  async function run(source, event, timeoutMs = 30_000) {
    record = { sent: [], crm: [], logs: [], kv: [] };
    const started = Date.now();
    let returned;
    let threw = null;
    try {
      const context = vm.createContext({ crm, email, slack, kv, console, setTimeout, clearTimeout });
      const handler = new vm.Script(`${source}\n;typeof handler === 'function' ? handler : undefined`, { filename: 'handler.js' }).runInContext(context);
      if (typeof handler !== 'function') throw new Error('handler.js defines no function handler');
      returned = await Promise.race([handler(JSON.parse(JSON.stringify(event))), new Promise((_, no) => setTimeout(() => no(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs))]);
    } catch (error) {
      threw = error && error.stack ? String(error.stack).split('\n').slice(0, 3).join('\n') : String(error);
    }
    return { ms: Date.now() - started, returned: returned === undefined ? null : returned, threw, ...record };
  }
  return { run, crmDoc: access.sandboxDoc, discovery: access.discovery, close: () => access.close() };
}

module.exports = { openSandbox };
