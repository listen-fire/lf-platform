// lf's secrets slot, served by the platform over a team's encrypted
// credentials (services/lf_secrets/module.ts), and the OAuth redirect relay
// that hands a provider's sign-in redirect to the team's `listen-fire serve`.
//
//   POST /api/public/lf-secrets                         adapter protocol 2's envelope
//   GET  /api/public/lf-secrets/oauth/callback/:team    the redirect relay
//
// The door brings its own auth: an api key carrying the `secrets` scope (or
// `*`), acting in the team its `team` setting names, which a pinned key cannot
// escape. It answers as `serveSlot` (module-runtime's module_wire/wire.ts)
// does: 401 without a key, 400 for a body that is not the envelope, 200 with
// `{ ok, result }` or `{ ok: false, error }` otherwise. An error that is not a
// refusal is answered with a fixed message and logged as its method, ref and
// code only, so no secret reaches an answer or a log.
//
// The relay carries the sign-in's code and state in its query, so it is
// mounted before the request logger and logs nothing of it.

import express, { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { TeamScopeError, type Principal } from 'principal';
import { SECRETS_METHODS, SlotRequestEnvelope, type WireSlotManifestShape } from 'engine-contracts/slots';
import { PROTOCOL_VERSION } from 'engine-contracts/protocol';
import { SlotRefusal } from 'movement-engine/public/module-wire';
import { logger } from 'movement-engine/public/log';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';
import { MB } from '../../constants';
import { contextInjector } from '../../lib/middleware/context';
import { ApiKeyService } from '../../services/api_key';
import { authenticateRequest, completeDoorAuthentication, principalProvider } from '../../services/principal';
import { principalMode } from '../../services/principal/mode';
import { platformSecretsModule, type SecretsMethod } from '../../services/lf_secrets/module';

const SECRETS_SCOPE = 'secrets';

// Answered before the key's team is read: lf asks for it before any other
// method. The secrets slot's methods are all from adapter protocol 2.0.
const MANIFEST: WireSlotManifestShape = {
  protocolVersion: 2,
  protocolMinor: 0,
  name: 'lf_platform_secrets',
  kind: 'core',
  slot: 'secrets',
  methods: [...SECRETS_METHODS],
};

// guid, not uuid: the dev loop's pinned team and user ids are not RFC 4122 variants.
const userIdSchema = z.custom<UserId>((value) => z.guid().safeParse(value).success);
const teamIdOf = z.custom<TeamId>((value) => z.guid().safeParse(value).success);

function isSecretsMethod(method: string): method is SecretsMethod {
  return (SECRETS_METHODS as readonly string[]).includes(method);
}

/** Who is calling. Core's funnel reads any `/public/` URL as the public
 *  identity, so in core mode this door resolves the bearer key itself and
 *  joins core's tail, as the other self-authorising doors do. */
async function authenticateCaller(req: Request): Promise<Principal | null> {
  if (principalMode() === 'static') {
    const outcome = await authenticateRequest(req);
    return outcome.ok ? outcome.principal : null;
  }
  const header = req.get('authorization');
  const key = header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length) : undefined;
  if (key === undefined) return null;
  const validated = await ApiKeyService.validateKey(key);
  if (!validated.valid) return null;
  const outcome = await completeDoorAuthentication(
    { userId: validated.apiKey.userId, apiKey: { id: validated.apiKey.id, teamId: validated.apiKey.teamId, scopes: validated.apiKey.scopes } },
    req,
  );
  return outcome.ok ? outcome.principal : null;
}

const authenticate: RequestHandler = (req, res, next) => {
  authenticateCaller(req)
    .then((principal) => {
      if (principal === null) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      if (!principal.scopes.some((scope) => scope === SECRETS_SCOPE || scope === '*')) {
        res.status(403).json({ error: `the key does not carry the ${SECRETS_SCOPE} scope` });
        return;
      }
      res.locals.principal = principal;
      next();
    })
    .catch(() => {
      logger.error('[lf-secrets] authentication failed');
      res.status(401).json({ error: 'unauthorized' });
    });
};

/** A body the JSON parser refused: not JSON, or over the limit. */
const bodyRefused: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err === 'object' && err !== null && Reflect.get(err, 'type') === 'entity.too.large' ? 413 : 400;
  res.status(status).json({ error: 'bad_request' });
};

function refusalEnvelope(code: string, message: string, data?: unknown) {
  return { ok: false, error: { code, message, retryable: false, ...(data !== undefined ? { data } : {}) } };
}

/** The team the call acts in: its `team` setting, if this principal may act there. */
async function teamOf(principal: Principal, settings: Record<string, unknown>) {
  const requested = settings.team;
  if (typeof requested !== 'string' || requested === '') throw new SlotRefusal('settings', 'the `team` setting is missing');
  try {
    const team = await principalProvider().resolveTeam(principal, requested);
    return teamIdOf.parse(team.teamId);
  } catch (error) {
    if (error instanceof TeamScopeError) throw new SlotRefusal('settings', 'the `team` setting names a team this key cannot act in');
    throw error;
  }
}

