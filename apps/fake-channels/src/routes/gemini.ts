import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

// A stand-in for Gemini on Vertex, enough to prove the API's Gemini translator
// end to end: the real `@google/genai` client, pointed here by
// `GEMINI_BASE_URL=<this host>/gemini`, sends its real wire request, and this
// route refuses any body the documented `generateContent` schema would refuse.
//
// Paths are the ones the SDK builds under a base URL with a project and
// location set: `/v1/projects/:p/locations/:l/publishers/google/models/:m`
// followed by `:generateContent` or `:streamGenerateContent` (`?alt=sse`).
//
// The Gemini Developer API (a client built with `GEMINI_API_KEY`) is served
// from the same handlers: `/v1beta/models/:m:generateContent` and
// `:streamGenerateContent`, and `:batchEmbedContents` for embeddings. The key
// arrives as a header or query parameter, which this fake does not check.
//
// The reply is canned, chosen by the `X-Fake-Scenario` header, else by a
// wire model named `fake-<scenario>`. The model name is there because the
// API's provider sends no per-call headers: a verify run can pick a scenario
// per registry name through the map, e.g.
// `{"claude-opus-5": "gemini/fake-function_call"}`.
//
// With neither, the fake behaves like a model would, as the fake OpenAI does:
// it calls a function when one is forced (mode ANY), or when functions are
// offered and the last turn is the user's, and otherwise answers in text.
// Call arguments are built from the function's JSON schema, so a structured
// call made through a forced tool validates. Once the last turn is a function
// response, every scenario answers with plain text, so a tool loop driven
// through here ends. That default is what lets the unmodified wrapper run its
// plain, structured and tool loop calls against this fake.
//
// A request that asks for an IMAGE response modality gets the `image`
// scenario: a line of text and a 1×1 PNG as an inline part. `:predict` answers
// embeddings for `gemini-embedding-001` (see below).
//
// `thought_signature` is the one scenario that checks the CONVERSATION as
// well as the shape: a follow-up turn must carry back, on the first function
// call of each model turn, the signature this fake issued — which is the rule
// real Gemini enforces with a 400.

const SCENARIOS = ['text', 'function_call', 'text_and_function_call', 'max_tokens', 'thought_signature', 'image'] as const;
type Scenario = (typeof SCENARIOS)[number];

export const FAKE_THOUGHT_SIGNATURE = 'ZmFrZS10aG91Z2h0LXNpZ25hdHVyZQ==';

/** A 1×1 transparent PNG, the `image` scenario's picture. */
export const FAKE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// The documented request schema, strict where the translator writes: a field
// it should not have sent is a failure here, not a silently ignored extra.
const Part = z
  .object({
    text: z.string().optional(),
    inlineData: z.object({ mimeType: z.string().min(1), data: z.string().min(1) }).strict().optional(),
    functionCall: z
      .object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()).optional(), id: z.string().optional() })
      .strict()
      .optional(),
    functionResponse: z
      .object({ name: z.string().min(1), response: z.record(z.string(), z.unknown()), id: z.string().optional() })
      .strict()
      .optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
  })
  .strict()
  .refine(
    (p) => [p.text, p.inlineData, p.functionCall, p.functionResponse].filter((v) => v !== undefined).length === 1,
    { message: 'a part carries exactly one of text, inlineData, functionCall, functionResponse' },
  );

const Content = z.object({ role: z.enum(['user', 'model']).optional(), parts: z.array(Part).min(1) }).strict();

