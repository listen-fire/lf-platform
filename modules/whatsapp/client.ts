// The Meta WhatsApp Cloud API, as the adapter writes through it: a reply (text,
// media, interactive), a reaction, the typing indicator. One client per
// sending number: Meta addresses a send to `/{phone_number_id}/messages`, so
// which number a reply leaves from is which client sends it.
//
// The platform's own sends as itself (verification codes, templates, its
// legacy pipeline's replies) build on this client too (apps/api
// services/whatsapp/metaApi.ts).

import type { ModuleLog } from 'module-kit';

export const META_GRAPH_BASE_URL = 'https://graph.facebook.com/v19.0';

/** The credentials one Meta WhatsApp number sends with. */
export interface WhatsappNumberCreds {
  accessToken: string;
  phoneNumberId: string;
}

/**
 * A phone number as Meta takes a recipient: no `whatsapp:` transport prefix,
 * a leading `+`, digits only after it.
 */
export function formatWhatsappRecipient(phoneNumber: string): string {
  let formatted = phoneNumber.replace(/^whatsapp:/, '');
  if (!formatted.startsWith('+')) formatted = `+${formatted}`;
  return formatted.replace(/[^\d+]/g, '');
}

function described(error: unknown): Record<string, unknown> {
  return { error: error instanceof Error ? error.message : String(error) };
}

/** Meta's media category for a MIME type; anything else is a document. */
function mediaKind(mimeType: string): 'image' | 'video' | 'audio' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

export class WhatsappCloudClient {
  private readonly messagesUrl: string;

  constructor(
    private readonly creds: WhatsappNumberCreds,
    private readonly options: { graphBaseUrl: string; fetch: typeof fetch; log: ModuleLog },
  ) {
    this.messagesUrl = `${options.graphBaseUrl}/${creds.phoneNumberId}/messages`;
  }

  /** The Meta phone number id this client sends from. */
  get numberId(): string {
    return this.creds.phoneNumberId;
  }