async function answerEnvelope(req: Request, res: Response): Promise<void> {
  const body: unknown = req.body;
  const envelope = SlotRequestEnvelope.safeParse(body);
  if (!envelope.success) {
    const version = body !== null && typeof body === 'object' ? Reflect.get(body, 'protocolVersion') : undefined;
    if (version !== undefined && version !== PROTOCOL_VERSION) {
      res.status(200).json({ ok: false, error: { code: 'protocol_version', message: `this module speaks protocol ${PROTOCOL_VERSION}`, retryable: false } });
      return;
    }
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const { method, params, settings } = envelope.data;
  if (method === 'manifest') {
    res.status(200).json({ ok: true, result: MANIFEST });
    return;
  }
  if (!isSecretsMethod(method)) {
    res.status(200).json(refusalEnvelope('method_not_implemented', `no method "${method}"`));
    return;
  }
  const principal: Principal = res.locals.principal;
  const ref = typeof params.ref === 'string' ? params.ref : undefined;
  try {
    const teamId = await teamOf(principal, settings ?? {});
    const userId = principal.userId === undefined ? null : userIdSchema.parse(principal.userId);
    const result = await platformSecretsModule({ teamId, userId })[method](params);
    res.status(200).json({ ok: true, result: result ?? null });
  } catch (error) {
    if (error instanceof SlotRefusal) {
      res.status(200).json(refusalEnvelope(error.code, error.message, error.data));
      return;
    }
    const code = typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string' ? Reflect.get(error, 'code') : error instanceof Error ? error.name : 'unknown';
    logger.error('[lf-secrets] a method failed', { method, ref, code });
    const verb = method.slice('secrets.'.length);
    res.status(200).json({
      ok: false,
      error: { code: 'module_error', message: ref === undefined ? `the platform could not ${verb}` : `the platform could not ${verb} "${ref}"`, retryable: true },
    });
  }
}

/** The secrets slot's door, mounted at `/api/public/lf-secrets` before the
 *  app's JSON parser: it parses its own body. */
export function createLfSecretsRouter(): Router {
  const router = Router();
  router.post('/', contextInjector, authenticate, express.json({ limit: MB }), (req, res) => {
    answerEnvelope(req, res).catch(() => {
      logger.error('[lf-secrets] the envelope could not be answered');
      if (!res.headersSent) res.status(500).json({ error: 'internal' });
    });
  });
  router.use(bodyRefused);
  return router;
}

// ── The OAuth redirect relay ────────────────────────────────────────────────

const RELAY_TARGETS_VARIABLE = 'LF_OAUTH_RELAY_TARGETS';
const RELAY_TIMEOUT_MS = 10_000;

type Env = Record<string, string | undefined>;

/** Each team's `listen-fire serve` URL, from `LF_OAUTH_RELAY_TARGETS`
 *  (`{ "<team id>": "https://lf.example.com" }`). Throws naming the variable. */
function relayTargets(env: Env = process.env): Readonly<Record<string, string>> {
  const raw = env[RELAY_TARGETS_VARIABLE];
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${RELAY_TARGETS_VARIABLE} is not JSON: expected { "<team id>": "https://<listen-fire serve URL>" }.`);
  }
  const targets = z.record(z.string(), z.string()).safeParse(parsed);
  if (!targets.success) throw new Error(`${RELAY_TARGETS_VARIABLE} must be a JSON object of team ids to listen-fire serve URLs.`);
  const production = env.NODE_ENV === 'production';
  for (const [team, target] of Object.entries(targets.data)) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new Error(`${RELAY_TARGETS_VARIABLE}: team ${team}'s target is not a URL.`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${RELAY_TARGETS_VARIABLE}: team ${team}'s target must be an http(s) URL.`);
    if (production && url.protocol !== 'https:') throw new Error(`${RELAY_TARGETS_VARIABLE}: team ${team}'s target must be https in production.`);
  }
  return targets.data;
}

/** Boot check: a relay target that is not a URL (or not https in
 *  production) fails the deployment, naming the variable. */
export function assertLfOAuthRelayConfigured(env: Env = process.env): void {
  relayTargets(env);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function relayPage(text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>lf sign-in</title></head><body><p>${escapeHtml(text)}</p></body></html>`;
}

/** The relay, mounted at `/api/public/lf-secrets` before the request logger. */
export function createLfOAuthRelayRouter(): Router {
  const router = Router();
  router.get('/oauth/callback/:team', async (req, res) => {
    const target = relayTargets()[req.params.team];
    if (target === undefined) {
      res.status(404).type('text/plain').send('No lf is set up to receive sign-ins for this team');
      return;
    }
    const queryAt = req.originalUrl.indexOf('?');
    const query = queryAt === -1 ? '' : req.originalUrl.slice(queryAt + 1);
    const state = new URLSearchParams(query).get('state');
    if (state === null || state === '') {
      res.status(400).type('text/plain').send('This redirect carries no state.');
      return;
    }
    let answer: { status: number; text: string };
    try {
      const forwarded = await fetch(`${target.replace(/\/+$/, '')}/oauth/callback?${query}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      answer = { status: forwarded.status, text: await forwarded.text() };
    } catch {
      logger.warn('[lf-secrets] the OAuth relay could not reach lf', { team: req.params.team });
      res.status(502).type('text/plain').send('lf could not be reached');
      return;
    }
    switch (answer.status) {
      case 200:
        res.status(200).type('text/html').send(relayPage(answer.text));
        return;
      case 404:
        res.status(404).type('text/plain').send('This sign-in is not one a waiting lf started');
        return;
      case 400:
        res.status(400).type('text/plain').send(answer.text);
        return;
      default:
        logger.warn('[lf-secrets] lf answered the OAuth relay with an error', { team: req.params.team, status: answer.status });
        res.status(502).type('text/plain').send('lf could not take this sign-in');
    }
  });
  return router;
}
