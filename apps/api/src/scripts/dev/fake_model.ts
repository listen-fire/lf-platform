/**
 * The dev loop's stand-in model vendor, so a loop never calls a real model API.
 *
 *   pnpm dev:fake-model
 *
 * Serves Anthropic's Messages API (`POST /v1/messages`, plain or streamed) on
 * `FAKE_MODEL_PORT`; the loop points `ANTHROPIC_BASE_URL` here. Every other
 * vendor path the loop points here (`OPENAI_BASE_URL`) answers 404 naming this
 * fake, so a call the fake does not serve fails on this machine instead of
 * reaching the vendor.
 *
 * The answer is canned, not generated:
 *   - a request asking for an SVG (the knowledge graph's icon call) gets a
 *     plain circle, and the review of a rendered icon (a request carrying an
 *     image) gets `APPROVED`;
 *   - anything else gets `(fake model)` and the start of the last user text.
 *
 * Logs one line per call (the path and model; never headers or bodies).
 */
import http from 'node:http';

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/></svg>';

type Block = { type: string; text?: string };
type Message = { role: string; content: string | Block[] };
interface MessagesRequest {
  model?: string;
  system?: string | Block[];
  messages?: Message[];
  stream?: boolean;
}

function textOf(content: string | Block[] | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((block) => block.text ?? '').join('');
}

function carriesImage(message: Message | undefined): boolean {
  return message !== undefined && typeof message.content !== 'string' && message.content.some((block) => block.type === 'image');
}

function replyTo(request: MessagesRequest): string {
  const last = request.messages?.[request.messages.length - 1];
  if (carriesImage(last)) return 'APPROVED';
  if (/\bSVG\b/.test(textOf(request.system))) {
    return `THINKING: the dev loop's fake model draws every icon the same.\nMETAPHOR: plain circle\nSVG:\n${ICON_SVG}`;
  }
  return `(fake model) ${textOf(last?.content).slice(0, 200)}`;
}

function messageOf(request: MessagesRequest, text: string) {
  return {
    id: `msg_fake_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: request.model ?? 'fake',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function streamMessage(res: http.ServerResponse, request: MessagesRequest, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { ...messageOf(request, text), content: [], stop_reason: null } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

function log(line: string): void {
  console.log(`[fake-model] ${new Date().toISOString()} ${line}`);
}

const port = Number(process.env.FAKE_MODEL_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error('[fake-model] FAKE_MODEL_PORT names no port');
  process.exit(1);
}

http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
        log(`${req.method} ${path}: not served`);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `the dev loop's fake model serves Anthropic's POST /v1/messages only, not ${req.method} ${path}` } }));
        return;
      }
      let request: MessagesRequest;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MessagesRequest;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'the body is not JSON' } }));
        return;
      }
      const text = replyTo(request);
      log(`messages ${request.model ?? '(no model)'}${request.stream === true ? ' streamed' : ''}`);
      if (request.stream === true) {
        streamMessage(res, request, text);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(messageOf(request, text)));
    });
  })
  .listen(port, '127.0.0.1', () => log(`Fake model server running on http://127.0.0.1:${port}`));
