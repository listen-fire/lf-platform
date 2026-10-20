// WhatsApp's inbound: Meta's `messages` webhook (an envelope,
// `entry[].changes[].value.messages[]`, per delivery) flattened into the
// payload the adapter reads (`from`/`body`/`attachments`, with Twilio-raw
// tolerance), one event per message, classified into its kind (`message`,
// `reaction`, `location`). Pure: the platform's doors and every other host
// parse a delivery here.
//
// Media: Meta delivers media by *id*, not a URL, so the parse leaves the id in
// the attachment `key`. The platform's Meta door downloads it and hands the
// adapter an exposed URL instead.

import { z } from 'zod';

import type { DiscriminableEvent } from 'movement-engine/public/adapter';

import { normalizeWhatsappPhone } from './phone';
import {
  WHATSAPP_RECORD_TYPE_ID,
  WHATSAPP_INBOUND_REACTION_TYPE,
  WHATSAPP_INBOUND_LOCATION_TYPE,
  type WhatsappAttachment,
  type WhatsappPayload,
} from './types';

// ── Meta envelope schema (tolerant — extra fields pass through) ─────────────

const metaMediaSchema = z
  .object({ id: z.string(), mime_type: z.string().optional(), filename: z.string().optional(), caption: z.string().optional() })
  .passthrough();

const metaMessageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string().optional(),
    type: z.string().optional(),
    text: z.object({ body: z.string() }).passthrough().optional(),
    image: metaMediaSchema.optional(),
    document: metaMediaSchema.optional(),
    audio: metaMediaSchema.optional(),
    video: metaMediaSchema.optional(),
    sticker: metaMediaSchema.optional(),
    reaction: z
      .object({ message_id: z.string(), emoji: z.string().optional() })
      .passthrough()
      .optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const metaContactSchema = z
  .object({ wa_id: z.string().optional(), profile: z.object({ name: z.string().optional() }).passthrough().optional() })
  .passthrough();

