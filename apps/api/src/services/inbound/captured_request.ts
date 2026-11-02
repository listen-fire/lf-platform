// What a kept delivery keeps of how it came in (`automations.delivery.request`),
// so one listen can be put through it again (listen_replay.ts). Two shapes,
// the ones listen-fire's own store keeps, so either host reads the other's:
//
// - a request a door received: its method, path and query, the headers its
//   module reads (`inbound.captureHeaders`), its body as base64, the cursor it
//   was read against, and the ids of the arrivals it brought. The body and
//   query lose the fields its module names as carrying a credential
//   (`inbound.redactFields`); a header that may carry one is never kept, and
//   neither is the signature, since a replay is not verified again.
// - a poll's page: a poll made no request, so it keeps what it read, the
//   arrivals and the connection they were read for.
//
// Sensitive (a message's text, a person's address): read only by one
// explicit read of the delivery (ruling 3), forgotten with the delivery.

import { z } from 'zod';
import type { Arrival } from 'engine-contracts';
import { arrivalReceiptKey } from 'movement-engine/public/inbound';

/** A header whose name holds one of these is never kept (adapter protocol 2.6). */
const CREDENTIAL_HEADER_PARTS = ['authorization', 'cookie', 'signature', 'secret', 'token', 'key', 'auth', 'hmac', 'password'];

/** What a module declares of its kept requests (its `inbound` declaration). */
export interface RequestKeeping {
  captureHeaders?: readonly string[];
  redactFields?: readonly string[];
}

export const capturedRequestSchema = z.object({
  method: z.string(),
  path: z.string(),
  query: z.string(),
  headers: z.record(z.string(), z.string()),
  /** The body as base64, redacted. */
  body: z.string(),
  checkpoint: z.unknown().optional(),
  /** Each arrival the delivery brought, by its receipt key: all a replay judges. */
  arrivalIds: z.array(z.string()).optional(),
});
export type CapturedRequest = z.infer<typeof capturedRequestSchema>;

export const keptPageSchema = z.object({
  adapter: z.string(),
  /** The connection the poll was for; absent for an install's. */
  credential: z.string().optional(),
  arrivals: z.array(z.custom<Arrival>((v) => typeof v === 'object' && v !== null)),
});
export type KeptPage = z.infer<typeof keptPageSchema>;

export type KeptRequest = { request: CapturedRequest } | { page: KeptPage };

/** What a delivery's `request` cell holds, or null when it kept none (one
 *  kept before deliveries kept theirs). */
export function readKeptRequest(cell: unknown): KeptRequest | null {
  const request = capturedRequestSchema.safeParse(cell);
  if (request.success) return { request: request.data };
  const page = keptPageSchema.safeParse(cell);
  if (page.success) return { page: page.data };
  return null;
}

function credentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'set-cookie' || CREDENTIAL_HEADER_PARTS.some((part) => lower.includes(part));
}

function withoutMembers(value: unknown, fields: ReadonlySet<string>): { value: unknown; dropped: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { value, dropped: false };
  const kept = Object.entries(value).filter(([name]) => !fields.has(name));
  return kept.length === Object.keys(value).length ? { value, dropped: false } : { value: Object.fromEntries(kept), dropped: true };
}

/** A form's fields without the named ones, and without those members of a
 *  JSON object a field holds (Slack's `payload`). */
function redactForm(text: string, fields: ReadonlySet<string>): string {
  const form = new URLSearchParams(text);
  const out = new URLSearchParams();
  for (const [name, value] of form) {
    if (fields.has(name)) continue;
    let kept = value;
    try {
      const inner = withoutMembers(JSON.parse(value), fields);
      if (inner.dropped) kept = JSON.stringify(inner.value);
    } catch {
      // Not JSON: kept as sent.
    }
    out.append(name, kept);
  }
  return out.toString();
}

function headerValue(headers: Readonly<Record<string, string | readonly string[] | undefined>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (value === undefined) return undefined;
    return typeof value === 'string' ? value : value.join(', ');
  }
  return undefined;
}

/** The body as kept: a JSON body's own members and a form's fields named in
 *  `redactFields` dropped; anything else as the provider sent it. */
function redactBody(body: Buffer, contentType: string | undefined, fields: ReadonlySet<string>): Buffer {
  if (fields.size === 0 || body.length === 0) return body;
  const text = body.toString('utf8');
  if (contentType?.toLowerCase().includes('application/x-www-form-urlencoded') === true) {
    return Buffer.from(redactForm(text, fields), 'utf8');
  }
  try {
    const read = withoutMembers(JSON.parse(text), fields);
    return read.dropped ? Buffer.from(JSON.stringify(read.value), 'utf8') : body;
  } catch {
    return body;
  }
}

function redactQuery(query: string, fields: ReadonlySet<string>): string {
  if (fields.size === 0 || query === '') return query;
  const params = new URLSearchParams(query);
  for (const name of fields) params.delete(name);
  return params.toString();
}

/**
 * A received request as its delivery keeps it: only the headers its module
 * reads (and `content-type`), never one that may carry a credential; its body
 * and query without the fields its module redacts; the arrivals it brought.
 */
export function capturedRequest(input: {
  keeping: RequestKeeping | undefined;
  method?: string;
  path?: string;
  query?: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  rawBody: Buffer;
  checkpoint?: unknown;
  arrivals: readonly Arrival[];
}): CapturedRequest {
  const fields = new Set(input.keeping?.redactFields ?? []);
  const named = new Set(['content-type', ...(input.keeping?.captureHeaders ?? []).map((h) => h.toLowerCase())]);
  const headers: Record<string, string> = {};
  for (const name of named) {
    if (credentialHeader(name)) continue;
    const value = headerValue(input.headers, name);
    if (value !== undefined) headers[name] = value;
  }
  const body = redactBody(input.rawBody, headers['content-type'], fields);
  return {
    method: input.method ?? 'POST',
    path: input.path ?? '',
    query: redactQuery(input.query ?? '', fields),
    headers,
    body: body.toString('base64'),
    ...(input.checkpoint !== undefined ? { checkpoint: input.checkpoint } : {}),
    arrivalIds: input.arrivals.flatMap((arrival) => ('gone' in arrival ? [] : [arrivalReceiptKey(arrival)])),
  };
}

/** A poll's page as its delivery keeps it: what the poll read, for whom. */
export function keptPage(input: { adapterType: string; credentialsId: string | null; arrivals: readonly Arrival[] }): KeptPage {
  return {
    adapter: input.adapterType,
    ...(input.credentialsId !== null ? { credential: input.credentialsId } : {}),
    arrivals: [...input.arrivals],
  };
}
