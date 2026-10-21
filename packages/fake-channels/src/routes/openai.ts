import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { openAiCapabilityRoutes } from './openai_capabilities';

// A stand-in for OpenAI's chat completions (and, through
// `openai_capabilities.ts`, transcription, embeddings and images), enough to run the model map's
// OpenAI translator end to end: every request is checked against OpenAI's
// documented body the way OpenAI checks it (unknown top-level fields and
// orphaned tool messages are 400s there too), and the reply is a canned
// scenario, streamed or whole.
//
// Scenarios, chosen by the `X-Fake-Scenario` header:
//   text              — a short text reply, finish `stop`.
//   tool_call         — a call to the named or first tool, with arguments
//                       built from its JSON schema, finish `tool_calls`.
//   length            — text cut off, finish `length`.
//   partial_tool_json — a tool call whose arguments stop mid-JSON, finish
//                       `length`.
// With no header the fake behaves like a model would: it calls a tool when
// one is forced, or when tools are offered and no result has come back since
// the last user turn, and otherwise answers in text. That default is what lets
// a caller that cannot set headers (the API's own wrapper) run a whole tool
// loop against it.

// ── request schema ───────────────────────────────────────────────────────
// https://platform.openai.com/docs/api-reference/chat/create

const textPart = z.object({ type: z.literal('text'), text: z.string() }).strict();

const userPart = z.discriminatedUnion('type', [
  textPart,
  z
    .object({
      type: z.literal('image_url'),
      image_url: z
        .object({
          url: z.string().regex(/^(https?:\/\/|data:image\/(png|jpeg|gif|webp);base64,)/),
          detail: z.enum(['auto', 'low', 'high']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('file'),
      file: z
        .object({
          file_data: z.string().regex(/^data:application\/pdf;base64,/).optional(),
          file_id: z.string().optional(),
          filename: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('input_audio'),
      input_audio: z.object({ data: z.string(), format: z.enum(['wav', 'mp3']) }).strict(),
    })
    .strict(),
]);

const toolCall = z
  .object({
    id: z.string().min(1),
    type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }).strict(),
  })
  .strict();

const message = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('system'),
      content: z.union([z.string(), z.array(textPart)]),
      name: z.string().optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('developer'),
      content: z.union([z.string(), z.array(textPart)]),
      name: z.string().optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('user'),
      content: z.union([z.string(), z.array(userPart).min(1)]),
      name: z.string().optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.union([z.string(), z.array(textPart), z.null()]).optional(),
      tool_calls: z.array(toolCall).min(1).optional(),
      refusal: z.string().nullable().optional(),
      name: z.string().optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('tool'),
      content: z.union([z.string(), z.array(textPart)]),
      tool_call_id: z.string().min(1),
    })
    .strict(),
]);

const functionTool = z
  .object({
    type: z.literal('function'),
    function: z
      .object({
        name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        strict: z.boolean().nullable().optional(),
      })
      .strict(),
  })
  .strict();

const chatCompletionBody = z
  .object({
    model: z.string().min(1),
    messages: z.array(message).min(1),
    max_completion_tokens: z.number().int().positive().nullable().optional(),
    max_tokens: z.number().int().positive().nullable().optional(),
    stream: z.boolean().nullable().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).strict().nullable().optional(),
    tools: z.array(functionTool).min(1).optional(),
    tool_choice: z
      .union([
        z.enum(['none', 'auto', 'required']),
        z.object({ type: z.literal('function'), function: z.object({ name: z.string() }).strict() }).strict(),
      ])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).nullable().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    top_p: z.number().min(0).max(1).nullable().optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).nullable().optional(),
    n: z.literal(1).nullable().optional(),
    seed: z.number().int().nullable().optional(),
    user: z.string().optional(),
    metadata: z.record(z.string(), z.string()).nullable().optional(),
    response_format: z.object({ type: z.enum(['text', 'json_object', 'json_schema']) }).passthrough().optional(),
  })
  .strict();

