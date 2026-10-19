// WhatsApp checks its own inbound requests (`inbound.scheme: module`), at
// `/api/public/webhook-sync/whatsapp/<install>`:
//
//   GET  Meta's verification handshake when the webhook is registered:
//        `hub.mode=subscribe`, `hub.verify_token` (the install's
//        `webhookVerifyToken`) and `hub.challenge`, echoed as text.
//   POST a `messages` delivery, signed `x-hub-signature-256: sha256=<hex>`
//        with the Meta app's secret (the subscription's secret).
//
// Meta delivers media by id; where the host reads media by id
// (`mediaById`), each attachment's handle becomes `meta-media:<id>`, which
// the adapter downloads with the install's own token.

import { accepted, hmacSha256Hex, inboundRequest, refused, reply, sameText } from 'module-kit';

import type { DiscriminableEvent, InboundCheck, InboundCheckInput } from 'movement-engine/public/adapter';

import { META_MEDIA_HANDLE_PREFIX } from './adapter';
import { whatsappInboundEvents } from './inbound';

export interface WhatsappInboundSources {
  /** The token Meta's handshake must present; undefined when none is set. */
  verifyToken(): Promise<string | undefined>;
  /** Whether attachments are handed on as `meta-media:<id>` handles. */
  mediaById: boolean;
}

function withMediaHandles(event: DiscriminableEvent): DiscriminableEvent {
  const payload = event.payload as { attachments?: unknown } | null;
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.attachments)) return event;
  const attachments = payload.attachments.map((attachment: unknown) => {
    const key = (attachment as { key?: unknown } | null)?.key;
    return typeof key === 'string' && key !== '' ? { ...(attachment as object), key: `${META_MEDIA_HANDLE_PREFIX}${key}` } : attachment;
  });
  return { ...event, payload: { ...payload, attachments } };
}

/** One request at WhatsApp's inbound door. */
export async function checkWhatsappInbound(input: InboundCheckInput, sources: WhatsappInboundSources): Promise<InboundCheck> {
  const request = inboundRequest(input);
  if (request.method === 'GET') {
    const expected = await sources.verifyToken();
    const presented = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];
    if (request.query['hub.mode'] !== 'subscribe' || expected === undefined || presented === undefined || challenge === undefined) {
      return refused(403);
    }
    return sameText(expected, presented) ? reply(200, { text: challenge }) : refused(403);
  }
  if (request.method !== 'POST') return refused(405);

  if (request.secret === undefined) return refused(401);
  const presented = (request.header('x-hub-signature-256') ?? '').replace(/^sha256=/, '');
  if (presented === '' || !sameText(hmacSha256Hex(request.secret, request.bytes), presented.toLowerCase())) return refused(401);

  const events = whatsappInboundEvents(request.json());
  return accepted(sources.mediaById ? events.map(withMediaHandles) : events);
}
