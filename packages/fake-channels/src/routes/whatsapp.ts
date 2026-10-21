import express, { Router } from 'express';
import type { EntityStore } from '../store';

const SVC = 'whatsapp';
const MEDIA = 'media';

/**
 * Default media bytes served for any media id that wasn't explicitly seeded —
 * a 1×1 PNG. Lets a bare `dev:inject whatsapp --media` (with a synthetic media
 * id) resolve bytes without a separate seed step; `dev:inject` still seeds the
 * real type/filename via `POST /whatsapp/media` so the metadata matches.
 */
const DEFAULT_MEDIA_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

interface SeededMedia {
  id: string;
  mimeType: string;
  filename: string | null;
  base64: string;
}

function readMedia(store: EntityStore, id: string): SeededMedia {
  const row = store.get(SVC, MEDIA, id);
  const data = (row?.data ?? {}) as Partial<SeededMedia>;
  return {
    id,
    mimeType: typeof data.mimeType === 'string' ? data.mimeType : 'image/jpeg',
    filename: typeof data.filename === 'string' ? data.filename : null,
    base64:
      typeof data.base64 === 'string' && data.base64.length > 0
        ? data.base64
        : DEFAULT_MEDIA_B64,
  };
}

export function whatsappRoutes(store: EntityStore): Router {
  const r = Router();

  // Send (called by FakeOutboundWhatsAppAdapter)
  r.post('/messages', (req, res) => {
    const id = store.nextId(SVC, 'message');
    const message = {
      id,
      sent_at: new Date().toISOString(),
      recipient: req.body.recipient ?? null,
      body: req.body.body ?? '',
      contentSid: req.body.contentSid ?? null,
    };
    store.create(SVC, 'message', message, id);
    res.json({ data: message });
  });

  // Outbox
  r.get('/outbox', (_req, res) => {
    const messages = store.list(SVC, 'message');
    res.json({ data: messages.map((m) => m.data) });
  });

  r.get('/outbox/:id', (req, res) => {
    const m = store.get(SVC, 'message', req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    res.json({ data: m.data });
  });

  r.delete('/outbox', (_req, res) => {
    store.deleteService(SVC);
    res.json({ ok: true });
  });

  // ── Fake Meta Cloud API: inbound media ─────────────────────────────────
  // The real adapter (services/whatsapp/metaApi.ts:downloadMedia) resolves an
  // inbound media id in two hops: GET {graph}/{mediaId} → { url, mime_type, …
  // }, then GET {url} → bytes. In the dev loop WHATSAPP_GRAPH_BASE_URL points
  // {graph} at `${FAKE_CHANNELS_URL}/whatsapp/graph`, so both hops land here.

  // Seed media that the Graph endpoints below will serve. Mirrors Meta's media
  // upload response shape (`{ id }`). `dev:inject whatsapp --media` calls this
  // so the served bytes/type/filename match the inbound message.
  r.post('/media', (req, res) => {
    const id = String(req.body?.id ?? store.nextId(SVC, MEDIA));
    const record = {
      id,
      mimeType: typeof req.body?.mimeType === 'string' ? req.body.mimeType : 'image/jpeg',
      filename: typeof req.body?.filename === 'string' ? req.body.filename : null,
      base64:
        typeof req.body?.base64 === 'string' && req.body.base64.length > 0
          ? req.body.base64
          : DEFAULT_MEDIA_B64,
    };
    store.create(SVC, MEDIA, record, id);
    res.json({ data: { id } });
  });

  // List seeded media (inspection — `dev:inspect whatsapp`). Bytes elided.
  r.get('/media', (_req, res) => {
    const media = store.list(SVC, MEDIA).map((m) => {
      const d = m.data as Partial<SeededMedia>;
      return {
        id: m.id,
        mimeType: d.mimeType ?? null,
        filename: d.filename ?? null,
        byteLength: typeof d.base64 === 'string' ? Buffer.from(d.base64, 'base64').length : 0,
      };
    });
    res.json({ data: media });
  });

  // Hop 1 — media metadata lookaside. Returns a self-referential download URL
  // so hop 2 also lands on this fake. Auto-synthesises an entry for unseeded
  // ids (default PNG) so any media id resolves.
  r.get('/graph/:mediaId', (req, res) => {
    const media = readMedia(store, req.params.mediaId);
    const fileSize = Buffer.from(media.base64, 'base64').length;
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({
      messaging_product: 'whatsapp',
      id: media.id,
      url: `${base}/whatsapp/graph/${encodeURIComponent(media.id)}/download`,
      mime_type: media.mimeType,
      sha256: '',
      file_size: fileSize,
      ...(media.filename ? { file_name: media.filename } : {}),
    });
  });

  // Fake Meta media UPLOAD — POST /{phone_number_id}/media (multipart). The
  // adapter's outbound media send uploads bytes here first; we store a stub
  // and hand back the Meta envelope ({ id }).
  const rawUpload = express.raw({ type: 'multipart/form-data', limit: '50mb' });
  r.post('/graph/:phoneNumberId/media', rawUpload, (req, res) => {
    const id = `upload_${store.nextId(SVC, MEDIA)}`;
    store.create(
      SVC,
      MEDIA,
      {
        id,
        mimeType: 'uploaded/opaque',
        filename: null,
        base64: Buffer.isBuffer(req.body) ? req.body.toString('base64').slice(0, 64) : '',
      },
      id,
    );
    res.json({ id });
  });

  // Fake Meta Cloud API send endpoint — POST /{phone_number_id}/messages.
  // The dev loop points WHATSAPP_GRAPH_BASE_URL here, so movement sends
  // (text replies, reactions) land in the SAME outbox `dev:inspect whatsapp`
  // reads. Responds with the Meta envelope (`messages[0].id`).
  r.post('/graph/:phoneNumberId/messages', (req, res) => {
    const id = store.nextId(SVC, 'message');
    store.create(
      SVC,
      'message',
      {
        via: 'graph',
        phoneNumberId: req.params.phoneNumberId,
        ...req.body,
      },
      id,
    );
    res.json({
      messaging_product: 'whatsapp',
      contacts: [{ input: req.body?.to ?? '', wa_id: req.body?.to ?? '' }],
      messages: [{ id: `wamid.fake_${id}` }],
    });
  });

  // Hop 2 — the binary content.
  r.get('/graph/:mediaId/download', (req, res) => {
    const media = readMedia(store, req.params.mediaId);
    const buf = Buffer.from(media.base64, 'base64');
    res.setHeader('content-type', media.mimeType);
    res.setHeader('content-length', String(buf.length));
    res.send(buf);
  });

  return r;
}
