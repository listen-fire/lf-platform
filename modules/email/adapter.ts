// Email adapter — implements the translation-graph Adapter contract for
// inbound email as a source. Email is source-only in this build:
// `writeResource` throws because there is no email target system that
// accepts resource persistence. Body and attachments are reached
// explicitly — body via the `Text` field, files via the `-[:Attachments]->`
// edge — the retired input-side `#resources` bundle is gone.
//
// Position payload shape: `external-record` with `recordType === 'email'`
// and `data` matching `EmailPayload` (`types.ts`) — what the inbound
// handlers build from each provider's wire shape.
//
// The one thing it needs from outside is a stored attachment's bytes, which
// take the provider's key: its sources say how (`index.ts` builds them from
// the module context; the platform's legacy line from its environment).

import { convert as htmlToText } from 'html-to-text';

import type {
  ActorCandidate,
  ActorIdentity,
  Adapter,
  ConfigBlock,
  EdgesFromResult,
  FileRef,
  GetRelatedInput,
  RelatedResult,
  ResolveFileRefResult,
} from 'movement-engine/public/adapter';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from 'movement-engine/public/catalog';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { fileHandle, ownedFileSource } from 'movement-engine/public/adapter';
import { uniformWalk } from 'module-kit/adapter/hop';
import { META_RECORD_TYPE, makeUnstablePosition, positionData } from 'movement-engine/public/catalog';
import { BaseAdapter } from 'module-kit/adapter/base';
import { parseEmailAddress } from './inbound/mail';
import { EMAIL_MANIFEST, emailTriggerConfig } from './manifest';
import {
  EMAIL_ADAPTER_NAMES,
  EMAIL_ADAPTER_TYPE,
  EMAIL_ATTACHMENTS_FIELD,
  EMAIL_ATTACHMENT_DISPLAY_NAME,
  EMAIL_ATTACHMENT_TYPE_ID,
  EMAIL_RECORD_TYPE_ID,
  type EmailAttachment,
  type EmailPayload,
} from './types';

/** What the adapter needs from its host. */
export interface EmailSources {
  /** The bytes behind a stored attachment handle, from the provider that
   *  stored it (`fetchEmailAttachment`). */
  fetchAttachment(handle: string): Promise<ResolveFileRefResult>;
}

// ── Adapter ────────────────────────────────────────────────────────────────

/**
 * Translation-graph adapter for inbound email. Source-only.
 *
 * Capability profile:
 *   • runtime — minimal expression surface (property reads, basic
 *     comparisons, AND/OR/NOT, EXISTS).
 *     No traversal beyond the canonical `-[:Attachments]->` edge
 *     (defined in the descriptor), no aggregations beyond trivial
 *     collect/count, no LLM at the source side. The input-side
 *     `#resources` bundle is retired — body and attachments are accessed
 *     via explicit fields/edges only.
 *   • pushdown — none. Inbound emails are dispatched one at a time by
 *     the webhook router; there's no native query API to push filters
 *     into.
 */

