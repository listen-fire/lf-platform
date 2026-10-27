// How the JavaScript sandbox and the per-event agent reach the CRM, by
// scenario (CRM_KIND, set by compare.sh), so both are given the same door:
//
//   mcp    the CRM's MCP server (crm_server.cjs) through the MCP SDK's own
//          client: the sandbox's `crm` is that client (listTools, callTool),
//          the agent gets the server's tools as its own (`crm__<tool>`).
//   rest   the CRM's REST API (attio_crm.cjs, Attio's API) through a plain
//          HTTP helper that adds the base URL and the access token and keeps
//          nothing between calls: the sandbox's `crm.request(method, path,
//          body)`, the agent's `crm_request` tool. Both are given the API's
//          reference (programs/attio_rest.md).
//
// openCrm({ url, token, caller }) answers:
//   sandboxDoc            the `crm` global, as the sandbox's prompt lists it
//   sandboxGlobal(rec)    the `crm` global; each call is pushed onto rec.crm
//   discovery             { tool, run }: what the JavaScript author and the
//                         woken agent may ask of the CRM besides the handler's
//                         own calls (mcp: its tools/list; rest: the reference)
//   agentTools()          the per-event agent's CRM tools
//   agentRun(name, input) one of them, answered as text
//   close()
const fs = require('fs');
const path = require('path');
const { connectMcp } = require('./agent_tools.cjs');

const KIND = process.env.CRM_KIND === 'rest' ? 'rest' : 'mcp';
const reference = () => fs.readFileSync(path.join(__dirname, 'programs', 'attio_rest.md'), 'utf8').trim();

async function openMcp({ url, token, caller }) {
  const client = await connectMcp(url, { token, caller });
  const { tools } = await client.listTools();
  return {
    kind: 'mcp',
    sandboxDoc:
      "`crm`: an MCP client connected to the user's CRM. `await crm.listTools()` answers `{ tools }` as the server's tools/list does; `await crm.callTool(name, args)` answers the tools/call result, `{ content, structuredContent?, isError? }`.",
    sandboxGlobal: (rec) => ({
      listTools: async () => client.listTools(),
      callTool: async (name, args) => {
        let result;
        try {
          result = await client.callTool({ name, arguments: args ?? {} });
        } catch (error) {
          rec().crm.push({ tool: name, args: args ?? {}, threw: String(error.message ?? error) });
          throw error;
        }
        rec().crm.push({ tool: name, args: args ?? {}, result: result.structuredContent ?? result.content });
        return result;
      },
    }),
    discovery: {
      tool: { name: 'crm_list_tools', description: "The CRM's tools, as `crm.listTools()` answers them.", input_schema: { type: 'object', properties: {} } },
      run: async () => JSON.stringify(await client.listTools(), null, 1),
    },
    agentTools: () =>
      tools.map((t) => ({
        name: `crm__${t.name}`,
        description: `CRM (MCP tool ${t.name}): ${t.description ?? ''}${t.outputSchema ? ` Answers: ${JSON.stringify(t.outputSchema)}` : ''}`,
        input_schema: t.inputSchema,
      })),
    agentRun: async (name, input) => {
      const answer = await client.callTool({ name: name.replace(/^crm__/, ''), arguments: input });
      return JSON.stringify(answer.structuredContent ?? answer.content);
    },
    close: () => client.close(),
  };
}

async function openRest({ url, token, caller }) {
  const base = url.replace(/\/+$/, '');
  async function request(method, route, body) {
    const verb = String(method ?? 'GET').toUpperCase();
    const p = String(route ?? '');
    if (!p.startsWith('/')) throw new Error(`crm.request: the path starts with / (got ${p})`);
    const answer = await fetch(`${base}${p}`, {
      method: verb,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-crm-caller': caller },
      body: body === undefined || body === null || verb === 'GET' ? undefined : JSON.stringify(body),
    });
    const text = await answer.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const headers = {};
    for (const h of ['retry-after', 'content-type']) if (answer.headers.get(h) !== null) headers[h] = answer.headers.get(h);
    return { status: answer.status, headers, body: parsed };
  }
  const requestTool = {
    name: 'crm_request',
    description: `Send one request to the CRM's REST API (Attio), with the workspace's access token. Answers the HTTP status, the headers that matter and the JSON body.\n\n${reference()}`,
    input_schema: {
      type: 'object',
      properties: { method: { type: 'string', description: 'GET, POST, PATCH, …' }, path: { type: 'string', description: 'From /v2, e.g. /v2/objects/people/attributes' }, body: { type: 'object', description: 'The JSON body, for POST and PATCH.' } },
      required: ['method', 'path'],
    },
  };
  return {
    kind: 'rest',
    sandboxDoc:
      "`crm`: the user's CRM, Attio, through its REST API. `await crm.request(method, path, body?)` sends one request (the base URL and the workspace's access token are added) and answers `{ status, headers, body }`, `body` parsed from JSON; it does not throw on an error status. The API's reference is the `crm_api_reference` tool.",
    sandboxGlobal: (rec) => ({
      request: async (method, route, body) => {
        let answer;
        try {
          answer = await request(method, route, body);
        } catch (error) {
          rec().crm.push({ tool: `${method} ${route}`, args: body ?? null, threw: String(error.message ?? error) });
          throw error;
        }
        rec().crm.push({ tool: `${String(method).toUpperCase()} ${route}`, args: body ?? null, status: answer.status, result: answer.body });
        return answer;
      },
    }),
    discovery: {
      tool: { name: 'crm_api_reference', description: "The CRM's REST API reference (Attio), for `crm.request`.", input_schema: { type: 'object', properties: {} } },
      run: async () => reference(),
    },
    agentTools: () => [requestTool],
    agentRun: async (_name, input) => JSON.stringify(await request(input.method, input.path, input.body)),
    close: async () => {},
  };
}

const openCrm = (options) => (KIND === 'rest' ? openRest(options) : openMcp(options));

module.exports = { openCrm, CRM_KIND: KIND };
