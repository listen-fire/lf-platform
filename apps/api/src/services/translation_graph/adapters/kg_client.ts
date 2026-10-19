// The knowledge graph's HTTP client — how the platform's store for the `@lf/kg`
// module reaches the graph, now that the graph is another system rather than a
// privilege (D25).
//
// Structurally this is `native_valuations`' client, deliberately: a credential
// parsed out of `external_service_credentials`, a base URL that defaults to
// this instance, a fetch wrapper that names the operation in its failures.
//
// The wire currency is IDS (K-5). Names ride along for introspection and are
// never identity: a display name is renameable, and a persisted trigger routed
// by name would silently stop matching after a rename.

import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb } from '../../../lib/kysely';
import { decryptToken } from '../../../lib/credentials';
import { apiBaseUrl } from '../../../lib/api_base_url';
import { describeError } from 'movement-engine/public/errors';

/** Where the graph lives, and what proves we may read it. */
export interface KgCredentials {
  apiKey: string;
  baseUrl: string;
}

/** Everything under one namespace, so a path is never assembled by hand. */
const GRAPH_BASE = '/api/v1/knowledge/graph';

const credsCache = new Map<string, KgCredentials>();

/**
 * The stored credential, or the composed default.
 *
 * A team on the composed deployment has a connection minted against this very
 * instance, so `baseUrl` resolves to our own URL and the "hop" is loopback. A
 * self-hoster pointing at their own knowledge deployment stored a real one.
 *
 * `API_BASE_URL` is host-only; every path below carries `/api/v1` itself. A
 * stored value from before that split has the prefix baked in, so it is
 * stripped on load rather than migrated — the older shape dialled a dead port
 * in production for six weeks, and this is what stops it recurring.
 */
export async function loadKgCredentials(credentialsId: string): Promise<KgCredentials> {
  const cached = credsCache.get(credentialsId);
  if (cached) return cached;
  const cred = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', credentialsId as ExternalServiceCredentialsId)
    .select(['id', 'credentials'])
    .executeTakeFirstOrThrow();
  const decrypted = await decryptToken(cred.credentials as Buffer, credentialsId);
  const parsed = JSON.parse(decrypted) as { apiKey: string; baseUrl?: string };
  const storedBaseUrl = parsed.baseUrl?.replace(/\/$/, '').replace(/\/api\/v1$/, '');
  const value: KgCredentials = {
    apiKey: parsed.apiKey,
    baseUrl: storedBaseUrl ?? apiBaseUrl(),
  };
  credsCache.set(credentialsId, value);
  return value;
}

/** Drop a cached credential — the dev loop re-mints connections against a new
 *  port, and a cached base URL would outlive the stack it names. */
export function forgetKgCredentials(credentialsId: string): void {
  credsCache.delete(credentialsId);
}

export interface KgRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Relative to the graph namespace — `/ontology`, `/nodes/:id`, … */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/**
 * `fetch` rejects with a bare "fetch failed" and hides the reason one level
 * down in `cause` — so a transport failure reads identically whether the port
 * was refused, DNS gave up, or the socket died mid-flight. Unwrap it: the whole
 * point of naming the method and path is that a failure should be actionable,
 * and "fetch failed" alone is not.
 */
function describeTransportFailure(err: unknown): string {
  const parts = [describeError(err)];
  let cause: unknown = (err as { cause?: unknown })?.cause;
  while (cause !== undefined && cause !== null && parts.length < 4) {
    const code = (cause as { code?: string }).code;
    parts.push(code ? `${code}: ${describeError(cause)}` : describeError(cause));
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.join(' ← ');
}

/**
 * One graph request. Failures name the method and path AND the transport
 * reason: a run whose reason reads "fetch failed" tells whoever is holding it
 * nothing about which of a movement's dozen graph calls gave up, or why.
 */
export async function kgFetch<T>(creds: KgCredentials, req: KgRequest): Promise<T> {
  const url = new URL(`${creds.baseUrl.replace(/\/$/, '')}${GRAPH_BASE}${req.path}`);
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.apiKey}`,
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });
  } catch (err) {
    throw new Error(
      `Knowledge graph ${req.method} ${req.path} failed (${url.origin}) — ${describeTransportFailure(err)}`,
    );
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Knowledge graph ${req.method} ${req.path} failed: ${response.status} ${text}`,
    );
  }
  if (response.status === 204) return null as unknown as T;
  return (await response.json()) as T;
}

/** `kgFetch`, but a 404 is an ANSWER rather than a failure — "no such record"
 *  is what several reads are asking. */
export async function kgFetchOrNull<T>(
  creds: KgCredentials,
  req: KgRequest,
): Promise<T | null> {
  try {
    return await kgFetch<T>(creds, req);
  } catch (err) {
    if (err instanceof Error && /\b404\b/.test(err.message)) return null;
    throw err;
  }
}

// ── The ontology, as the wire publishes it ─────────────────────────────────
// The shapes are the module's (`@lf/kg`'s store speaks them); the wire is this
// platform's.

export type {
  WireEdgeType,
  WireNodeType,
  WireOntology,
  WirePropertyType,
  WireUniqueness,
} from '@listen-fire/kg/store';