export class EmailAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = EMAIL_ADAPTER_TYPE;
  readonly supportedTriggers = EMAIL_MANIFEST.supportedTriggers;

  // The trigger-config surface (the framing prose + inbound routing `key`) is
  // declared on the manifest so construction-free readers see it; the instance
  // just references it.
  get triggerConfig(): readonly ConfigBlock[] {
    return emailTriggerConfig();
  }

  constructor(private readonly sources: EmailSources) {
    super();
  }

  // ── 1. Schema introspection ──────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [
      // The EVENT edge lands STRAIGHT on the email: `inbox -[:Email]-> <the
      // email>`. A separate `Email Received` node carried no facts of its own
      // — pure indirection — so rule 1 (adapters/CLAUDE.md) collapses it: the
      // arrival IS the delivery of this record, whole, and a listen seeds it
      // directly. `readable: false` stays the honest statement — nobody can
      // enumerate an inbox; a fires edge is reachability, never a root read.
      // Email has no change-kind axis (a listen names a routing `key`, never
      // an event kind), so there is no `action` field and no `firesOn`.
      {
        typeId: EMAIL_RECORD_TYPE_ID,
        displayName: 'Email',
        // Email is source-only — not writable today.
        writable: false,
        readable: false,
        fires: true,
      },
      {
        typeId: EMAIL_ATTACHMENT_TYPE_ID,
        displayName: EMAIL_ATTACHMENT_DISPLAY_NAME,
        writable: false,
        // Reached only via `email-[:Attachments]->` — no root collection.
        readable: false,
      },
    ];
  }

  /**
   * The walk. Email is the smallest possible instance of it: a root whose only
   * edge is the one an arrival is pushed along, and one hop from there to the
   * attachments.
   *
   * `edgesFrom(meta)` IS `listEntryPoints`, `edgesFrom(T)` IS `describe(T)` —
   * this method is those two behind one call, plus what each edge lands on.
   * The published entry list stays as it is until the flag removal follows;
   * this is the same graph said once, in the shape the walk uses.
   *
   * NOTE the root has NO readable edge, and that is the honest answer rather
   * than a gap: nobody can enumerate an inbox. You cannot explore email cold —
   * an email has to ARRIVE, and everything else is reached relative to it.
   *
   */
  /**
   * The root — what an email connection IS, and the single edge leaving it.
   * The one thing no `describe` can answer, which is why the adapter states it
   * and `uniformWalk` derives everything else.
   */
  private static readonly ROOT: SchemaTypeDescriptor = {
    typeId: META_RECORD_TYPE,
    displayName: 'Email',
    description:
      'An email connection. Nothing here can be listed — an inbox is not ' +
      'enumerable — so the one way in is an email ARRIVING, which a listen ' +
      'delivers whole.',
    fields: [],
    references: [
      {
        fieldId: EMAIL_RECORD_TYPE_ID,
        targetTypeId: EMAIL_RECORD_TYPE_ID,
        cardinality: 'one',
        direction: 'outgoing',
        name: 'Email',
        fires: true,
        // Not readable: there is no call that lists emails. Traversing this
        // edge is something that happens TO you.
        readable: false,
        description: 'An email arriving — what a listen delivers, whole.',
      },
    ],
  };

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: 'email',
      at: position,
      root: EmailAdapter.ROOT,
      // `describe` already normalises the natural name and the internal id, so
      // the walk addresses a node however the position happens to be stamped.
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // Accept the NATURAL type name (engine / checker currency) or the internal
    // id (resolver build, legacy callers) — `resolveTypeRef` normalizes both.
    const typeId = await this.resolveTypeRef(typeRef);
    if (typeId === EMAIL_RECORD_TYPE_ID) {
      return {
        typeId: EMAIL_RECORD_TYPE_ID,
        displayName: 'Email',
        description:
          'A single inbound email message — what a listen delivers, whole: ' +
          'read `e.`Subject``, `e.`From``, `e.`Body`` straight off the event.',
        fields: [
          { fieldId: 'messageId', displayName: 'Message Id', kind: 'string', writable: false, required: true, description: 'RFC 5322 Message-Id (or an inbound-adapter id when absent).' },
          { fieldId: 'subject', displayName: 'Subject', kind: 'string', writable: false, required: false, description: 'The subject line.' },
          { fieldId: 'sender', displayName: 'From', kind: 'string', writable: false, required: false, description: 'The "From" header value.' },
          { fieldId: 'recipient', displayName: 'To', kind: 'string', writable: false, required: false, description: 'The primary recipient the message was routed on. Usually NOT helpful: for forwarded mail it shows the internal address the user forwarded it to (e.g. their Listen-Fire forwarding address), not the true recipient. Prefer `From` for who the message is about.' },
          { fieldId: 'bodyHtml', displayName: 'HTML Body', kind: 'string', writable: false, required: false, description: 'The HTML body, when present.' },
          { fieldId: 'bodyText', displayName: 'Plain Body', kind: 'string', writable: false, required: false, description: 'The plain-text body, when present.' },
          // `content` is a derived field — the canonical normalised body
          // (text fallback derived from HTML when only HTML is present, or
          // when the plain part is itself markup — see `isMarkupText`).
          // Authors use this when they want "the body" without caring
          // about which mime alternative arrived.
          { fieldId: 'content', displayName: 'Body', kind: 'string', writable: false, required: false, description: 'The normalised body — plain text, derived from HTML when only HTML arrived, or when the plain part is itself markup. Use this for "the body" regardless of format.' },
        ],
        references: [
          {
            fieldId: EMAIL_ATTACHMENTS_FIELD,
            targetTypeId: EMAIL_ATTACHMENT_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: 'Attachments',
            // Read-only: the email arrived with its attachments; nothing is
            // ever created along this edge.
            writable: false,
            // The parsed payload holds the parts in the order the message
            // carried them, and `getRelated` maps over that array without
            // reordering — so an author folding the attachments gets the
            // message's own sequence.
            sequenced: 'document',
            description: 'Files attached to the email (zero or more).',
          },
        ],
      };
    }
    if (typeId === EMAIL_ATTACHMENT_TYPE_ID) {
      return {
        typeId: EMAIL_ATTACHMENT_TYPE_ID,
        displayName: EMAIL_ATTACHMENT_DISPLAY_NAME,
        fields: [
          { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: true },
          { fieldId: 'contentType', displayName: 'Content Type', kind: 'string', writable: false, required: true },
          { fieldId: 'size', displayName: 'Size', kind: 'number', writable: false, required: false },
          { fieldId: 'url', displayName: 'URL', kind: 'string', writable: false, required: false },
          // `data` is the binary handle — the File primitive per
          // resources_currency.md. E5 (wave-2) widened SchemaFieldKind
          // to include `file` so the editor can route File-typed
          // expressions (e.g., `msg-[:Attachments]->.data`) only into
          // File-typed target fields and surface an inline error on
          // mismatch.
          { fieldId: 'data', displayName: 'File', kind: 'file', writable: false, required: false },
        ],
        references: [],
      };
    }
    return null;
  }

  // ── 2. Field-level access ────────────────────────────────────────────────
  // Override the base default so derived fields (`content`) resolve
  // alongside the cached payload. Everything else falls through to a
  // scalar lookup on `position.data`.

  async getFieldValue(input: { position: SourcePosition; fieldId: string }): Promise<unknown> {
    if (!EMAIL_ADAPTER_NAMES.includes(input.position.adapterType)) {
      throw new Error(
        `EmailAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }

    // The program names the field by its NATURAL displayName (`From`, `Body`);
    // the position's `recordType` is the NATURAL type name (the read wrapper
    // stamps it). Resolve both to this adapter's internal currency — the field
    // ids the payload is actually keyed by — on the first line (Decision #3).
    const typeId = await this.resolveTypeRef(input.position.recordType ?? EMAIL_RECORD_TYPE_ID);
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);

    // A whole inbound email (the webhook router / setup-agent preview seed it
    // with a typeless position the wrapper stamps as `Email`; attachments are
    // only reached via the `-[:Attachments]->` edge). Treat it as the message.
    if (typeId === EMAIL_RECORD_TYPE_ID) {
      const payload = (positionData(input.position) ?? {}) as Partial<EmailPayload>;
      if (fieldId === 'content') return normalisedBody(payload);
      return (payload as Record<string, unknown>)[fieldId] ?? null;
    }
    if (typeId === EMAIL_ATTACHMENT_TYPE_ID) {
      const att = (positionData(input.position) ?? {}) as Partial<EmailAttachment>;
      // `name` is a friendly alias for `filename`.
      if (fieldId === 'name') return att.filename ?? null;
      // The `File` (`data`) field is the binary primitive — a `FileRef`
      // descriptor this adapter redeems (`resolveFileRef`), the same FileRef
      // the retired input-side `_resources` bundle built. This is what
      // `msg-[:Attachments]->.\`File\`` evaluates so file bytes reach
      // extraction / carry-forward.
      if (fieldId === 'data') return emailAttachmentFileRef(att);
      return (att as Record<string, unknown>)[fieldId] ?? null;
    }
    return null;
  }

  // ── 3. Reference traversal (attachments) ─────────────────────────────────
  // The `-[:Attachments]->` domain edge yields attachment-typed positions (the
  // navigable file nodes); the body is read explicitly off the message
  // (`msg.\`Body\``). The source content that fed an extraction is reached off
  // the extracted node (`extractedNode-[:_resources]->`), not off the input.

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (!EMAIL_ADAPTER_NAMES.includes(input.position.adapterType)) {
      throw new Error(
        `EmailAdapter.getRelated received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    if (input.direction !== 'outgoing') return [];

    // The `Attachments` edge — resolve the NATURAL edge name to this adapter's
    // read currency (for email the reference `name` IS the fieldId, so it's
    // identity, but resolve it uniformly so drift on a mistyped edge is loud).
    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    if (edgeId === EMAIL_ATTACHMENTS_FIELD) {
      const payload = (positionData(input.position) ?? {}) as Partial<EmailPayload>;
      return (payload.attachments ?? []).map((att) => ({
        position: makeUnstablePosition({
          adapterType: EMAIL_ADAPTER_TYPE,
          recordType: EMAIL_ATTACHMENT_DISPLAY_NAME,
          data: att,
        }),
      }));
    }

    return [];
  }

  // ── 3a. Actor candidate parsing (acting-user split) ─────────────────────
  // Email's resolution chain — corrected 2026-05-30 — expressed as
  // an ordered candidate list that Listen-Fire's `resolveActingUser` maps to a
  // team user. This method is pure parse: NO Listen-Fire DB access.
  //
  //   • Sender (`From:` / `sender`) → an `originator` candidate.
  //     `resolveActingUser` matches it against `user_email WHERE NOT
  //     is_service_email`.
  //   • Each forwarding-header recipient (`X-Forwarded-For`,
  //     `Delivered-To`, `X-Original-To`, `X-Gm-Original-To`,
  //     `X-Google-Original-To`, `X-BeenThere`) → a `relay` candidate.
  //     `resolveActingUser` matches each against `user_email WHERE
  //     is_service_email = true`. This is what makes Gmail-forwarded
  //     dealflow streams (sender external, intermediate
  //     `dealflow@portfolio.example`) work for the user who owns the
  //     forwarding inbox.
  //
  // The terminal recipient on the deployment's own domain is ROUTING ONLY and
  // is never a
  // candidate. Anyone can email a plus-address; it's a routing key, not an
  // identity proof. The creator-override (T6) and the null-on-no-match
  // rejection both live in `resolveActingUser`, not here.
  async getActorCandidates(input: { event: TriggerEvent }): Promise<ActorCandidate[]> {
    const payload = (input.event.payload ?? {}) as Record<string, unknown>;
    const emailPayload = payload as Partial<EmailPayload>;
    const candidates: ActorCandidate[] = [];

    const sender = parseEmailAddress(emailPayload.sender ?? readHeader(payload, 'From'));
    if (sender) {
      candidates.push({
        identity: { identifier: sender, scheme: 'email', adapterType: this.adapterType, email: sender },
        source: 'originator',
      });
    }

    for (const recipient of parseIntermediateRecipients(payload)) {
      candidates.push({
        identity: { identifier: recipient, scheme: 'email', adapterType: this.adapterType, email: recipient },
        source: 'relay',
      });
    }

    return candidates;
  }

  // ── 3b. Actor extraction (T5) ────────────────────────────────────────────
  // Synchronous parse of the raw `From:` address. Independent of auth —
  // populates `@actor_email` / `@actor_name` so authors can see the raw
  // sender even when auth went through a service-account fallback.
  async extractActor(input: { event: TriggerEvent }): Promise<ActorIdentity | null> {
    const payload = (input.event.payload ?? {}) as Record<string, unknown>;
    const raw = (payload as Partial<EmailPayload>).sender ?? readHeader(payload, 'From');
    const address = parseEmailAddress(raw);
    if (!address) return null;
    const displayName = parseDisplayName(raw);
    return {
      identifier: address,
      scheme: 'email',
      adapterType: this.adapterType,
      email: address,
      name: displayName ?? undefined,
      label: displayName ?? address,
    };
  }

  // ── 3c. Byte resolution (owner-side) ─────────────────────────────────────
  // Email OWNS the FILE resources it emits (P4): the host redeems their
  // handle here. The handle is the attachment `key` the provider that stored
  // it issued (Mailgun's storage URL, Resend's id pair); one no provider
  // claims is refused by name, never fetched (`fetchEmailAttachment`).
  //
  // owners serve bytes
  async resolveFileRef(input: { ref: FileRef }): Promise<ResolveFileRefResult> {
    const handle = fileHandle(input.ref);
    if (!handle) {
      throw new Error(
        `${EMAIL_ADAPTER_TYPE}.resolveFileRef: FileRef has no source handle to resolve.`,
      );
    }
    return this.sources.fetchAttachment(handle);
  }

  // ── 4. Writes ────────────────────────────────────────────────────────────
  // Email is source-only; `createRecord` / `updateRecord` / `deleteRecord`
  // inherit BaseAdapter's `notWriteCapable` throws. Resources are never
  // written to email — as a source-only adapter it is never a TG target, so
  // `WriteInput.resources` never reaches it.
}

// ── Inbound payload normalisation ───────────────────────────────────────────

/**
 * Map a raw inbound webhook body (Mailgun's wire shape) onto the
 * `EmailPayload` contract this adapter ADVERTISES (`bodyText`,
 * `bodyHtml`, `messageId`, typed `attachments`, …) — merged over the
 * raw payload so channel-specific keys stay readable.
 *
 * This is the seam that keeps the schema honest: the editor, checker,
 * and authoring agent all offer `msg.bodyText` from the descriptor, but
 * the dispatcher used to hand the engine the raw body, where the
 * content lives at `body-plain` — so `bodyText` read null on every
 * mailgun email, extraction over it silently emitted nothing, and the
 * adapter's own `Partial<EmailPayload>` consumers (body resource,
 * attachments edge) saw none of the camelCase fields either.
 */
export function normaliseInboundEmailPayload(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;

  const attachments: EmailAttachment[] = (() => {
    const value = raw['attachments'];
    const parsed =
      typeof value === 'string'
        ? (() => {
            try {
              return JSON.parse(value);
            } catch {
              return [];
            }
          })()
        : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): EmailAttachment[] => {
      if (entry === null || typeof entry !== 'object') return [];
      const att = entry as Record<string, unknown>;
      const url = str(att['url']);
      const filename = str(att['name']) ?? str(att['filename']);
      if (!filename) return [];
      return [
        {
          key: url ?? filename,
          filename,
          contentType: str(att['content-type']) ?? str(att['contentType']) ?? 'application/octet-stream',
          ...(typeof att['size'] === 'number' ? { size: att['size'] } : {}),
          ...(url !== undefined ? { url } : {}),
        },
      ];
    });
  })();

  const normalised: Partial<EmailPayload> = {
    messageId: str(raw['Message-Id']) ?? str(raw['messageId']) ?? '',
    subject: str(raw['subject']) ?? '',
    sender: str(raw['sender']) ?? str(raw['from']) ?? '',
    recipient: str(raw['recipient']) ?? '',
    ...(str(raw['body-html']) !== undefined || str(raw['bodyHtml']) !== undefined
      ? { bodyHtml: str(raw['body-html']) ?? str(raw['bodyHtml']) }
      : {}),
    // Prefer the full plain body; fall back to Mailgun's reply-stripped
    // text, then to a payload that already carries the contract shape.
    ...(str(raw['body-plain']) ?? str(raw['stripped-text']) ?? str(raw['bodyText'])
      ? { bodyText: str(raw['body-plain']) ?? str(raw['stripped-text']) ?? str(raw['bodyText']) }
      : {}),
    attachments,
  };

  return { ...raw, ...normalised };
}