type ChatCompletionBody = z.infer<typeof chatCompletionBody>;
type FunctionTool = z.infer<typeof functionTool>;

/** What OpenAI checks beyond the shape: a tool message answers a call the
 *  assistant turn right before it made, and every such call is answered
 *  before the conversation moves on. Returns the complaint, if any. */
function toolOrderProblem(messages: ChatCompletionBody['messages']): string | undefined {
  let awaiting = new Set<string>();
  for (const [i, m] of messages.entries()) {
    if (m.role === 'tool') {
      if (!awaiting.delete(m.tool_call_id)) {
        return `messages[${i}]: a tool message with tool_call_id "${m.tool_call_id}" must respond to a preceding assistant message's tool_calls.`;
      }
      continue;
    }
    if (awaiting.size > 0) {
      return `messages[${i}]: an assistant message with tool_calls must be followed by tool messages responding to each tool_call_id (missing: ${[...awaiting].join(', ')}).`;
    }
    awaiting = new Set(m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : []);
  }
  return undefined;
}

// ── scenarios ────────────────────────────────────────────────────────────

const scenarios = ['text', 'tool_call', 'length', 'partial_tool_json'] as const;
type Scenario = (typeof scenarios)[number];

function isScenario(value: string): value is Scenario {
  return scenarios.some((s) => s === value);
}

function inferScenario(body: ChatCompletionBody): Scenario {
  if (!body.tools || body.tool_choice === 'none') return 'text';
  if (body.tool_choice === 'required' || typeof body.tool_choice === 'object') return 'tool_call';
  const last = body.messages[body.messages.length - 1];
  return last.role === 'user' ? 'tool_call' : 'text';
}

/** A value that satisfies `schema`, as far as a fake needs: every required
 *  property present, with the first enum value or a plain value of its type. */
function sampleFromSchema(schema: unknown, root: unknown = schema): unknown {
  const s = z.record(z.string(), z.unknown()).safeParse(schema);
  if (!s.success) return null;
  const node = s.data;
  if (typeof node.$ref === 'string') {
    const name = /^#\/\$defs\/(.+)$/.exec(node.$ref)?.[1];
    const defs = z.object({ $defs: z.record(z.string(), z.unknown()) }).safeParse(root);
    return name && defs.success ? sampleFromSchema(defs.data.$defs[name], root) : null;
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  if ('const' in node) return node.const;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const options = node[key];
    if (Array.isArray(options) && options.length > 0) return sampleFromSchema(options[0], root);
  }
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case 'object': {
      const properties = z.record(z.string(), z.unknown()).safeParse(node.properties);
      const required = z.array(z.string()).safeParse(node.required);
      const out: Record<string, unknown> = {};
      for (const key of required.success ? required.data : []) {
        out[key] = sampleFromSchema(properties.success ? properties.data[key] : undefined, root);
      }
      return out;
    }
    case 'array':
      return [sampleFromSchema(node.items, root)];
    case 'string':
      return 'fake';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    default:
      return null;
  }
}

function toolFor(body: ChatCompletionBody): FunctionTool | undefined {
  const named = typeof body.tool_choice === 'object' ? body.tool_choice.function.name : undefined;
  return named ? body.tools?.find((t) => t.function.name === named) : body.tools?.[0];
}

interface Reply {
  content: string | null;
  toolCall?: { id: string; name: string; arguments: string };
  finish: 'stop' | 'length' | 'tool_calls';
}

let callCounter = 0;