const GenerateContentRequest = z
  .object({
    contents: z.array(Content).min(1),
    systemInstruction: z.object({ role: z.string().optional(), parts: z.array(Part).min(1) }).strict().optional(),
    tools: z
      .array(
        z
          .object({
            functionDeclarations: z.array(
              z
                .object({
                  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/),
                  description: z.string().optional(),
                  parametersJsonSchema: z.unknown().optional(),
                  parameters: z.unknown().optional(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional(),
    toolConfig: z
      .object({
        functionCallingConfig: z
          .object({
            mode: z.enum(['AUTO', 'ANY', 'NONE', 'VALIDATED']),
            allowedFunctionNames: z.array(z.string()).optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
    generationConfig: z
      .object({
        maxOutputTokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
        stopSequences: z.array(z.string()).max(5).optional(),
        thinkingConfig: z
          .object({
            thinkingBudget: z.number().int().optional(),
            thinkingLevel: z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']).optional(),
            includeThoughts: z.boolean().optional(),
          })
          .strict()
          .refine((c) => c.thinkingBudget === undefined || c.thinkingLevel === undefined, {
            message: 'thinkingBudget and thinkingLevel cannot both be set',
          })
          .optional(),
        responseModalities: z.array(z.enum(['TEXT', 'IMAGE', 'AUDIO'])).min(1).optional(),
        imageConfig: z
          .object({
            aspectRatio: z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']).optional(),
            imageSize: z.enum(['1K', '2K', '4K']).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type GenerateContentRequest = z.infer<typeof GenerateContentRequest>;
type WirePart = z.infer<typeof Part>;

interface Reply {
  chunks: WirePart[][];
  finishReason: 'STOP' | 'MAX_TOKENS';
}

const USAGE = {
  promptTokenCount: 12,
  candidatesTokenCount: 8,
  thoughtsTokenCount: 4,
  cachedContentTokenCount: 2,
  totalTokenCount: 24,
};

function googleError(res: Response, status: number, message: string): void {
  const statusName = status === 400 ? 'INVALID_ARGUMENT' : status === 404 ? 'NOT_FOUND' : 'INTERNAL';
  res.status(status).json({ error: { code: status, message, status: statusName } });
}

function scenarioOf(req: Request, model: string, body: GenerateContentRequest): Scenario | undefined {
  const raw = req.get('x-fake-scenario') ?? (model.startsWith('fake-') ? model.slice('fake-'.length) : undefined);
  return raw === undefined ? inferScenario(body) : SCENARIOS.find((s) => s === raw);
}

function inferScenario(body: GenerateContentRequest): Scenario {
  if (body.generationConfig?.responseModalities?.includes('IMAGE')) return 'image';
  const offered = (body.tools ?? []).some((t) => t.functionDeclarations.length > 0);
  const mode = body.toolConfig?.functionCallingConfig.mode;
  if (!offered || mode === 'NONE') return 'text';
  if (mode === 'ANY') return 'function_call';
  const last = body.contents[body.contents.length - 1];
  return (last.role ?? 'user') === 'user' ? 'function_call' : 'text';
}

type Declaration = NonNullable<GenerateContentRequest['tools']>[number]['functionDeclarations'][number];

/** The function a call names: the one allowed name when a call is forced to
 *  it, else the first declared. */
function functionFor(body: GenerateContentRequest): Declaration | undefined {
  const declarations = (body.tools ?? []).flatMap((t) => t.functionDeclarations);
  const allowed = body.toolConfig?.functionCallingConfig.allowedFunctionNames ?? [];
  return declarations.find((d) => allowed.length === 0 || allowed.includes(d.name));
}

/** A value that satisfies `schema`, as far as a fake needs: every required
 *  property present, with the first enum value or a plain value of its type.
 *  (The same sampler as the fake OpenAI's, kept local so each fake stands
 *  alone.) */
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

/** The call a function scenario makes: to the chosen function, with
 *  arguments its schema accepts. */
function callFor(body: GenerateContentRequest): { name: string; args: Record<string, unknown> } {
  const declaration = functionFor(body);
  if (!declaration) return { name: 'lookup', args: {} };
  const args = z
    .record(z.string(), z.unknown())
    .safeParse(sampleFromSchema(declaration.parametersJsonSchema ?? declaration.parameters ?? { type: 'object' }));
  return { name: declaration.name, args: args.success ? args.data : {} };
}

/** Why a follow-up turn would be refused by real Gemini for a missing
 *  signature, or undefined when every model turn that called a function sent
 *  this fake's signature back on its first call. */
function missingSignature(body: GenerateContentRequest): string | undefined {
  for (const [index, content] of body.contents.entries()) {
    if (content.role !== 'model') continue;
    const firstCall = content.parts.find((p) => p.functionCall);
    if (firstCall && firstCall.thoughtSignature !== FAKE_THOUGHT_SIGNATURE) {
      return `Function call is missing a thought_signature in functionCall parts (contents[${index}]).`;
    }
  }
  return undefined;
}

function replyFor(scenario: Scenario, body: GenerateContentRequest): Reply {
  const last = body.contents[body.contents.length - 1];
  if (last.parts.some((p) => p.functionResponse)) {
    return { chunks: [[{ text: 'Done: ' }], [{ text: 'the tool answered.' }]], finishReason: 'STOP' };
  }
  const call = callFor(body);
  switch (scenario) {
    case 'text':
      return { chunks: [[{ text: 'Hello from ' }], [{ text: 'the fake Gemini.' }]], finishReason: 'STOP' };
    case 'function_call':
      return { chunks: [[{ functionCall: call }]], finishReason: 'STOP' };
    case 'text_and_function_call':
      return { chunks: [[{ text: 'Let me check.' }, { functionCall: call }]], finishReason: 'STOP' };
    case 'max_tokens':
      return { chunks: [[{ text: 'This answer is cut o' }]], finishReason: 'MAX_TOKENS' };
    case 'image':
      return {
        chunks: [[{ text: 'Here is the image.' }, { inlineData: { mimeType: 'image/png', data: FAKE_PNG_BASE64 } }]],
        finishReason: 'STOP',
      };
    case 'thought_signature':
      return {
        chunks: [
          [{ text: 'Deciding which tool to call.', thought: true }],
          [{ functionCall: call, thoughtSignature: FAKE_THOUGHT_SIGNATURE }],
        ],
        finishReason: 'STOP',
      };
  }
}

function responseChunk(parts: WirePart[], final: { finishReason: Reply['finishReason'] } | undefined, model: string) {
  return {
    candidates: [{ content: { role: 'model', parts }, index: 0, ...(final ? { finishReason: final.finishReason } : {}) }],
    modelVersion: model,
    responseId: 'fake-gemini-response',
    ...(final ? { usageMetadata: USAGE } : {}),
  };
}

// Groups: 1 version, 2 project (Vertex only), 3 location (Vertex only), 4 model, 5 method.
const MODEL_PATH =
  /^\/(v1|v1beta1|v1beta)\/(?:projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/)?models\/([^/:]+):(generateContent|streamGenerateContent)$/;

// Embeddings. `@google/genai` sends `gemini-embedding-001` on Vertex to the
// model's `:predict` method with one instance per text; the model page allows
// one text per request and widths 128 to 3072.
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings
const PREDICT_PATH =
  /^\/(v1|v1beta1)\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^/:]+):predict$/;

// The Developer API's embedding method: a batch of requests, one text each.
const BATCH_EMBED_PATH = /^\/(v1|v1beta)\/models\/([^/:]+):batchEmbedContents$/;

const BatchEmbedRequest = z
  .object({
    requests: z
      .array(
        z
          .object({
            model: z.string().optional(),
            content: z.object({ parts: z.array(z.object({ text: z.string().min(1) }).strict()).min(1), role: z.string().optional() }).strict(),
            taskType: z.string().optional(),
            title: z.string().optional(),
            outputDimensionality: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const EMBEDDING_MODELS: Record<string, { min: number; max: number; textsPerRequest: number }> = {
  'gemini-embedding-001': { min: 128, max: 3072, textsPerRequest: 1 },
};

const PredictRequest = z
  .object({
    instances: z
      .array(
        z
          .object({
            content: z.string().min(1),
            task_type: z.string().optional(),
            title: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    parameters: z
      .object({ outputDimensionality: z.number().int().positive().optional(), autoTruncate: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();

/** A unit vector that depends only on the text and the width. */
function fakeEmbedding(text: string, width: number): number[] {
  let seed = 0;
  for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) % 1_000_003;
  const values = Array.from({ length: width }, (_, i) => Math.cos(seed + i + 1));
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map((v) => v / magnitude);
}

export function geminiRoutes(): Router {
  const r = Router();

  r.post(MODEL_PATH, (req, res) => {
    const match = MODEL_PATH.exec(req.path);
    if (!match) return googleError(res, 404, 'unknown path');
    const model = match[4];
    const method = match[5];

    const parsed = GenerateContentRequest.safeParse(req.body);
    if (!parsed.success) {
      return googleError(res, 400, `Invalid generateContent request: ${parsed.error.message}`);
    }
    const scenario = scenarioOf(req, model, parsed.data);
    if (!scenario) {
      return googleError(res, 400, `Unknown fake scenario; expected one of ${SCENARIOS.join(', ')}.`);
    }
    if (scenario === 'thought_signature') {
      const missing = missingSignature(parsed.data);
      if (missing) return googleError(res, 400, missing);
    }

    const reply = replyFor(scenario, parsed.data);
    const bodies = reply.chunks.map((parts, i) =>
      responseChunk(parts, i === reply.chunks.length - 1 ? { finishReason: reply.finishReason } : undefined, model),
    );

    if (method === 'generateContent') {
      return res.json(responseChunk(reply.chunks.flat(), { finishReason: reply.finishReason }, model));
    }
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const body of bodies) res.write(`data: ${JSON.stringify(body)}\n\n`);
    res.end();
  });

  r.post(PREDICT_PATH, (req, res) => {
    const match = PREDICT_PATH.exec(req.path);
    if (!match) return googleError(res, 404, 'unknown path');
    const model = EMBEDDING_MODELS[match[4]];
    if (!model) return googleError(res, 404, `Publisher model ${match[4]} is not an embedding model this fake serves.`);

    const parsed = PredictRequest.safeParse(req.body);
    if (!parsed.success) return googleError(res, 400, `Invalid predict request: ${parsed.error.message}`);
    const { instances, parameters } = parsed.data;
    if (instances.length > model.textsPerRequest) {
      return googleError(res, 400, `${match[4]} takes ${model.textsPerRequest} instance per request, got ${instances.length}.`);
    }
    const width = parameters?.outputDimensionality ?? model.max;
    if (width < model.min || width > model.max) {
      return googleError(res, 400, `outputDimensionality must be between ${model.min} and ${model.max}, got ${width}.`);
    }

    res.json({
      predictions: instances.map(({ content }) => ({
        embeddings: {
          // Like the real model, a shortened vector comes back NOT renormalised:
          // the unit vector's prefix, which is the caller's to normalise.
          values: fakeEmbedding(content, model.max).slice(0, width),
          statistics: { truncated: false, token_count: Math.max(1, Math.ceil(content.length / 4)) },
        },
      })),
      metadata: { billableCharacterCount: instances.reduce((sum, i) => sum + i.content.length, 0) },
    });
  });

  r.post(BATCH_EMBED_PATH, (req, res) => {
    const match = BATCH_EMBED_PATH.exec(req.path);
    if (!match) return googleError(res, 404, 'unknown path');
    const model = EMBEDDING_MODELS[match[2]];
    if (!model) return googleError(res, 404, `models/${match[2]} is not an embedding model this fake serves.`);

    const parsed = BatchEmbedRequest.safeParse(req.body);
    if (!parsed.success) return googleError(res, 400, `Invalid batchEmbedContents request: ${parsed.error.message}`);
    const { requests } = parsed.data;
    if (requests.length > model.textsPerRequest) {
      return googleError(res, 400, `${match[2]} takes ${model.textsPerRequest} request per batch, got ${requests.length}.`);
    }
    const embeddings = [];
    for (const { content, outputDimensionality } of requests) {
      const width = outputDimensionality ?? model.max;
      if (width < model.min || width > model.max) {
        return googleError(res, 400, `outputDimensionality must be between ${model.min} and ${model.max}, got ${width}.`);
      }
      const text = content.parts.map((p) => p.text).join('');
      embeddings.push({ values: fakeEmbedding(text, model.max).slice(0, width) });
    }
    res.json({ embeddings });
  });

  return r;
}
