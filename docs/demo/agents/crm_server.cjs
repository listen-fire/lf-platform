// node crm_server.cjs <calls log>: the stand-in CRM, an MCP server over
// streamable HTTP (stateless, as listen-fire's own test server), behind a
// bearer token. Two read-only tools over the 40 customers in
// programs/customers.cjs, each with an output schema whose `plan` is the enum
// `monthly | yearly`:
//
//   find_customer_by_email { email }  -> the customer whose CRM email it is
//   get_customer           { crm_id } -> the customer with that CRM id
//
// CRM_SCHEMA=generic serves the CRM as a generic MCP server does: `plan` is a
// plain string in both output schemas, and a third tool answers the
// workspace's fields, each select field's options among them, as data:
//
//   describe_fields {}                -> the fields a customer has, with
//                                        each select field's options
//
// A customer neither finds is answered `found: false`, the other fields null,
// as a CRM's search answers an empty result. Every call is appended to the
// calls log as one JSON line. Prints `listening <port>` once ready.
//
// Two controls for the recording, on /admin (no token, local only):
//   POST /admin/fail-once { crm_id, status? }  the next tools/call about that
//                                        customer (by its CRM id or either of its
//                                        emails) is answered 503 Service
//                                        Unavailable, or 429 Too Many Requests,
//                                        with Retry-After: 1, once
//   POST /admin/rename-plan { from, to } a plan value renamed: the customers on
//                                        it, and the enum in both tools' output
//                                        schemas (generic: the options
//                                        describe_fields answers); nothing is
//                                        announced to connected clients
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { customers } = require('./programs/customers.cjs');

const fromApi = createRequire(path.join(__dirname, '../../../apps/api/package.json'));
const { Server } = fromApi('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = fromApi('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = fromApi('@modelcontextprotocol/sdk/types.js');

const [callsLog] = process.argv.slice(2);
const TOKEN = process.env.CRM_TOKEN ?? 'crm-stand-in-token';

const GENERIC = process.env.CRM_SCHEMA === 'generic';
const PLANS = ['monthly', 'yearly'];
const CUSTOMER = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'Whether the CRM has this customer.' },
    crm_id: { type: ['string', 'null'], description: "The customer's id in the CRM." },
    name: { type: ['string', 'null'], description: 'The contact at the customer.' },
    company: { type: ['string', 'null'] },
    email: { type: ['string', 'null'], description: "The customer's email in the CRM." },
    plan: GENERIC ? { type: ['string', 'null'], description: 'The plan the customer is on.' } : { type: ['string', 'null'], enum: [...PLANS, null], description: 'The plan the customer is on.' },
    account_manager: { type: ['string', 'null'], description: "The customer's account manager." },
  },
  required: ['found'],
};

const TOOLS = [
  {
    name: 'find_customer_by_email',
    description: 'The customer whose email in the CRM is this address.',
    inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
    outputSchema: CUSTOMER,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_customer',
    description: 'The customer with this CRM id.',
    inputSchema: { type: 'object', properties: { crm_id: { type: 'string' } }, required: ['crm_id'] },
    outputSchema: CUSTOMER,
    annotations: { readOnlyHint: true },
  },
];

const FIELDS = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, type: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
        required: ['name', 'type'],
      },
    },
  },
  required: ['fields'],
};
if (GENERIC) {
  TOOLS.push({
    name: 'describe_fields',
    description: "The fields a customer record has in this workspace, with each select field's options.",
    inputSchema: { type: 'object', properties: {} },
    outputSchema: FIELDS,
    annotations: { readOnlyHint: true },
  });
}
const fields = () => ({
  fields: [
    { name: 'crm_id', type: 'text' },
    { name: 'name', type: 'text' },
    { name: 'company', type: 'text' },
    { name: 'email', type: 'email' },
    { name: 'plan', type: 'select', options: [...PLANS] },
    { name: 'account_manager', type: 'text' },
  ],
});

const NOT_FOUND = { found: false, crm_id: null, name: null, company: null, email: null, plan: null, account_manager: null };

function answer(tool, args) {
  if (GENERIC && tool === 'describe_fields') {
    const described = fields();
    return { content: [{ type: 'text', text: JSON.stringify(described) }], structuredContent: described };
  }
  const match =
    tool === 'find_customer_by_email'
      ? customers.find((c) => c.crm.email.toLowerCase() === String(args.email ?? '').trim().toLowerCase())
      : tool === 'get_customer'
        ? customers.find((c) => c.crm.crm_id === String(args.crm_id ?? '').trim())
        : undefined;
  if (tool !== 'find_customer_by_email' && tool !== 'get_customer') {
    return { content: [{ type: 'text', text: `no tool ${tool}` }], isError: true };
  }
  const structured = match ? { found: true, ...match.crm } : NOT_FOUND;
  const text = match ? `${match.crm.name} (${match.crm.company}), ${match.crm.plan} plan, account manager ${match.crm.account_manager}` : 'no matching customer';
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function mcpServer() {
  const server = new Server({ name: 'crm', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    const result = answer(request.params.name, args);
    const caller = extra?.requestInfo?.headers?.['x-crm-caller'] ?? 'lf';
    fs.appendFileSync(callsLog, `${JSON.stringify({ at: new Date().toISOString(), caller, tool: request.params.name, args, result: result.structuredContent ?? null })}\n`);
    return result;
  });
  return server;
}

async function bodyOf(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw === '' ? undefined : JSON.parse(raw);
}

const failOnce = new Map();
const mentions = (crmId, args) => {
  const c = customers.find((x) => x.crm.crm_id === crmId);
  const email = String(args?.email ?? '').toLowerCase();
  return args?.crm_id === crmId || (c && (email === c.crm.email.toLowerCase() || email === c.stripe.email.toLowerCase()));
};

async function admin(req, res, body) {
  if (req.url === '/admin/fail-once') {
    failOnce.set(body.crm_id, body.status === 429 ? 429 : 503);
  } else if (req.url === '/admin/rename-plan') {
    for (const c of customers) if (c.crm.plan === body.from) c.crm.plan = body.to;
    PLANS.splice(PLANS.indexOf(body.from), 1, body.to);
    if (!GENERIC) CUSTOMER.properties.plan.enum = [...PLANS, null];
  } else {
    res.writeHead(404);
    res.end();
    return;
  }
  fs.appendFileSync(callsLog, `${JSON.stringify({ at: new Date().toISOString(), caller: 'admin', admin: req.url, body })}\n`);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, plans: PLANS }));
}

const http = createServer((req, res) => {
  (async () => {
    if (req.url.startsWith('/admin/')) return admin(req, res, (await bodyOf(req)) ?? {});
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    const body = await bodyOf(req);
    const failing = body?.method === 'tools/call' ? [...failOnce.keys()].find((id) => mentions(id, body.params?.arguments)) : undefined;
    if (failing) {
      const status = failOnce.get(failing);
      failOnce.delete(failing);
      fs.appendFileSync(callsLog, `${JSON.stringify({ at: new Date().toISOString(), caller: req.headers['x-crm-caller'] ?? 'lf', tool: body.params?.name, args: body.params?.arguments, answered: status })}\n`);
      res.writeHead(status, { 'content-type': 'text/plain', 'retry-after': '1' });
      res.end(status === 429 ? 'Too Many Requests' : 'Service Unavailable');
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = mcpServer();
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  })().catch((error) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  });
});
http.listen(0, '127.0.0.1', () => console.log(`listening ${http.address().port}`));