// ── Helpers ────────────────────────────────────────────────────────────────

// A closing tag or self-closing structural tag, anchored to the start of a
// (trimmed) string that opens with `<` — conservative on purpose, so prose
// with a stray angle bracket ("a <3 b", "x < y", "<name> was here") is never
// mistaken for markup.
const STRUCTURAL_TAG = /<\/[a-z]|<(?:br|div|p|html|body|table|span)\b/i;
// `<html` / `<!DOCTYPE` are unambiguous even mid-string (a MIME preamble can
// precede them), so these are checked without the leading-`<` requirement.
const DOCTYPE_OR_HTML_TAG = /<!DOCTYPE|<html\b/i;

/**
 * Whether a "plain text" body part is actually markup. Observed on a real
 * stored event: a mail-merge forwarder put the whole HTML document in the
 * message's text part (`bodyText`) — Resend still delivered a separate,
 * genuine `bodyHtml` alongside it — so plain-text preference alone let
 * markup through to the derived `Body`.
 */
function isMarkupText(text: string): boolean {
  const trimmed = text.trim();
  if (DOCTYPE_OR_HTML_TAG.test(trimmed)) return true;
  return trimmed.startsWith('<') && STRUCTURAL_TAG.test(trimmed);
}

function stripHtml(html: string): string {
  try {
    return htmlToText(html);
  } catch {
    return html;
  }
}

