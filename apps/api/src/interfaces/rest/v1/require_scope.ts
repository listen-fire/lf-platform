import type { RequestHandler } from 'express';

/**
 * The scope gate for every `/api/v1` product router.
 *
 * `'*'` grants everything — that is the Principal contract's own wording, and
 * both providers mint it: core's for a full-access key, and the static stub by
 * DEFAULT when a self-hoster sets no `LISTEN_FIRE_SCOPES`. Six byte-identical copies
 * of this check each compared the wildcard as a literal name, so the most
 * ordinary configuration there is — a key that may do anything — was refused
 * by every product API it was issued for.
 *
 * A wildcard nobody expands is worse than no wildcard: it reads as permissive
 * in the config file and behaves as empty at the door.
 */
function requireScope(scope: string): RequestHandler {
  return function scopeGate(_req, res, next) {
    const scopes: readonly string[] | undefined = res.locals.apiKeyScopes;
    if (!scopes?.some((granted) => granted === scope || granted === '*')) {
      res.status(403).json({ error: `API key missing required scope: ${scope}` });
      return;
    }
    next();
  };
}

export { requireScope };
