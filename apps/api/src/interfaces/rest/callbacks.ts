// The callback HTTP door — `/api/cb/<id>`. Callbacks were retired with
// listen-fire 0.13: a link an automation sent before then names nothing any
// more, so whoever follows or posts it is told so, in place
// (interaction/retired_callback.ts). Mounted before auth, as it always was:
// the link alone is what a caller holds.

import { Router, type Request, type Response } from 'express';

import { RETIRED_CALLBACK_TEXT, isRetiredCallbackId } from '../../services/interaction/retired_callback';

export const callbacksRouter: ReturnType<typeof Router> = Router();

callbacksRouter.get('/:id', (req: Request, res: Response) => {
  const { status, title, message } = answerOf(req.params.id);
  res.status(status).type('html').send(messagePage(title, message));
});

callbacksRouter.post('/:id', (req: Request, res: Response) => {
  const { status, title, message, outcome } = answerOf(req.params.id);
  if (prefersHtml(req)) res.status(status).type('html').send(messagePage(title, message));
  else res.status(status).json({ outcome, message });
});

function answerOf(id: string | undefined): { status: number; title: string; message: string; outcome: 'retired' | 'not_found' } {
  if (isRetiredCallbackId(id)) return { status: 410, title: 'This action was retired', message: RETIRED_CALLBACK_TEXT, outcome: 'retired' };
  return { status: 404, title: 'This link is not valid', message: 'Nothing here — the link may have been mistyped.', outcome: 'not_found' };
}

/** A browser form post wants a page back; a platform door or a caller's own
 *  server wants JSON. Decided by what the caller asked for. */
function prefersHtml(req: Request): boolean {
  const accept = req.headers.accept ?? '';
  if (accept.includes('application/json')) return false;
  return accept.includes('text/html');
}

// ── HTML (minimal, self-contained: no external assets) ─────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function messagePage(title: string, detail: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a;line-height:1.5}` +
    `h1{font-size:1.25rem}.muted{color:#666}</style></head>` +
    `<body><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(detail)}</p></body></html>`
  );
}