const metaChangeSchema = z
  .object({
    field: z.string().optional(),
    value: z
      .object({
        metadata: z.object({ display_phone_number: z.string().optional() }).passthrough().optional(),
        contacts: z.array(metaContactSchema).optional(),
        messages: z.array(metaMessageSchema).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const metaWebhookSchema = z
  .object({ object: z.string().optional(), entry: z.array(z.object({ changes: z.array(metaChangeSchema).optional() }).passthrough()).optional() })
  .passthrough();

/** The inbound-message shape the dumb path reads. Hand-written (not a zod
 *  `.passthrough()` infer) so the webhook layer's `WhatsAppMessage` — which has
 *  no index signature — assigns to it cleanly. */
export interface MetaWhatsappMessage {
  from: string;
  id: string;
  timestamp?: string;
  type?: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; filename?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  audio?: { id: string; mime_type?: string; filename?: string; caption?: string };
  video?: { id: string; mime_type?: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type?: string; filename?: string; caption?: string };
  reaction?: { message_id: string; emoji?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

/** Flatten a Meta message into the canonical `WhatsappPayload`. Attachments
 *  carry the Meta media *id* in `key` (resolved to a stored document by the
 *  inbound router before dispatch). Shared by the provider and the router. */
export function normalizeMetaMessage(
  message: MetaWhatsappMessage,
  ctx: { businessNumber?: string; businessPhoneNumberId?: string; profileName?: string } = {},
): WhatsappPayload {
  const media =
    message.image ?? message.document ?? message.audio ?? message.video ?? message.sticker;
  const attachments: WhatsappAttachment[] = media
    ? [
        {
          key: media.id,
          filename: media.filename ?? message.id,
          contentType: media.mime_type ?? 'application/octet-stream',
        },
      ]
    : [];
  return {
    messageId: message.id,
    from: normalizeWhatsappPhone(message.from) ?? message.from,
    to: ctx.businessNumber ? normalizeWhatsappPhone(ctx.businessNumber) ?? ctx.businessNumber : '',
    ...(ctx.businessPhoneNumberId ? { businessPhoneNumberId: ctx.businessPhoneNumberId } : {}),
    body: message.text?.body ?? media?.caption ?? '',
    waId: message.from,
    profileName: ctx.profileName,
    timestamp: message.timestamp,
    attachments,
  };
}

/** Inbound WhatsApp event kinds — the `listen to wa { events: [...] }`
 *  vocabulary (manifest `subscribableEvents`). A listen with no `events`
 *  subscribes to messages only, so reactions/locations never fire a movement
 *  that didn't opt in. */
export type WhatsappEventKind = 'message' | 'reaction' | 'location';

export interface ClassifiedWhatsappEvent {
  kind: WhatsappEventKind;
  /** The seeded root position's type — the RECORD the kind's fires edge
   *  delivers, whole (rule 1's collapse: the field-less event nodes are
   *  gone, so a listen seeds the message/reaction/location itself, stable
   *  on its wamid). */
  rootRecordType: string;
  payload: Record<string, unknown>;
}

/**
 * Classify one inbound Meta message into its event kind + typed payload.
 * Text/media/sticker are a `message` (sticker = one more media attachment);
 * reactions and locations are their own event types (a reaction used to
 * parse as an EMPTY message and fire movements spuriously). Anything else
 * (contacts, interactive replies, system notices) returns undefined — the
 * caller drops it with a log, never a silent empty-message firing.
 */
export function classifyMetaMessage(
  message: MetaWhatsappMessage,
  ctx: { businessNumber?: string; businessPhoneNumberId?: string; profileName?: string } = {},
): ClassifiedWhatsappEvent | undefined {
  const common = {
    messageId: message.id,
    from: normalizeWhatsappPhone(message.from) ?? message.from,
    waId: message.from,
    profileName: ctx.profileName,
    timestamp: message.timestamp,
    // The receiving number id rides every kind (message / reaction / location)
    // so a reply, reaction, or typing indicator goes out from that number.
    ...(ctx.businessPhoneNumberId ? { businessPhoneNumberId: ctx.businessPhoneNumberId } : {}),
  };
  if (message.reaction !== undefined) {
    return {
      kind: 'reaction',
      rootRecordType: WHATSAPP_INBOUND_REACTION_TYPE,
      payload: {
        ...common,
        emoji: message.reaction.emoji ?? '',
        reactedMessageId: message.reaction.message_id,
      },
    };
  }
  if (message.location !== undefined) {
    return {
      kind: 'location',
      rootRecordType: WHATSAPP_INBOUND_LOCATION_TYPE,
      payload: {
        ...common,
        latitude: message.location.latitude,
        longitude: message.location.longitude,
        name: message.location.name,
        address: message.location.address,
      },
    };
  }
  const media = message.image ?? message.document ?? message.audio ?? message.video ?? message.sticker;
  if (message.text !== undefined || media !== undefined || message.type === 'text') {
    return {
      kind: 'message',
      rootRecordType: WHATSAPP_RECORD_TYPE_ID,
      payload: { ...normalizeMetaMessage(message, ctx) },
    };
  }
  return undefined;
}

/** Whether a whatsapp trigger's listen config subscribes to this kind —
 *  `events` absent ⇒ messages only. */
export function triggerAcceptsWhatsappKind(config: unknown, kind: WhatsappEventKind): boolean {
  const events = (config as { events?: unknown } | null | undefined)?.events;
  const allowed =
    Array.isArray(events) && events.length > 0
      ? events.filter((e): e is string => typeof e === 'string')
      : ['message'];
  return allowed.includes(kind);
}

/**
 * One delivery's events, each tagged with its kind: what `preprocessInbound`
 * answers. A kind no listen takes (a contact card, a button tap, a status
 * update) is no event.
 */
export function whatsappInboundEvents(body: unknown): DiscriminableEvent[] {
  const parsed = metaWebhookSchema.safeParse(body);
  if (!parsed.success) return [];
  const events: DiscriminableEvent[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== 'messages') continue;
      const value = change.value;
      const businessNumber = value.metadata?.display_phone_number;
      const profileName = value.contacts?.[0]?.profile?.name;
      for (const message of value.messages ?? []) {
        const classified = classifyMetaMessage(message, { businessNumber, profileName });
        if (classified === undefined) continue; // unsupported kind — never an empty-message firing
        events.push({
          payload: classified.payload,
          externalId: message.id,
          // Meta resends a delivery it saw no 2xx for: the message id lets the host run it once.
          idempotencyKey: message.id,
          recordType: classified.rootRecordType,
          eventType: classified.kind,
          tag: classified.kind,
        });
      }
    }
  }
  return events;
}