/**
 * Build the canonical normalised body string for an email payload.
 * Preference: plain text when present, otherwise HTML-converted-to-text —
 * except when the "plain text" part is itself markup (see `isMarkupText`),
 * in which case it's stripped exactly like the HTML-only path. Returns `''`
 * when neither is set (treated as an empty body, not null, so downstream
 * string operators don't break).
 */
function normalisedBody(payload: Partial<EmailPayload>): string {
  if (payload.bodyText && payload.bodyText.length > 0) {
    return isMarkupText(payload.bodyText) ? stripHtml(payload.bodyText) : payload.bodyText;
  }
  if (payload.bodyHtml && payload.bodyHtml.length > 0) {
    return stripHtml(payload.bodyHtml);
  }
  return '';
}

/**
 * The `File` primitive for an email attachment — a `FileRef` descriptor whose
 * handle is the attachment's stable storage key, redeemed through the owner
 * (`resolveFileRef`). Email takes no credential, so the descriptor names none.
 * Returns null when the attachment carries no storage handle.
 */
function emailAttachmentFileRef(att: Partial<EmailAttachment>): FileRef | null {
  if (!att.key || !att.filename) return null;
  const key = att.key;
  return {
    __brand: 'FileRef',
    name: att.filename,
    contentType: att.contentType,
    size: att.size,
    source: ownedFileSource({ adapterType: EMAIL_ADAPTER_TYPE, handle: key }),
  };
}

