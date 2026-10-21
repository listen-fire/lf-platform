import { Router, raw } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

// The fake OpenAI's other capabilities: transcription, embeddings and image
// generation, enough to run the API's capability providers end to end. Each
// body is checked the way OpenAI checks it and answered with a canned reply.
//
//   POST /audio/transcriptions  multipart; the format is read from the file's
//                               extension, as OpenAI reads it.
//   POST /embeddings            deterministic unit vectors of the requested
//                               width, as floats or base64 (the SDK asks for
//                               base64 unless told otherwise).
//   POST /images/generations    a 1×1 PNG.

export const FAKE_TRANSCRIPT = 'Hello from the fake OpenAI transcription.';

/** A 1×1 transparent PNG. */
export const FAKE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function invalid(res: Response, status: number, message: string, param: string | null = null): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error', param, code: null } });
}

function authorised(req: Request, res: Response): boolean {
  if (/^Bearer \S+/.test(req.get('authorization') ?? '')) return true;
  invalid(res, 401, 'You didn’t provide an API key.');
  return false;
}

function firstIssue(error: z.ZodError): { message: string; param: string | null } {
  const issue = error.issues[0];
  return { message: `Invalid request: ${issue.message}`, param: issue.path.join('.') || null };
}

// ── transcription ────────────────────────────────────────────────────────
// https://platform.openai.com/docs/api-reference/audio/createTranscription

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** Enough of RFC 7578 for what an SDK sends: parts split on the boundary,
 *  each with a Content-Disposition naming it. */
export function parseMultipart(body: Buffer, contentType: string): MultipartPart[] | undefined {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const marker = boundary?.[1] ?? boundary?.[2];
  if (!marker) return undefined;
  const delimiter = Buffer.from(`--${marker}`);
  const parts: MultipartPart[] = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    // Each part sits between "--boundary\r\n" and "\r\n--boundary".
    const chunk = body.subarray(start + delimiter.length + 2, next - 2);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = chunk.subarray(0, headerEnd).toString('utf8');
      const disposition = /content-disposition:[^\r\n]*?[;\s]name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers);
      if (disposition) {
        parts.push({
          name: disposition[1],
          filename: disposition[2],
          contentType: type?.[1].trim(),
          data: chunk.subarray(headerEnd + 4),
        });
      }
    }
    start = next;
  }
  return parts;
}

const AUDIO_EXTENSIONS = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];

const transcriptionFields = z
  .object({
    model: z.string().min(1),
    response_format: z.enum(['json', 'text', 'srt', 'verbose_json', 'vtt']).optional(),
    language: z.string().optional(),
    prompt: z.string().optional(),
    temperature: z.coerce.number().min(0).max(1).optional(),
  })
  .strict();

function transcriptionRoute(req: Request, res: Response): void {
  if (!authorised(req, res)) return;
  const contentType = req.get('content-type') ?? '';
  const parts = Buffer.isBuffer(req.body) ? parseMultipart(req.body, contentType) : undefined;
  if (!parts) return invalid(res, 400, 'Expected a multipart/form-data body.');

  const file = parts.find((p) => p.name === 'file');
  if (!file?.filename || file.data.length === 0) return invalid(res, 400, 'Missing required parameter: file.', 'file');
  const extension = file.filename.split('.').pop()?.toLowerCase() ?? '';
  if (!AUDIO_EXTENSIONS.includes(extension)) {
    return invalid(
      res,
      400,
      `Invalid file format. Supported formats: ${JSON.stringify(AUDIO_EXTENSIONS)}`,
      'file',
    );
  }

  const fields = transcriptionFields.safeParse(
    Object.fromEntries(parts.filter((p) => p.name !== 'file').map((p) => [p.name, p.data.toString('utf8')])),
  );
  if (!fields.success) {
    const { message, param } = firstIssue(fields.error);
    return invalid(res, 400, message, param);
  }

  switch (fields.data.response_format ?? 'json') {
    case 'verbose_json':
      res.json({ task: 'transcribe', language: 'english', duration: 1.5, text: FAKE_TRANSCRIPT, segments: [] });
      return;
    case 'json':
      res.json({ text: FAKE_TRANSCRIPT });
      return;
    case 'text':
    case 'srt':
    case 'vtt':
      res.type('text/plain').send(FAKE_TRANSCRIPT);
      return;
  }
}

// ── embeddings ───────────────────────────────────────────────────────────
// https://platform.openai.com/docs/api-reference/embeddings/create

/** Native widths; `dimensions` may shorten a text-embedding-3 vector, never
 *  lengthen it, and ada-002 takes no `dimensions` at all. */
const EMBEDDING_MODELS: Record<string, { native: number; shortens: boolean }> = {
  'text-embedding-3-large': { native: 3072, shortens: true },
  'text-embedding-3-small': { native: 1536, shortens: true },
  'text-embedding-ada-002': { native: 1536, shortens: false },
};

