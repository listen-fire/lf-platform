// WhatsApp adapter — position payload shapes. Defined here (not imported
// from the v3 `twilio.adapter.ts` inbound handler) per the R4b "mirror;
// don't import" rule: keeping the TG-side contract local lets it evolve
// independently of the pre-existing webhook adapter while staying at parity
// with the inbound payload Twilio produces.
//
// The raw Twilio webhook carries `whatsapp:+<phone>` in `From` / `To`; the
// TG-side payload below strips the `whatsapp:` prefix into a bare phone
// value (P6 — user-facing fields never carry transport jargon).

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`. */
export const WHATSAPP_ADAPTER_TYPE = 'whatsapp';

/** Top-level type id for a WhatsApp message record. */
export const WHATSAPP_RECORD_TYPE_ID = 'whatsapp:message';

// ── The event surface ───────────────────────────────────────────────────────
//
// THE FIRES EDGES LAND STRAIGHT ON THE RECORDS (rule 1, adapters/CLAUDE.md):
// the message / reaction / location entries each declare `fires` with their
// own `firesOn` kind. The retired `Message Received` / `Reaction Received` /
// `Location Received` nodes carried no facts of their own — pure indirection —
// so a listen delivers the record itself, whole, seeded stable on its wamid.

/** Edge id on `whatsapp:message` that fans out one position per attachment. */
export const WHATSAPP_ATTACHMENTS_FIELD = 'attachments';

/**
 * The NATURAL names WhatsApp's edges publish — Title Case, the one convention
 * across every adapter surface. The ids stay internal (`getRelated` dispatch);
 * THESE are what a movement writes (`msg-[:Replies]->`) and what
 * `edgeWriteName` resolves to, so `resolveWriteAnchor` keys on them.
 */
export const WHATSAPP_EDGE_NAMES = {
  attachments: 'Attachments',
  replies: 'Replies',
  reactions: 'Reactions',
  typing: 'Typing',
} as const;

/** Type id for the per-attachment record (one position per media item). */
export const WHATSAPP_ATTACHMENT_TYPE_ID = 'whatsapp:attachment';

/** Natural type name for an attachment — the pretty name positions carry.
 *  No system prefix (rule 5, adapters/CLAUDE.md): the instance already says
 *  which system you're in. */
export const WHATSAPP_ATTACHMENT_DISPLAY_NAME = 'Attachment';

/** Inbound event types beyond the message — INTERNAL type ids, colon-namespaced
 *  like their `whatsapp:message` / `whatsapp:attachment` siblings. A typeId is an
 *  IDENTITY, so all five live here, in one place: the webhook provider stamps
 *  them as `rootRecordType` and the adapter publishes them as entry points, and
 *  two declarations of one identity can drift.
 *
 *  The DISPLAYED name drops the system prefix (rule 5, adapters/CLAUDE.md: the
 *  instance already says which system) — `Reaction`, `Location`, `Typing`.
 *
 *  The Reaction type is UNIFIED — the inbound reaction record AND the reaction
 *  write (created along a message's `Reactions` edge). */
export const WHATSAPP_INBOUND_REACTION_TYPE = 'whatsapp:reaction';
export const WHATSAPP_INBOUND_LOCATION_TYPE = 'whatsapp:location';

/** The typing ACTION's target type (displayed as `Typing`) — published so the
 *  `Typing` edge lands on a described shape, but neither readable nor writable
 *  at the top level: nothing is created and nothing reads back (ephemeral edge,
 *  §4.2). */
export const WHATSAPP_TYPING_TYPE = 'whatsapp:typing';

/**
 * Inbound WhatsApp media descriptor. Mirrors what the v3 `twilio.adapter.ts`
 * exposes per `MediaUrl{i}` / `MediaContentType{i}`, extended with `name`
 * for a friendly display filename. `url` is the Twilio media URL — the
 * stable pointer the inbound layer uses to fetch the binary content.
 */
export interface WhatsappAttachment {
  /** Opaque adapter-internal handle — the Twilio media URL the inbound
   *  layer uses to fetch the attachment bytes. Surfaces as the resource
   *  id. */
  key: string;
  /** Display filename, including extension when derivable from the MIME
   *  type. */
  filename: string;
  /** MIME content-type, e.g. `image/jpeg`. */
  contentType: string;
  /** Stable URL — the Twilio media URL (same value as `key`). */
  url?: string;
}

/**
 * Inbound WhatsApp message payload. The TG-side shape — narrower and more
 * uniform than the raw Twilio webhook payload, which carries many
 * transport-specific fields the framework doesn't care about.
 */
export interface WhatsappPayload {
  /** Twilio message SID (`MessageSid`) — the stable message identifier. */
  messageId: string;
  /** Sender phone number, `whatsapp:` prefix stripped. */
  from: string;
  /** Recipient phone number (the WhatsApp business number), prefix
   *  stripped. */
  to: string;
  /** The Meta `phone_number_id` the message was received on — which of our
   *  numbers it arrived at. Selects the number a reply is sent FROM (primary vs
   *  movements). Absent on the Twilio path and old positions → primary number. */
  businessPhoneNumberId?: string;
  /** Message text body. May be empty for media-only messages. */
  body: string;
  /** WhatsApp account id (`WaId`) — the sender's WhatsApp identity. */
  waId: string;
  /** Sender's WhatsApp profile display name, when present. */
  profileName?: string;
  /** ISO-8601 receipt timestamp, when the inbound layer stamps one. */
  timestamp?: string;
  /** Media attachments — zero or more. */
  attachments: WhatsappAttachment[];
}
