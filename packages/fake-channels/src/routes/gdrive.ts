// Fake Google Drive (v3 REST subset) — serves the googleapis client with its
// rootUrl pointed here, so BOTH the JSON endpoints (/drive/v3/…) and the
// multipart upload endpoint (/upload/drive/v3/…) work. Entities: one 'file'
// per Drive item (folders are files with the folder mimeType), fields
// mirroring the real API: { id, name, mimeType, parents, size, webViewLink,
// content }.

import { Router } from 'express';
import express from 'express';
import type { EntityStore } from '../store';

const SVC = 'gdrive';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function fileOut(data: Record<string, unknown>): Record<string, unknown> {
  const { content: _content, ...rest } = data;
  return rest;
}

/** Parse the exact `q` patterns the api client composes. */
function matchesQuery(data: Record<string, unknown>, q: string): boolean {
  const parent = /'((?:[^'\\]|\\')*)' in parents/.exec(q)?.[1]?.replace(/\\'/g, "'");
  if (parent !== undefined) {
    const parents = (data.parents ?? []) as string[];
    if (!parents.includes(parent)) return false;
  }
  const name = /name = '((?:[^'\\]|\\')*)'/.exec(q)?.[1]?.replace(/\\'/g, "'");
  if (name !== undefined && data.name !== name) return false;
  const mimeEq = /mimeType = '([^']*)'/.exec(q)?.[1];
  if (mimeEq !== undefined && data.mimeType !== mimeEq) return false;
  const mimeNeq = /mimeType != '([^']*)'/.exec(q)?.[1];
  if (mimeNeq !== undefined && data.mimeType === mimeNeq) return false;
  if (/trashed = false/.test(q) && data.trashed === true) return false;
  return true;
}

export function gdriveRoutes(store: EntityStore): Router {
  const r = Router();

  r.get('/drive/v3/files', (req, res) => {
    const q = String(req.query.q ?? '');
    const files = store
      .list(SVC, 'file')
      .filter((f) => matchesQuery(f.data, q))
      .map((f) => fileOut(f.data));
    res.json({ files });
  });

  // Metadata-only create (folders).
  r.post('/drive/v3/files', (req, res) => {
    const id = store.nextId(SVC, 'file');
    const entity = store.create(
      SVC,
      'file',
      {
        id,
        name: req.body.name ?? 'Untitled',
        mimeType: req.body.mimeType ?? FOLDER_MIME,
        parents: req.body.parents ?? ['root'],
        webViewLink: `https://drive.google.com/drive/folders/${id}`,
        content: null,
        size: null,
      },
      id,
    );
    res.json(fileOut(entity.data));
  });

  // Multipart create (documents / uploads): part 1 = JSON metadata,
  // part 2 = the content bytes.
  const rawBody = express.raw({ type: '*/*', limit: '50mb' });
  r.post('/upload/drive/v3/files', rawBody, (req, res) => {
    const contentType = String(req.headers['content-type'] ?? '');
    const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]?.replace(/^"|"$/g, '');
    if (!boundary) return res.status(400).json({ error: 'missing multipart boundary' });
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : String(req.body ?? '');
    const parts = raw
      .split(`--${boundary}`)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && p !== '--');
    if (parts.length < 2) return res.status(400).json({ error: 'expected two multipart parts' });
    const bodyOf = (part: string) => part.slice(part.indexOf('\r\n\r\n') + 4);
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(bodyOf(parts[0]));
    } catch {
      return res.status(400).json({ error: 'part 1 is not JSON metadata' });
    }
    const content = bodyOf(parts[1]);
    const id = store.nextId(SVC, 'file');
    const entity = store.create(
      SVC,
      'file',
      {
        id,
        name: (metadata.name as string) ?? 'Untitled',
        mimeType: (metadata.mimeType as string) ?? 'application/octet-stream',
        parents: (metadata.parents as string[]) ?? ['root'],
        webViewLink: `https://drive.google.com/file/d/${id}`,
        content,
        size: Buffer.byteLength(content),
      },
      id,
    );
    res.json(fileOut(entity.data));
  });

  r.get('/drive/v3/files/:id', (req, res) => {
    const file = store.get(SVC, 'file', req.params.id);
    if (!file) return res.status(404).json({ error: 'not found' });
    if (req.query.alt === 'media') {
      res.setHeader(
        'Content-Type',
        (file.data.mimeType as string) === FOLDER_MIME
          ? 'application/octet-stream'
          : (file.data.mimeType as string) || 'application/octet-stream',
      );
      return res.send(String(file.data.content ?? ''));
    }
    res.json(fileOut(file.data));
  });

  return r;
}