const embeddingBody = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(2048)]),
    dimensions: z.number().int().positive().optional(),
    encoding_format: z.enum(['float', 'base64']).optional(),
    user: z.string().optional(),
  })
  .strict();

/** A unit vector that depends only on the text and the width, so a verify
 *  run can compare two calls. */
export function fakeEmbedding(text: string, width: number): number[] {
  let seed = 0;
  for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) % 1_000_003;
  const values = Array.from({ length: width }, (_, i) => Math.sin(seed + i + 1));
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map((v) => v / magnitude);
}

function embeddingsRoute(req: Request, res: Response): void {
  if (!authorised(req, res)) return;
  const parsed = embeddingBody.safeParse(req.body);
  if (!parsed.success) {
    const { message, param } = firstIssue(parsed.error);
    return invalid(res, 400, message, param);
  }
  const body = parsed.data;
  const model = EMBEDDING_MODELS[body.model];
  if (!model) {
    res.status(404).json({
      error: { message: `The model \`${body.model}\` does not exist.`, type: 'invalid_request_error', param: null, code: 'model_not_found' },
    });
    return;
  }
  if (body.dimensions !== undefined && (!model.shortens || body.dimensions > model.native)) {
    return invalid(res, 400, `This model does not support specifying dimensions of ${body.dimensions}.`, 'dimensions');
  }
  const width = body.dimensions ?? model.native;
  const inputs = typeof body.input === 'string' ? [body.input] : body.input;
  const tokens = inputs.reduce((sum, text) => sum + Math.max(1, Math.ceil(text.length / 4)), 0);
  res.json({
    object: 'list',
    data: inputs.map((text, index) => {
      const vector = fakeEmbedding(text, width);
      return {
        object: 'embedding',
        index,
        embedding: body.encoding_format === 'base64' ? Buffer.from(new Float32Array(vector).buffer).toString('base64') : vector,
      };
    }),
    model: body.model,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  });
}

// ── images ───────────────────────────────────────────────────────────────
// gpt-image-1's parameters, from
// https://developers.openai.com/api/reference/python/resources/images/methods/generate
// (checked 2026-09-24). A GPT image model always answers in base64, and the
// real endpoint refuses DALL·E's `style` and `response_format` as unknown
// parameters — in exactly these words (probed 2026-09-24):
//   {"message":"Unknown parameter: 'style'.","type":"invalid_request_error","param":"style","code":"unknown_parameter"}

const imageParams = {
  prompt: z.string().min(1).max(32000),
  model: z.literal('gpt-image-1').optional(),
  n: z.number().int().min(1).max(10).optional(),
  size: z.enum(['auto', '1024x1024', '1536x1024', '1024x1536']).optional(),
  quality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
  background: z.enum(['transparent', 'opaque', 'auto']).optional(),
  moderation: z.enum(['low', 'auto']).optional(),
  output_format: z.enum(['png', 'jpeg', 'webp']).optional(),
  output_compression: z.number().int().min(0).max(100).optional(),
  stream: z.literal(false).optional(),
  partial_images: z.number().int().min(0).max(3).optional(),
  user: z.string().optional(),
};

const imageBody = z.object(imageParams);

function imagesRoute(req: Request, res: Response): void {
  if (!authorised(req, res)) return;
  const unknown = Object.keys(req.body ?? {}).find((key) => !Object.hasOwn(imageParams, key));
  if (unknown !== undefined) {
    res.status(400).json({
      error: { message: `Unknown parameter: '${unknown}'.`, type: 'invalid_request_error', param: unknown, code: 'unknown_parameter' },
    });
    return;
  }
  const model: unknown = req.body.model;
  if (model !== undefined && model !== 'gpt-image-1') {
    // The words the real endpoint answers `dall-e-3` with since its shutdown.
    res.status(400).json({
      error: { message: `The model '${String(model)}' does not exist.`, type: 'image_generation_user_error', param: 'model', code: 'invalid_value' },
    });
    return;
  }
  const parsed = imageBody.safeParse(req.body);
  if (!parsed.success) {
    const { message, param } = firstIssue(parsed.error);
    return invalid(res, 400, message, param);
  }
  const n = parsed.data.n ?? 1;
  res.json({
    created: Math.floor(Date.now() / 1000),
    background: 'opaque',
    output_format: parsed.data.output_format ?? 'png',
    quality: 'low',
    size: '1024x1024',
    data: Array.from({ length: n }, () => ({ b64_json: FAKE_PNG_BASE64 })),
    usage: {
      input_tokens: 12,
      input_tokens_details: { text_tokens: 12, image_tokens: 0 },
      output_tokens: 272,
      total_tokens: 284,
    },
  });
}

export function openAiCapabilityRoutes(): Router {
  const r = Router();
  r.post('/audio/transcriptions', raw({ type: 'multipart/form-data', limit: '50mb' }), transcriptionRoute);
  r.post('/embeddings', embeddingsRoute);
  r.post('/images/generations', imagesRoute);
  return r;
}