function replyFor(scenario: Scenario, body: ChatCompletionBody): Reply | string {
  switch (scenario) {
    case 'text': {
      const results = body.messages.filter((m) => m.role === 'tool').length;
      return {
        content: results > 0 ? `The fake OpenAI read ${results} tool result(s).` : 'Hello from the fake OpenAI.',
        finish: 'stop',
      };
    }
    case 'length':
      return { content: 'This reply was cut off at the tok', finish: 'length' };
    case 'tool_call':
    case 'partial_tool_json': {
      const tool = toolFor(body);
      if (!tool) return `The ${scenario} scenario needs a request that offers a matching tool.`;
      const args = JSON.stringify(sampleFromSchema(tool.function.parameters ?? { type: 'object' }));
      callCounter += 1;
      return {
        content: null,
        toolCall: {
          id: `call_fake_${callCounter}`,
          name: tool.function.name,
          arguments: scenario === 'tool_call' ? args : args.slice(0, Math.max(1, Math.floor(args.length / 2))),
        },
        // OpenAI finishes a call it was forced into with `stop`.
        finish: scenario === 'partial_tool_json' ? 'length' : typeof body.tool_choice === 'object' ? 'stop' : 'tool_calls',
      };
    }
  }
}

function usageFor(body: ChatCompletionBody, reply: Reply) {
  const prompt_tokens = Math.max(1, Math.ceil(JSON.stringify(body.messages).length / 4));
  const completion_tokens = Math.max(1, Math.ceil(((reply.content ?? '') + (reply.toolCall?.arguments ?? '')).length / 4));
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    // Half the prompt reads as cached, so the translator's cache mapping has
    // something to carry.
    prompt_tokens_details: { cached_tokens: Math.floor(prompt_tokens / 2) },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}

/** Pieces small enough that the translator has to reassemble them. */
function pieces(text: string, size = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function streamReply(res: Response, body: ChatCompletionBody, reply: Reply): void {
  const id = `chatcmpl-fake-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const frame = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices, ...extra })}\n\n`);
  const delta = (d: Record<string, unknown>, finish: string | null = null) =>
    frame([{ index: 0, delta: d, finish_reason: finish, logprobs: null }]);

  res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  delta({ role: 'assistant', content: '', refusal: null });
  for (const piece of pieces(reply.content ?? '')) delta({ content: piece });
  if (reply.toolCall) {
    const { id: callId, name, arguments: args } = reply.toolCall;
    delta({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }] });
    for (const piece of pieces(args)) delta({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
  }
  delta({}, reply.finish);
  if (body.stream_options?.include_usage) frame([], { usage: usageFor(body, reply) });
  res.write('data: [DONE]\n\n');
  res.end();
}

function wholeReply(res: Response, body: ChatCompletionBody, reply: Reply): void {
  res.json({
    id: `chatcmpl-fake-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: reply.content,
          refusal: null,
          ...(reply.toolCall
            ? {
                tool_calls: [
                  {
                    id: reply.toolCall.id,
                    type: 'function',
                    function: { name: reply.toolCall.name, arguments: reply.toolCall.arguments },
                  },
                ],
              }
            : {}),
        },
        finish_reason: reply.finish,
        logprobs: null,
      },
    ],
    usage: usageFor(body, reply),
  });
}

function invalid(res: Response, status: number, message: string, param: string | null = null): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error', param, code: null } });
}

export function openAiRoutes(): Router {
  const r = Router();

  r.post('/chat/completions', (req: Request, res: Response) => {
    if (!/^Bearer \S+/.test(req.get('authorization') ?? '')) {
      return invalid(res, 401, 'You didn’t provide an API key.');
    }

    const parsed = chatCompletionBody.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return invalid(res, 400, `Invalid request: ${issue.message}`, issue.path.join('.') || null);
    }
    const body = parsed.data;
    const order = toolOrderProblem(body.messages);
    if (order) return invalid(res, 400, order, 'messages');

    const header = req.get('x-fake-scenario');
    if (header !== undefined && !isScenario(header)) {
      return invalid(res, 400, `Unknown X-Fake-Scenario "${header}". Known: ${scenarios.join(', ')}.`);
    }
    const reply = replyFor(header ?? inferScenario(body), body);
    if (typeof reply === 'string') return invalid(res, 400, reply, 'tools');

    if (body.stream) streamReply(res, body, reply);
    else wholeReply(res, body, reply);
  });

  r.use(openAiCapabilityRoutes());

  return r;
}