  private post(body: unknown): Promise<Response> {
    return this.options.fetch(this.messagesUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.creds.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Mark the message read and show the typing indicator. Meta clears it when
   *  a reply sends, or after about 25 seconds; there is no off. */
  async sendTypingOn(waMessageId: string): Promise<boolean> {
    try {
      const response = await this.post({
        messaging_product: 'whatsapp',
        message_id: waMessageId,
        status: 'read',
        typing_indicator: { type: 'text' },
      });
      if (!response.ok) {
        const errorData: unknown = await response.json().catch(() => ({}));
        this.options.log.error('Meta WhatsApp API Error:', { error: errorData });
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return true;
    } catch (error: unknown) {
      this.options.log.error('Failed to send typing on via Meta WhatsApp API:', described(error));
      return false;
    }
  }

  async sendReaction(to: string, waMessageId: string, emoji: string): Promise<boolean> {
    try {
      const response = await this.post({
        messaging_product: 'whatsapp',
        to: formatWhatsappRecipient(to),
        type: 'reaction',
        reaction: { message_id: waMessageId, emoji },
      });
      if (!response.ok) {
        const errorData: unknown = await response.json().catch(() => ({}));
        this.options.log.error('Meta WhatsApp API reaction error:', { error: errorData });
        return false;
      }
      return true;
    } catch (error: unknown) {
      this.options.log.error('Failed to send reaction via Meta WhatsApp API:', described(error));
      return false;
    }
  }

  /** A text message; the sent message's id. Throws when Meta refuses it. */
  async sendTextMessage(to: string, message: string, options: { replyToMessageId?: string } = {}): Promise<string | null> {
    try {
      const response = await this.post({
        messaging_product: 'whatsapp',
        to: formatWhatsappRecipient(to),
        type: 'text',
        text: { preview_url: true, body: message },
        // Threads the send as a reply — WhatsApp renders it quoting the
        // referenced message.
        ...(options.replyToMessageId !== undefined ? { context: { message_id: options.replyToMessageId } } : {}),
      });
      if (!response.ok) {
        const errorData: unknown = await response.json().catch(() => ({}));
        this.options.log.error('Meta WhatsApp API Error:', { status: response.status, statusText: response.statusText, error: errorData });
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const messageId = sentMessageId(await response.json());
      if (messageId === null) throw new Error('Failed to send message - invalid response');
      this.options.log.info('Message sent successfully via Meta WhatsApp API:', { messageId, to: formatWhatsappRecipient(to) });
      return messageId;
    } catch (error: unknown) {
      this.options.log.error('Failed to send message via Meta WhatsApp API:', described(error));
      throw new Error('Failed to send message');
    }
  }

  /**
   * An interactive message with a caller-supplied `interactive` object, passed
   * through VERBATIM (as Telegram's `reply_markup` is): a malformed object
   * surfaces as Meta's refusal at send time, never a save-time check.
   */
  async sendInteractive(to: string, interactive: unknown, options: { replyToMessageId?: string } = {}): Promise<string | null> {
    try {
      const response = await this.post({
        messaging_product: 'whatsapp',
        to: formatWhatsappRecipient(to),
        type: 'interactive',
        interactive,
        ...(options.replyToMessageId !== undefined ? { context: { message_id: options.replyToMessageId } } : {}),
      });
      if (!response.ok) {
        const errorData: unknown = await response.json().catch(() => ({}));
        this.options.log.error('Meta WhatsApp API interactive-send error:', { error: errorData });
        return null;
      }
      const messageId = sentMessageId(await response.json());
      if (messageId === null) this.options.log.error('Invalid response from Meta WhatsApp API');
      return messageId;
    } catch (error: unknown) {
      this.options.log.error('Failed to send interactive message via Meta WhatsApp API:', described(error));
      return null;
    }
  }

  /**
   * A media message (image / audio / video / document by MIME): the bytes are
   * uploaded, then sent by media id. The sent message's id, or null when Meta
   * refuses (outside the 24-hour service window, say).
   */
  async sendMediaMessage(
    to: string,
    media: { buffer: Uint8Array; filename: string; mimeType: string },
    options: { caption?: string; replyToMessageId?: string } = {},
  ): Promise<string | null> {
    try {
      const mediaId = await this.uploadMedia(media.buffer, media.filename, media.mimeType);
      const kind = mediaKind(media.mimeType);
      const response = await this.post({
        messaging_product: 'whatsapp',
        to: formatWhatsappRecipient(to),
        type: kind,
        [kind]: {
          id: mediaId,
          // Audio doesn't take captions; documents carry a filename.
          ...(options.caption !== undefined && kind !== 'audio' ? { caption: options.caption } : {}),
          ...(kind === 'document' ? { filename: media.filename } : {}),
        },
        ...(options.replyToMessageId !== undefined ? { context: { message_id: options.replyToMessageId } } : {}),
      });
      if (!response.ok) {
        const errorData: unknown = await response.json().catch(() => ({}));
        this.options.log.error('Meta WhatsApp API media-send error:', { error: errorData });
        return null;
      }
      return sentMessageId(await response.json());
    } catch (error: unknown) {
      this.options.log.error('Failed to send media message via Meta WhatsApp API:', described(error));
      return null;
    }
  }

  /** Upload bytes to the number's media store; Meta's id for them. */
  async uploadMedia(buffer: Uint8Array, filename: string, mimeType: string): Promise<string> {
    const uploadUrl = `${this.options.graphBaseUrl}/${this.creds.phoneNumberId}/media`;
    // A document is uploaded under its own MIME type, the rest under their
    // category.
    const kind = mediaKind(mimeType);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', kind === 'document' ? mimeType : kind);
    form.append('file', new Blob([buffer], { type: mimeType }), filename);
    this.options.log.info('Uploading media:', { filename, mimeType, uploadUrl, bufferSize: buffer.length });
    let answer: unknown;
    try {
      const response = await this.options.fetch(uploadUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.creds.accessToken}` },
        body: form,
      });
      answer = await response.json().catch(() => ({}));
      if (response.status !== 200) {
        this.options.log.error('WhatsApp API upload error response:', { status: response.status, statusText: response.statusText, data: answer });
        throw new Error(`WhatsApp API Error: ${uploadErrorMessage(answer) ?? `HTTP ${response.status}: ${response.statusText}`}`);
      }
    } catch (error: unknown) {
      this.options.log.error('WhatsApp API upload error:', described(error));
      throw new Error('Failed to upload media to WhatsApp');
    }
    const id = isRecord(answer) && typeof answer.id === 'string' && answer.id !== '' ? answer.id : null;
    if (id === null) {
      this.options.log.error('Invalid media upload response:', { data: answer });
      throw new Error('Failed to upload media to WhatsApp');
    }
    this.options.log.info('Media uploaded successfully:', { mediaId: id, filename, mimeType, bufferSize: buffer.length });
    return id;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `messages[0].id` of Meta's answer to a send. */
function sentMessageId(answer: unknown): string | null {
  if (!isRecord(answer) || !Array.isArray(answer.messages)) return null;
  const first: unknown = answer.messages[0];
  return isRecord(first) && typeof first.id === 'string' && first.id !== '' ? first.id : null;
}

function uploadErrorMessage(answer: unknown): string | undefined {
  if (!isRecord(answer)) return undefined;
  const error = answer.error;
  if (isRecord(error) && typeof error.message === 'string' && error.message !== '') return error.message;
  return typeof answer.message === 'string' && answer.message !== '' ? answer.message : undefined;
}

/** The deployment's numbers: the primary, and the movements number when one is
 *  configured. The movements number lives in the same Meta app as the
 *  primary, so it sends with the primary's token. */
export interface WhatsappNumbersConfig {
  accessToken: string;
  phoneNumberId: string;
  movementsPhoneNumberId?: string;
  graphBaseUrl: string;
  fetch: typeof fetch;
  log: ModuleLog;
}

/**
 * The send client for a Meta `phone_number_id`, so a reply goes out FROM the
 * number its message arrived on: the primary when the id is absent (an old
 * position, the Twilio path) or one no configured number has (logged; a
 * client is never made up for an unconfigured number).
 */
export function whatsappNumbers(config: WhatsappNumbersConfig): (phoneNumberId?: string) => WhatsappCloudClient {
  const options = { graphBaseUrl: config.graphBaseUrl, fetch: config.fetch, log: config.log };
  const primary = new WhatsappCloudClient({ accessToken: config.accessToken, phoneNumberId: config.phoneNumberId }, options);
  const byId = new Map<string, WhatsappCloudClient>([[primary.numberId, primary]]);
  const movementsId = config.movementsPhoneNumberId?.trim();
  const movementsToken = config.accessToken.trim();
  if (movementsId && movementsToken) {
    byId.set(movementsId, new WhatsappCloudClient({ accessToken: movementsToken, phoneNumberId: movementsId }, options));
  }
  return (phoneNumberId) => {
    if (!phoneNumberId) return primary;
    const found = byId.get(phoneNumberId);
    if (found) return found;
    config.log.warn('[whatsapp] no configured number for phone_number_id — using primary', { phoneNumberId });
    return primary;
  };
}