/**
 * Extract the bare email address from an RFC 5322 address field.
 * `"Ada Okafor" <ada@example.com>` → `ada@example.com`. Lowercased
 * because `user_email.email` is citext but the join's still cheaper on
 * normalised input. Returns null when no `@` is present.
 */

/**
 * Extract the friendly display name from an RFC 5322 address field.
 * `"Ada Okafor" <ada@example.com>` → `Ada Okafor`. Returns null
 * when the input is a bare address (no angle-bracket form).
 */
function parseDisplayName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const angle = trimmed.indexOf('<');
  if (angle <= 0) return null;
  const leading = trimmed.slice(0, angle).trim();
  if (!leading) return null;
  return leading.replace(/^["']|["']$/g, '').trim() || null;
}

/**
 * Read a header from the raw mailgun payload by name (case-insensitive).
 * The webhook body carries some headers as top-level keys and others
 * inside the `message-headers` stringified tuple list — we check both.
 */
function readHeader(
  payload: Record<string, unknown>,
  name: string,
): string | undefined {
  const flat = payload[name];
  if (typeof flat === 'string' && flat.length > 0) return flat;
  // `message-headers` may be a parsed array or a stringified one; tolerate both.
  const headers = payload['message-headers'];
  const parsed = parseHeaderTuples(headers);
  const target = name.toLowerCase();
  for (const [key, value] of parsed) {
    if (typeof key === 'string' && key.toLowerCase() === target && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function parseHeaderTuples(value: unknown): Array<[string, string]> {
  if (Array.isArray(value)) return value as Array<[string, string]>;
  if (typeof value === 'string' && value.length > 0) {
    try {
      const arr = JSON.parse(value);
      return Array.isArray(arr) ? (arr as Array<[string, string]>) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Parse the inbound payload's forwarding-related headers into a deduped,
 * ordered list of bare addresses. Order matters: when multiple service
 * accounts could claim the same forwarding chain we honour the closer
 * hop first (mailgun's canonical sequence). Used to build the `relay`
 * (service-account) candidates in `getActorCandidates`.
 *
 * Mirrors the header set the legacy `mailgun.adapter.ts` uses for
 * `getSenderEmails` so the auth chain and the legacy sender-identifier
 * stay in lock-step.
 */
function parseIntermediateRecipients(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined | null) => {
    if (!raw) return;
    for (const entry of raw.split(/[;, ]+/)) {
      const parsed = parseEmailAddress(entry);
      if (parsed && !seen.has(parsed)) {
        seen.add(parsed);
        out.push(parsed);
      }
    }
  };
  // Order mirrors the legacy `mailgun.adapter.ts:getSenderEmails`:
  //   X-Forwarded-For → X-BeenThere → X-Gm-Original-To →
  //   X-Google-Original-To → X-Original-To → Delivered-To.
  // The closer hop wins when multiple service accounts could claim the
  // same chain.
  push(readHeader(payload, 'X-Forwarded-For'));
  push(readHeader(payload, 'X-BeenThere'));
  push(readHeader(payload, 'X-Gm-Original-To'));
  push(readHeader(payload, 'X-Google-Original-To'));
  push(readHeader(payload, 'X-Original-To'));
  push(readHeader(payload, 'Delivered-To'));
  // The TG-side `EmailPayload` reuses `recipient` for the terminal hop;
  // including it in the intermediate-candidate list lets explicit
  // forwarding-inbox setups (no `Delivered-To` header preserved) still
  // resolve via the service-account path. The lookup still requires
  // `is_service_email = true` so the routing-only `<local>+<key>@<domain>`
  // terminal address never authenticates.
  const recipientField = (payload as Partial<EmailPayload>).recipient;
  push(recipientField);
  return out;
}
