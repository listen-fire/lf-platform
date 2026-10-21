import { Router } from 'express';
import type { EntityStore } from '../store';

const SVC = 'webhook';

export function webhookRoutes(store: EntityStore): Router {
  const r = Router();

  // Capture any POST
  r.post('/capture', (req, res) => {
    const id = store.nextId(SVC, 'capture');
    store.create(
      SVC,
      'capture',
      {
        headers: req.headers,
        body: req.body,
        method: req.method,
        captured_at: new Date().toISOString(),
      },
      id,
    );
    res.json({ ok: true, id });
  });

  // Also capture anything else posted to /webhook/*
  r.all('*', (req, res) => {
    const id = store.nextId(SVC, 'capture');
    store.create(
      SVC,
      'capture',
      {
        path: req.path,
        headers: req.headers,
        body: req.body,
        method: req.method,
        captured_at: new Date().toISOString(),
      },
      id,
    );
    res.json({ ok: true, id });
  });

  return r;
}
