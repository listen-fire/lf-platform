// The credential a Valuations install is read through, and the API it opens.
//
// Valuations authenticates with a Bearer api-key. The platform mints it when a
// team connects Valuations and registers its id as one of its own tokens, so
// loop suppression recognises the platform's writes echoed back. Where the API
// is (`baseUrl`) is the host's to say: the platform fills it with its own
// address when the stored credential names none.

import { z } from 'zod';

import type { ModuleContext } from 'module-kit';

/**
 * The stored credential payload:
 * - `apiKey` — the plaintext Bearer token. The platform's api-key table keeps
 *   only its hash; the plaintext lives here, encrypted at rest, so it can be
 *   sent.
 * - `apiKeyId` — the api-key row it belongs to, so delete and rotation can
 *   revoke it and unregister it as a platform token. Optional for credentials
 *   wired by hand (the dev-loop seed).
 * - `baseUrl` — where the API is; absent means the host's own address.
 */
export const nativeValuationsCredsParser = z.object({
  apiKey: z.string().min(1),
  apiKeyId: z.string().uuid().optional(),
  baseUrl: z.string().url().optional(),
});

/** The Valuations REST API of one install. */
export interface ValuationsApi {
  apiKey: string;
  /** Without a trailing slash or the `/api/v1` prefix: every request path
   *  carries that itself. */
  baseUrl: string;
  fetch: typeof fetch;
}

/** The fields the API is opened with. Read leniently: an `apiKeyId` that is
 *  not a uuid never stopped a credential from working. */
const usableFields = z.object({ apiKey: z.string().min(1), baseUrl: z.string().optional() });

/**
 * The API a credential's fields open, or null when they hold no key. A key
 * with nowhere to send it is refused loudly: the host fills `baseUrl`, so its
 * absence is a host that forgot to.
 *
 * Credentials minted before the `/api/v1` prefix moved onto every request
 * path stored it in `baseUrl`; it is stripped so the paths don't double it.
 */
export function valuationsApiFrom(fields: unknown, options: { fetch: typeof fetch; baseUrlOverride?: string }): ValuationsApi | null {
  const parsed = usableFields.safeParse(fields);
  if (!parsed.success) return null;
  const baseUrl = (options.baseUrlOverride ?? parsed.data.baseUrl)?.replace(/\/$/, '').replace(/\/api\/v1$/, '');
  if (baseUrl === undefined || baseUrl === '') {
    throw new Error('Listen-Fire Valuations: the credential names no base URL and the host supplied none.');
  }
  return { apiKey: parsed.data.apiKey, baseUrl, fetch: options.fetch };
}

/** The install's API, read from its credential on every call (a key rotated
 *  between calls is seen by the next one); null when it has none. */
export function moduleValuationsApi(ctx: Pick<ModuleContext, 'credential' | 'fetch' | 'config' | 'log'>): () => Promise<ValuationsApi | null> {
  return async () => {
    let fields: unknown;
    try {
      fields = await ctx.credential.fields();
    } catch (err) {
      ctx.log.warn('[NativeValuationsAdapter] the install has no readable credential', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    return valuationsApiFrom(fields, {
      fetch: ctx.fetch,
      ...(ctx.config.baseUrlOverride !== undefined ? { baseUrlOverride: ctx.config.baseUrlOverride } : {}),
    });
  };
}
