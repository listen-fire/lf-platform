// Sending mail through Resend.
//
// One POST and a JSON body — no SDK, because the whole surface we use is a
// single endpoint and a bearer token, and a dependency that wraps that is a
// dependency that has to be kept current for nothing.
//
// The shape mirrors the Mailgun adapter deliberately: the same three things
// have no safe default (the key, the address we send AS, and — for Mailgun —
// the verified domain), the same reply-to falls back to the sender rather than
// to anybody's inbox, and the same archive BCC is absent unless configured.

import { OutboundEmailMessager, EmailRecipient, SendArgs } from './interface';
import { DEFAULT_API_BASE_URL } from '../resend';

const addressOf = (input: EmailRecipient): string =>
  input.username ? `${input.username} <${input.email}>` : input.email;

interface ResendSendBody {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: string }[];
}

class OutboundResendAdapter implements OutboundEmailMessager {
  private apiKey: string;
  private apiBaseUrl: string;
  private defaultSender: EmailRecipient;
  private archiveBcc: string | undefined;
  private fetch: typeof globalThis.fetch | undefined;

  constructor({
    resendApiKey,
    defaultSender,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    archiveBcc,
    fetch,
  }: {
    resendApiKey: string;
    defaultSender: EmailRecipient;
    apiBaseUrl?: string;
    /** Every outbound message is copied here when set. Absent = no BCC at all. */
    archiveBcc?: string;
    /** The host's fetch. Default: the global one, looked up per send. */
    fetch?: typeof globalThis.fetch;
  }) {
    if (!resendApiKey) {
      throw new Error('RESEND_API_KEY is not set');
    }
    if (!defaultSender?.email) {
      throw new Error(
        'OUTBOUND_EMAIL_FROM is not set — it is the address this deployment sends mail as',
      );
    }

    this.apiKey = resendApiKey;
    this.apiBaseUrl = apiBaseUrl;
    this.defaultSender = defaultSender;
    this.archiveBcc = archiveBcc;
    this.fetch = fetch;
  }

  async send({
    subject,
    data,
    recipients,
    sender = this.defaultSender,
    replyToHeader,
    inReplyToHeader,
    attachment,
    cc,
  }: SendArgs): Promise<boolean> {
    // Resend has no server-side templates, so a template send has nowhere to
    // go. Failing loudly beats posting an empty body and reporting success.
    if (typeof data !== 'string') {
      throw new Error(
        `Resend cannot send the '${data.templateName}' template — it has no template API. ` +
          'Render the message before sending it.',
      );
    }

    const body: ResendSendBody = {
      from: addressOf(sender),
      to: [recipients].flat().map((to) => to.email),
      subject,
      // Unaddressed replies go back to whoever the mail is FROM, never to a
      // hardcoded inbox that belongs to a different deployment.
      reply_to: replyToHeader ?? addressOf(sender),
      ...(cc ? { cc: [cc].flat().map((to) => to.email) } : {}),
      ...(this.archiveBcc ? { bcc: [this.archiveBcc] } : {}),
      ...(data.includes('<!DOCTYPE html') ? { html: data } : { text: data }),
      ...(inReplyToHeader ? { headers: { 'In-Reply-To': inReplyToHeader } } : {}),
      ...(attachment
        ? {
            attachments: [
              { filename: attachment.filename, content: attachment.data.toString('base64') },
            ],
          }
        : {}),
    };

    const response = await (this.fetch ?? fetch)(`${this.apiBaseUrl}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    return response.status < 400;
  }
}

export { OutboundResendAdapter };
