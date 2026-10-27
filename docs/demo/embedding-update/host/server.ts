// The demo product's HTTP face, plain node:http.
//
//   GET   /customers/:tenant/companies
//   POST  /customers/:tenant/companies       { Name, … } → the company, and the runs it fired
//   PATCH /customers/:tenant/companies/:id   { Stage, … } → the company after every run, and the runs
//   *     /customers/:tenant/mcp             the authoring tools over MCP

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Product, tenantOfPath } from './product';

export function productServer(product: Product): Server {
  const authoring = product.authoringHandler();
  return createServer((req, res) => {
    const failed = (error: unknown) => send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    if (tenantOfPath(req.url ?? '/') !== undefined) {
      authoring(req, res).catch(failed);
      return;
    }
    handle(product, req).then(([status, body]) => send(res, status, body), failed);
  });
}

async function handle(product: Product, req: IncomingMessage): Promise<[number, unknown]> {
  const path = (req.url ?? '/').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  if (path[0] !== 'customers' || path[2] !== 'companies') return [404, { error: 'not found' }];
  const tenant = path[1];
  const fields = texts(await readBody(req));
  if (path.length === 3 && req.method === 'GET') return [200, product.companies.list(tenant)];
  if (path.length === 3 && req.method === 'POST') {
    if (fields.Name === undefined) return [400, { error: 'expected { Name, … }' }];
    return [201, await product.create(tenant, fields)];
  }
  if (path.length === 4 && req.method === 'PATCH') {
    const changed = await product.change(tenant, path[3], fields);
    return changed === undefined ? [404, { error: 'no such company' }] : [200, changed];
  }
  return [404, { error: 'not found' }];
}

/** The text fields of a JSON object body. */
function texts(body: string): Record<string, string> {
  const parsed: unknown = body === '' ? {} : JSON.parse(body);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter((field): field is [string, string] => typeof field[1] === 'string'));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
