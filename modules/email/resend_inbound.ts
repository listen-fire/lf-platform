// What it takes to turn a Resend delivery into the same email every other part
// of the system already understands.
//
// Resend's webhook is a notification, not a message: `email.received` carries
// ids and an envelope and nothing an author can read. Believing the delivery
// (a Svix signature over the exact bytes) is the door's (`admitResendMail`);
// this file is the second step the Mailgun path never had — going and
// FETCHING the message.
//
// Neither decides anything about routing. Whose team the mail is for and which
// trigger answers for it are the same three questions Mailgun's door asks, and
// they are asked in the same place (the host's `InboundMailRouter`), because a
// message routing differently depending on who carried it would be a bug
// nobody would find.

import type { EmailAttachment, EmailPayload } from './types';

import {
  fetchReceivedEmail,
  listReceivedAttachments,
  resendAttachmentHandle,
  type ResendApi,
  type ResendReceivedEmail,
} from './resend';

// ── The message itself ─────────────────────────────────────────────────────

/**
 * Fetch the message behind a delivery and shape it the way every email in the
 * system is shaped.
 *
 * Headers are also spread as flat top-level keys because that is where the
 * acting-user chain looks for the forwarding headers (`X-Forwarded-For`,
 * `Delivered-To`, …) — Mailgun sends them flat, Resend sends them in an
 * object, and the chain should not have to know which.
 */
async function fetchResendEmailPayload(
  api: ResendApi,
  emailId: string,
): Promise<Record<string, unknown>> {
  const email = await fetchReceivedEmail(api, emailId);
  const attachments = await resendAttachments(api, emailId, email);

  const recipient = email.received_for?.[0] ?? email.to?.[0] ?? '';
  const payload: EmailPayload = {
    messageId: email.message_id ?? emailId,
    subject: email.subject ?? '',
    sender: email.from ?? '',
    recipient,
    ...(email.html ? { bodyHtml: email.html } : {}),
    ...(email.text ? { bodyText: email.text } : {}),
    attachments,
  };
  return { ...(email.headers ?? {}), ...payload };
}

/**
 * The attachment list, with a handle that will still resolve tomorrow.
 *
 * The message's own `attachments` are used only as a fallback for their
 * metadata: the listing endpoint is the one that knows sizes, and neither
 * carries bytes.
 */
async function resendAttachments(
  api: ResendApi,
  emailId: string,
  email: ResendReceivedEmail,
): Promise<EmailAttachment[]> {
  const listed = await listReceivedAttachments(api, emailId);
  const source = listed.length > 0 ? listed : (email.attachments ?? []);
  return source.flatMap((attachment): EmailAttachment[] => {
    if (typeof attachment.id !== 'string' || typeof attachment.filename !== 'string') return [];
    return [
      {
        key: resendAttachmentHandle(emailId, attachment.id),
        filename: attachment.filename,
        contentType: attachment.content_type ?? 'application/octet-stream',
        ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
      },
    ];
  });
}

export { fetchResendEmailPayload };
