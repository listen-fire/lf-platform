// node attio_crm.cjs <fakes url> <calls log>: the stand-in CRM as Attio, for
// the structured scenario. The CRM is fake-channels' Attio (its REST API under
// <fakes>/attio/v2); this puts the 40 customers in it as `people` records and
// serves Attio's REST API in front of it, so that every option reaches the
// same CRM the same way the vendor's own API does, through one door:
//
//   people              the 40 customers: name, email_addresses, and three
//                       attributes of this workspace's own: company (text),
//                       plan (a select: monthly | yearly) and account_manager
//                       (text). A customer's record id is its CRM id
//                       (C-10412, …), the id Stripe's subscription metadata
//                       carries (`crm_id`).
//   /v2/*               Attio's REST API, forwarded to the fake as it is, behind
//                       a bearer token (CRM_TOKEN). Every call is appended to
//                       the calls log as one JSON line, in crm_server.cjs's
//                       shape (`tool` is the method and path, `args` the body).
//
// The same two controls as crm_server.cjs, on /admin (no token, local only):
//   POST /admin/fail-once { crm_id, status? }  the next call that reads
//                                        records (…/records…), whoever makes it, is
//                                        answered 503 Service Unavailable, or 429
//                                        Too Many Requests, with Retry-After: 1,
//                                        once. Not only a call that names the
//                                        customer: Attio's connector lists the
//                                        records page by page and filters them
//                                        itself, so its call names no one. The
//                                        host arms it just before the payment's
//                                        delivery, and nothing else reads
//                                        records in between. `crm_id` is kept in
//                                        the log.
//   POST /admin/rename-plan { from, to } the plan option renamed, as Attio's
//                                        workspace settings rename a select
//                                        option: the option keeps its id and
//                                        takes the new title, and so does every
//                                        record on it. Done through the fake's
//                                        own admin state; nothing is announced.
//
// Prints `listening <port>` once seeded and ready.
const { createServer } = require('node:http');
const fs = require('node:fs');
const { customers } = require('./programs/customers.cjs');

const [fakes, callsLog] = process.argv.slice(2);
const TOKEN = process.env.CRM_TOKEN ?? 'crm-stand-in-token';
const ATTIO = `${fakes}/attio`;
const WORKSPACE = 'test';

async function json(url, init) {
  const answer = await fetch(url, init);
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}: ${await answer.text()}`);
  return answer.json();
}
const seed = (entities) => json(`${fakes}/admin/attio/seed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entities }) });

// Attio's attribute shape, as fake-channels' own seed writes it.
const attribute = (slug, title, type) => ({
  entity_type: 'attribute:people',
  id: slug,
  data: {
    id: { workspace_id: WORKSPACE, object_id: 'people', attribute_id: slug },
    api_slug: slug,
    title,
    description: null,
    type,
    is_multiselect: false,
    is_unique: false,
    is_required: false,
    is_writable: true,
    is_system_attribute: false,
    relationship: null,
    config: {},
  },
});
const OPTION_IDS = { monthly: 'plan-option-1', yearly: 'plan-option-2' };
const optionId = (title) => Object.entries(OPTION_IDS).find(([, id]) => options.get(id) === title)?.[1];
const options = new Map(Object.entries(OPTION_IDS).map(([title, id]) => [id, title]));
const option = (id) => ({
  entity_type: 'option:people:plan',
  id,
  data: { id: { workspace_id: WORKSPACE, object_id: 'people', attribute_id: 'plan', option_id: id }, title: options.get(id), is_archived: false },
});
const record = (c) => {
  const [first, ...rest] = c.crm.name.split(' ');
  const id = OPTION_IDS[c.crm.plan] ?? optionId(c.crm.plan);
  return {
    entity_type: 'record:people',
    id: c.crm.crm_id,
    data: {
      id: { workspace_id: WORKSPACE, object_id: 'people', record_id: c.crm.crm_id },
      values: {
        name: [{ first_name: first, last_name: rest.join(' '), full_name: c.crm.name, attribute_type: 'personal-name' }],
        email_addresses: [{ email_address: c.crm.email, attribute_type: 'email-address' }],
        company: [{ value: c.crm.company, attribute_type: 'text' }],
        plan: [{ option: { id: { workspace_id: WORKSPACE, object_id: 'people', attribute_id: 'plan', option_id: id }, title: options.get(id) }, attribute_type: 'select' }],
        account_manager: [{ value: c.crm.account_manager, attribute_type: 'text' }],
      },
    },
  };
};

let failNext = null;
const log = (entry) => fs.appendFileSync(callsLog, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

/** What a record answer says, for the calls log: how many records, and
 *  when it is one, whether it was found and its plan. */
function resultOf(body) {
  const data = body?.data;
  const records = Array.isArray(data) ? data : data && typeof data === 'object' && data.values ? [data] : null;
  if (!records) return null;
  const one = records.length === 1 ? records[0] : null;
  return { records: records.length, found: records.length > 0, plan: one?.values?.plan?.[0]?.option?.title ?? null };
}

async function bodyOf(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

async function admin(req, res, body) {
  if (req.url === '/admin/fail-once') {
    failNext = { crmId: body.crm_id ?? null, status: body.status === 429 ? 429 : 503 };
  } else if (req.url === '/admin/rename-plan') {
    const id = optionId(body.from);
    if (!id) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `no plan option ${body.from}` }));
      return;
    }
    options.set(id, body.to);
    for (const c of customers) if (c.crm.plan === body.from) c.crm.plan = body.to;
    await seed([option(id), ...customers.filter((c) => c.crm.plan === body.to).map(record)]);
  } else {
    res.writeHead(404);
    res.end();
    return;
  }
  log({ caller: 'admin', admin: req.url, body });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, plans: [...options.values()] }));
}

async function main() {
  await seed([attribute('company', 'Company', 'text'), attribute('plan', 'Plan', 'select'), attribute('account_manager', 'Account manager', 'text'), ...[...options.keys()].map(option), ...customers.map(record)]);
  const http = createServer((req, res) => {
    (async () => {
      const raw = await bodyOf(req);
      if (req.url.startsWith('/admin/')) return admin(req, res, raw === '' ? {} : JSON.parse(raw));
      const caller = req.headers['x-crm-caller'] ?? 'lf';
      const tool = `${req.method} ${req.url}`;
      const args = raw === '' ? null : JSON.parse(raw);
      if (!req.url.startsWith('/v2/')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status_code: 404, type: 'invalid_request_error', code: 'not_found', message: 'Not found' }));
        return;
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status_code: 401, type: 'auth_error', code: 'invalid_token', message: 'Invalid access token' }));
        return;
      }
      if (failNext && req.url.includes('/records')) {
        const { status } = failNext;
        failNext = null;
        log({ caller, tool, args, answered: status });
        res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify(status === 429 ? { status_code: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'Too many requests' } : { status_code: 503, type: 'api_error', code: 'service_unavailable', message: 'Service unavailable' }));
        return;
      }
      const answer = await fetch(`${ATTIO}${req.url}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: raw === '' ? undefined : raw });
      const text = await answer.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {}
      if (req.url.includes('/records')) log({ caller, tool, args, answered: answer.status, result: resultOf(parsed) });
      res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
      res.end(text);
    })().catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  http.listen(0, '127.0.0.1', () => console.log(`listening ${http.address().port}`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
