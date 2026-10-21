import { Router } from 'express';
import type { EntityStore } from '../store';

const SVC = 'email';

export function emailRoutes(store: EntityStore): Router {
  const r = Router();

  // Send (called by FakeOutboundEmailAdapter)
  r.post('/v1/messages', (req, res) => {
    const id = store.nextId(SVC, 'message');
    const message = {
      id,
      sent_at: new Date().toISOString(),
      recipients: req.body.recipients ?? [],
      sender: req.body.sender ?? null,
      cc: req.body.cc ?? [],
      subject: req.body.subject ?? '',
      data: req.body.data ?? '',
      replyToHeader: req.body.replyToHeader ?? null,
      inReplyToHeader: req.body.inReplyToHeader ?? null,
      hasAttachment: Boolean(req.body.attachment),
      attachmentFilename: req.body.attachment?.filename ?? null,
    };
    store.create(SVC, 'message', message, id);
    res.json({ data: message });
  });

  // Outbox: list all sent
  r.get('/outbox', (_req, res) => {
    const messages = store.list(SVC, 'message');
    res.json({ data: messages.map((m) => m.data) });
  });

  // Outbox: single
  r.get('/outbox/:id', (req, res) => {
    const m = store.get(SVC, 'message', req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    res.json({ data: m.data });
  });

  // Outbox: clear
  r.delete('/outbox', (_req, res) => {
    store.deleteService(SVC);
    res.json({ ok: true });
  });

  return r;
}
