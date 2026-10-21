import { Router } from 'express';
import type { EntityStore } from '../store';

// A stand-in for Resend, enough to exercise the whole inbound path locally:
// the webhook tells the API an email arrived, and the API has to come back
// here for the body, the headers and the attachment bytes.
//
// The seeding route (`POST /_seed/received`) is the only thing here that is
// not part of Resend's own surface — the injector writes the fixture through
// it before signing the webhook, which is what makes the fetch afterwards find
// anything.

const SVC = 'resend';

/** Outbound mail lands in the SAME outbox the Mailgun fake writes to, so
 *  `dev:inspect` shows one list of sent mail whichever provider sent it. */
const OUTBOX_SVC = 'email';

const ATTACHMENT_TTL_MS = 60 * 60 * 1000;

interface SeededAttachment {
  id: string;
  filename: string;
  content_type?: string;
  /** base64 bytes. */
  content?: string;
}

export function resendRoutes(store: EntityStore): Router {
  const r = Router();

  const downloadUrl = (req: { protocol: string; get(name: string): string | undefined },
    emailId: string, attachmentId: string) =>
    `${req.protocol}://${req.get('host') ?? 'localhost'}/resend/_attachments/${emailId}/${attachmentId}`;

  // Seed a received email (the injector calls this before firing the webhook).
  r.post('/_seed/received', (req, res) => {
    const id = String(req.body.id ?? store.nextId(SVC, 'received'));
    const attachments: SeededAttachment[] = Array.isArray(req.body.attachments)
      ? req.body.attachments
      : [];
    const email = {
      id,
      from: req.body.from ?? '',
      to: req.body.to ?? [],
      cc: req.body.cc ?? [],
      bcc: req.body.bcc ?? [],
      received_for: req.body.received_for ?? req.body.to ?? [],
      subject: req.body.subject ?? '',
      html: req.body.html ?? null,
      text: req.body.text ?? null,
      headers: req.body.headers ?? {},
      message_id: req.body.message_id ?? `<${id}@fake-resend.local>`,
      attachment_ids: attachments.map((a) => a.id),
    };
    store.create(SVC, 'received', email, id);
    for (const attachment of attachments) {
      store.create(
        SVC,
        'attachment',
        {
          id: attachment.id,
          email_id: id,
          filename: attachment.filename,
          content_type: attachment.content_type ?? 'application/octet-stream',
          content: attachment.content ?? '',
          size: Buffer.from(attachment.content ?? '', 'base64').length,
        },
        `${id}:${attachment.id}`,
      );
    }
    res.json({ data: email });
  });

  // The message itself — everything the webhook did not carry.
  r.get('/emails/receiving/:id', (req, res) => {
    const email = store.get(SVC, 'received', req.params.id);
    if (!email) return res.status(404).json({ error: 'Not found' });
    const attachments = store
      .search(SVC, 'attachment', (data) => data.email_id === req.params.id)
      .map((entity) => ({
        id: entity.data.id,
        filename: entity.data.filename,
        content_type: entity.data.content_type,
        size: entity.data.size,
      }));
    res.json({ ...email.data, attachments });
  });

  // The attachment listing, whose `download_url` is minted fresh on every call
  // — an hour's life, exactly as Resend's is.
  r.get('/emails/receiving/:id/attachments', (req, res) => {
    const attachments = store
      .search(SVC, 'attachment', (data) => data.email_id === req.params.id)
      .map((entity) => ({
        id: entity.data.id,
        filename: entity.data.filename,
        content_type: entity.data.content_type,
        size: entity.data.size,
        download_url: downloadUrl(req, req.params.id, String(entity.data.id)),
        expires_at: new Date(Date.now() + ATTACHMENT_TTL_MS).toISOString(),
      }));
    res.json({ data: attachments, has_more: false });
  });

  // The bytes behind a minted URL.
  r.get('/_attachments/:emailId/:attachmentId', (req, res) => {
    const entity = store.get(SVC, 'attachment', `${req.params.emailId}:${req.params.attachmentId}`);
    if (!entity) return res.status(404).json({ error: 'Not found' });
    res.setHeader('content-type', String(entity.data.content_type));
    res.send(Buffer.from(String(entity.data.content ?? ''), 'base64'));
  });

  // Sending. Lands in the shared outbox so `dev:inspect email` is one list.
  r.post('/emails', (req, res) => {
    const id = store.nextId(OUTBOX_SVC, 'message');
    const recipients: string[] = Array.isArray(req.body.to) ? req.body.to : [req.body.to];
    const message = {
      id,
      sent_at: new Date().toISOString(),
      provider: 'resend',
      recipients: recipients.filter(Boolean).map((email) => ({ email, username: '' })),
      sender: { email: req.body.from ?? '', username: '' },
      cc: (req.body.cc ?? []).map((email: string) => ({ email, username: '' })),
      subject: req.body.subject ?? '',
      data: req.body.html ?? req.body.text ?? '',
      replyToHeader: req.body.reply_to ?? null,
      inReplyToHeader: req.body.headers?.['In-Reply-To'] ?? null,
      hasAttachment: Array.isArray(req.body.attachments) && req.body.attachments.length > 0,
      attachmentFilename: req.body.attachments?.[0]?.filename ?? null,
    };
    store.create(OUTBOX_SVC, 'message', message, id);
    res.json({ id });
  });

  // Clear everything this fake is holding.
  r.delete('/_seed', (_req, res) => {
    store.deleteService(SVC);
    res.json({ ok: true });
  });

  return r;
}
