// A small MCP server for the tests and the dev loop, over streamable HTTP
// (stateless: one server and transport per request), behind a token check.
// Two kinds, each with two tools: one read-only with an output schema, one
// that changes things and answers plain text.
//
//   issues:  search_issues { query, limit? } -> { count, titles[] }
//            create_issue  { title, team, priority? } -> text; title "fail" refused
//   crm:     find_customer { email } -> { name, plan }
//            add_note      { customer, body } -> text; body "fail" refused
//
// The language repository's module tests use the same two servers
// (modules/mcp/__test__/fake_server.ts there).

import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';

export type FakeMcpKind = 'issues' | 'crm';

export interface FakeMcpServer {
  url: string;
  /** Every tool call, with the arguments it was sent. */
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** The issues filed, in order (the issues kind). */
  issues: string[];
  /** The notes added, in order (the crm kind). */
  notes: string[];
  close(): Promise<void>;
}

export interface FakeMcpOptions {
  kind: FakeMcpKind;
  /** The token every request must carry: as a bearer, or in `header` as written. */
  token: string;
  header?: string;
  /** Default: any free port. */
  port?: number;
}

const TOOLS: Record<FakeMcpKind, Tool[]> = {
  issues: [
    {
      name: 'search_issues',
      description: 'Issues whose title contains the query.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What to look for.' }, limit: { type: 'integer' } }, required: ['query'] },
      outputSchema: { type: 'object', properties: { count: { type: 'integer' }, titles: { type: 'array', items: { type: 'string' } } }, required: ['count', 'titles'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'create_issue',
      description: 'Files an issue.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, team: { type: 'string', enum: ['ENG', 'OPS'] }, priority: { type: 'integer' } },
        required: ['title', 'team'],
      },
    },
  ],
  crm: [
    {
      name: 'find_customer',
      description: 'The customer with this email.',
      inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
      outputSchema: { type: 'object', properties: { name: { type: 'string' }, plan: { type: 'string' } }, required: ['name', 'plan'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'add_note',
      description: 'Adds a note to a customer.',
      inputSchema: { type: 'object', properties: { customer: { type: 'string' }, body: { type: 'string' } }, required: ['customer', 'body'] },
      annotations: { destructiveHint: false },
    },
  ],
};

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function answer(fake: FakeMcpServer, kind: FakeMcpKind, tool: string, args: Record<string, unknown>): CallToolResult {
  const s = (key: string): string => String(args[key] ?? '');
  switch (`${kind}.${tool}`) {
    case 'issues.search_issues': {
      const titles = fake.issues.filter((t) => t.includes(s('query'))).slice(0, typeof args.limit === 'number' ? args.limit : undefined);
      return { content: [{ type: 'text', text: `${titles.length} issue(s)` }], structuredContent: { count: titles.length, titles } };
    }
    case 'issues.create_issue':
      if (s('title') === 'fail') return text(`team ${s('team')} does not take issues titled "fail"`, true);
      fake.issues.push(s('title'));
      return text(`created ${s('team')}-${fake.issues.length}: ${s('title')}`);
    case 'crm.find_customer':
      return { content: [{ type: 'text', text: `found ${s('email')}` }], structuredContent: { name: s('email').split('@')[0] ?? '', plan: 'pro' } };
    case 'crm.add_note':
      if (s('body') === 'fail') return text(`notes for ${s('customer')} are closed`, true);
      fake.notes.push(`${s('customer')}: ${s('body')}`);
      return text(`noted on ${s('customer')}`);
    default:
      return text(`no tool ${tool}`, true);
  }
}

function mcpServer(fake: FakeMcpServer, kind: FakeMcpKind): Server {
  const server = new Server({ name: `fake-${kind}`, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS[kind] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args: Record<string, unknown> = { ...request.params.arguments };
    fake.calls.push({ tool: request.params.name, args });
    return answer(fake, kind, request.params.name, args);
  });
  return server;
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw === '' ? undefined : JSON.parse(raw);
}

export async function startFakeMcpServer(options: FakeMcpOptions): Promise<FakeMcpServer> {
  const expected = options.header === undefined ? `Bearer ${options.token}` : options.token;
  const presentedIn = (options.header ?? 'authorization').toLowerCase();
  let http: HttpServer | undefined;
  const fake: FakeMcpServer = {
    url: '',
    calls: [],
    issues: ['Login page is slow'],
    notes: [],
    close: () =>
      new Promise((done) => {
        if (http === undefined) return done();
        http.close(() => done());
        http.closeAllConnections();
      }),
  };
  http = createServer((req, res) => {
    void (async () => {
      if (String(req.headers[presentedIn] ?? '') !== expected) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      // Answered as an event stream, as most servers answer, which the client
      // parses itself. (A JSON answer is parsed by the runtime's fetch, and
      // under jest that makes arrays of another realm than the test's, which
      // the engine's wire refuses to carry: a jest artefact, not the
      // platform's.)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = mcpServer(fake, options.kind);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, await bodyOf(req));
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  const server = http;
  await new Promise<void>((done) => server.listen(options.port ?? 0, '127.0.0.1', done));
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  fake.url = `http://127.0.0.1:${port}/mcp`;
  return fake;
}
