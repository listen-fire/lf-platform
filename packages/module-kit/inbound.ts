// A module that checks its own inbound requests (`inbound: { providerKey,
// scheme: 'module' }`) writes one function, `checkInbound`, on the methods
// its `create` returns. The host hands it each request at the module's door
// as it arrived — method, path, query, headers and the exact bytes — and
// sends whatever it answers: the events (accepted), a refusal, or a reply (a
// provider's handshake). Same function in process and over the wire.
//
//   create: (ctx) => ({
//     ...adapter,
//     async checkInbound(input) {
//       const request = inboundRequest(input);
//       if (!request.secret || !sameSignature(request, request.secret)) return refused();
//       return accepted(eventsOf(request.json()));
//     },
//   })

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { WireCheckInboundInputShape } from 'engine-contracts';
import type { DiscriminableEvent, InboundCheck } from 'engine-contracts/adapter';

/** One inbound request, read. */
export interface InboundRequest {
  /** Upper case: `POST`, `GET`. */
  method: string;
  path: string;
  /** The query's pairs, decoded; a repeated key keeps its first value. */
  query: Readonly<Record<string, string>>;
  /** Lower-case names. */
  header(name: string): string | undefined;
  /** The exact bytes that arrived: what a signature is computed over. */
  bytes: Buffer;
  text(): string;
  /** The body as JSON; undefined when it is not JSON. */
  json(): unknown;
  /** The body as an `application/x-www-form-urlencoded` form. */
  form(): Readonly<Record<string, string>>;
  /** The key the subscription holds, when it holds a usable one. A module
   *  that verifies with it refuses when it is absent. */
  secret: string | undefined;
  /** What the previous accepted request returned as `checkpoint`. */
  checkpoint: unknown;
}

function pairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/** The request `checkInbound` was handed, read. */
export function inboundRequest(input: WireCheckInboundInputShape): InboundRequest {
  const { request } = input;
  const bytes = Buffer.from(request.body, 'base64');
  const headers = new Map(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    method: request.method.toUpperCase(),
    path: request.path,
    query: pairs(request.query),
    header: (name) => headers.get(name.toLowerCase()),
    bytes,
    text: () => bytes.toString('utf-8'),
    json: () => {
      try {
        return JSON.parse(bytes.toString('utf-8'));
      } catch {
        return undefined;
      }
    },
    form: () => pairs(bytes.toString('utf-8')),
    secret: input.secret !== undefined && input.secret.trim() !== '' ? input.secret : undefined,
    checkpoint: input.checkpoint,
  };
}

export function accepted(events: DiscriminableEvent[], more: { wakeKeys?: string[]; checkpoint?: unknown } = {}): InboundCheck {
  return { outcome: 'accepted', events, ...more };
}

/** Not from the provider. `status` (a 4xx) when the provider must not retry
 *  on 401 (Mailgun retries what it reads as transient). */
export function refused(status?: number): InboundCheck {
  return { outcome: 'refused', ...(status !== undefined ? { status } : {}) };
}

/** Answer exactly this, run nothing: a handshake. */
export function reply(status: number, body: { text: string } | { json: unknown } | Record<string, never> = {}): InboundCheck {
  return { outcome: 'reply', status, ...body };
}

/** Hex HMAC-SHA256 of `data`, keyed by `key`. */
export function hmacSha256Hex(key: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Two texts compared in constant time; unequal lengths are unequal. */
export function sameText(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(presented, 'utf-8');
  return a.length === b.length && timingSafeEqual(a, b);
}
