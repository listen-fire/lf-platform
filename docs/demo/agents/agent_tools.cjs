// What the two real agents in this recording share: the Anthropic client, the
// model and the prices its cost is figured at, the CRM's MCP tools offered to
// the model as they are listed by the server, and one tool-use loop that
// records every call it makes.
//
// The SDKs are the platform API's own (apps/api), so the recording needs no
// install of its own.
const path = require('path');
const { createRequire } = require('module');

const fromApi = createRequire(path.join(__dirname, '../../../apps/api/package.json'));
const Anthropic = fromApi('@anthropic-ai/sdk');
const { Client } = fromApi('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = fromApi('@modelcontextprotocol/sdk/client/streamableHttp.js');

const MODEL = 'claude-sonnet-5-5';
// US dollars per million tokens, Claude API first-party rates for this model
// (the claude-api skill's model table, cached 2026-10-06: input $2, output
// $10, cache reads $0.20; a five-minute cache write is 1.25x input).
const PRICES = { model: MODEL, source: 'claude-api skill model table (cached 2026-10-06); cache write = 1.25 x input (5-minute TTL)', inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2 };

function costOf(usage) {
  return (
    ((usage.input_tokens ?? 0) * PRICES.inputPerMTok +
      (usage.output_tokens ?? 0) * PRICES.outputPerMTok +
      (usage.cache_creation_input_tokens ?? 0) * PRICES.cacheWritePerMTok +
      (usage.cache_read_input_tokens ?? 0) * PRICES.cacheReadPerMTok) /
    1e6
  );
}

function addUsage(total, usage) {
  for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    total[key] = (total[key] ?? 0) + (usage[key] ?? 0);
  }
  return total;
}

/** An MCP client as every harness here opens it: the SDK's own. */
async function connectMcp(url, { token, caller }) {
  const client = new Client({ name: caller, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}`, 'x-crm-caller': caller } } }));
  return client;
}

/** The CRM over MCP, its tools offered to the model under `crm__<tool>`, each
 *  described with what it answers (its output schema), as listed when the
 *  client connected. */
async function crmTools(url, token, caller) {
  const client = await connectMcp(url, { token, caller });
  const { tools } = await client.listTools();
  const offered = tools.map((t) => ({
    name: `crm__${t.name}`,
    description: `CRM (MCP tool ${t.name}): ${t.description ?? ''}${t.outputSchema ? ` Answers: ${JSON.stringify(t.outputSchema)}` : ''}`,
    input_schema: t.inputSchema,
  }));
  const run = async (name, input) => {
    const answer = await client.callTool({ name: name.replace(/^crm__/, ''), arguments: input });
    return JSON.stringify(answer.structuredContent ?? answer.content);
  };
  return { offered: () => offered, run, close: () => client.close() };
}

/**
 * One agent session: the loop until the model stops asking for tools. Every
 * model call's usage and every block it returned are recorded, with each
 * tool's input and the output it was given.
 */
async function session({ system, user, tools, handle, maxCalls = 40, effort = 'high' }) {
  const client = new Anthropic();
  const messages = [{ role: 'user', content: user }];
  const steps = [];
  const calls = [];
  const usage = {};
  const started = Date.now();
  for (let i = 0; i < maxCalls; i++) {
    const callStarted = Date.now();
    const response = await client.messages
      .stream({
        model: MODEL,
        max_tokens: 32000,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort },
        cache_control: { type: 'ephemeral' },
        system,
        tools,
        messages,
      })
      .finalMessage();
    calls.push({ ms: Date.now() - callStarted, stopReason: response.stop_reason, usage: response.usage, costUsd: costOf(response.usage) });
    addUsage(usage, response.usage);
    messages.push({ role: 'assistant', content: response.content });
    steps.push({
      role: 'assistant',
      blocks: response.content.map((b) =>
        b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'thinking' ? { type: 'thinking', summary: b.thinking } : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : { type: b.type },
      ),
    });
    if (response.stop_reason !== 'tool_use') break;
    const results = [];
    for (const block of response.content.filter((b) => b.type === 'tool_use')) {
      let output;
      let isError = false;
      try {
        output = await handle(block.name, block.input);
      } catch (error) {
        output = String(error.message ?? error);
        isError = true;
      }
      steps.push({ role: 'tool', id: block.id, name: block.name, input: block.input, output, isError });
      results.push({ type: 'tool_result', tool_use_id: block.id, content: output, ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  const last = calls[calls.length - 1];
  return { model: MODEL, ms: Date.now() - started, modelCalls: calls.length, stopReason: last?.stopReason ?? null, usage, costUsd: costOf(usage), calls, steps };
}

module.exports = { MODEL, PRICES, costOf, connectMcp, crmTools, session };
