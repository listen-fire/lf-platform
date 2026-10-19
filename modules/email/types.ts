// The email adapter's names and the payload an email position carries: what
// the adapter, the platform's doors and handlers, and any other host agree
// an email IS, whichever provider carried it.

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`. */
export const EMAIL_ADAPTER_TYPE = 'email';

/**
 * The provider names this same adapter also answers to.
 *
 * A movement that says `resend(…)` and one that says `email(…)` get the same
 * fields, the same edges and the same attachments — the provider is a fact
 * about the deployment, not a choice the author makes. Naming it is allowed
 * because a deployment whose mail runs through Resend should be able to say so
 * in the movement; it does not change what the movement does.
 *
 * `email` is the neutral name, and what it runs through is decided at boot
 * (`provider.ts`).
 */
export const EMAIL_ADAPTER_ALIASES = ['mailgun', 'resend'] as const;

/** Every name this adapter answers to — the neutral one and the provider ones. */
export const EMAIL_ADAPTER_NAMES: readonly string[] = [
  EMAIL_ADAPTER_TYPE,
  ...EMAIL_ADAPTER_ALIASES,
];

/** Top-level type id for an email record. */
export const EMAIL_RECORD_TYPE_ID = 'email:message';

/** Edge id on `email:message` that fans out one position per attachment. */
export const EMAIL_ATTACHMENTS_FIELD = 'attachments';

/** Type id for the per-attachment record (one position per attachment). */
export const EMAIL_ATTACHMENT_TYPE_ID = 'email:attachment';

/** Natural type name for an attachment — the pretty name positions carry.
 *  No system name in a type name (adapters/CLAUDE.md rule 5): the instance is
 *  already email, so the prefix is redundant. The internal `email:attachment`
 *  typeId is unchanged. */
export const EMAIL_ATTACHMENT_DISPLAY_NAME = 'Attachment';

// ── Position payload shape ─────────────────────────────────────────────────
// What `external-record.data` looks like for email positions. Defined
// here so adapter consumers (the trigger router, fixtures, tests) have a
// single source of truth and can construct positions structurally.

/**
 * Inbound email attachment descriptor. Mirrors what the Mailgun /
 * customEmail inbound adapters expose (`{ key, filename, size }`),
 * extended with `contentType` because the resource model needs it to
 * tag the FILE resource's MIME type. `url` is the optional stable
 * pointer to the binary content — present when the inbound adapter
 * exposes one (Mailgun's storage URL), absent otherwise.
 */
export interface EmailAttachment {
  /** Opaque adapter-internal handle — the value the inbound layer uses
   *  to fetch the attachment bytes (e.g. Mailgun's storage URL, an
   *  internal blob key, …). Surfaces as the resource id. */
  key: string;
  /** Display filename, including extension. */
  filename: string;
  /** MIME content-type, e.g. `application/pdf`. */
  contentType: string;
  /** Size in bytes when known. */
  size?: number;
  /** Stable URL when the inbound adapter exposes one. */
  url?: string;
}

/**
 * Inbound email payload. The TG-side shape — narrower and more uniform
 * than the raw webhook payloads, which carry many channel-specific
 * fields the framework doesn't care about.
 */
export interface EmailPayload {
  /** Adapter-supplied message identifier (RFC 5322 Message-Id when
   *  available; falls back to an inbound-adapter-specific id). */
  messageId: string;
  /** Subject line. */
  subject: string;
  /** RFC 5322 "From" header value. */
  sender: string;
  /** Primary recipient (the "To" the inbound adapter routed on). */
  recipient: string;
  /** HTML body. Optional — plain-only emails omit it. */
  bodyHtml?: string;
  /** Plain-text body. Optional — HTML-only emails omit it (the adapter
   *  converts on demand). */
  bodyText?: string;
  /** Attachments — zero or more. */
  attachments: EmailAttachment[];
}
