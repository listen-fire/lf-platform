// Listen-Fire Valuations webhook self-registration.
//
// Valuations exposes `/api/v1/valuations/webhooks` for self-registration. Two
// surfaces register against it and must never drift:
//   - the adapter's `ensureEventSubscription` / `removeEventSubscription` — the
//     movement-listen bridge (a webhook is provisioned when a movement
//     `listen`s to the Valuations instance);
//   - the platform's Settings provider ("Create subscription"), which calls
//     these with the API it opens from the credential it reads.
// Both are thin callers of the register/deregister helpers here.

import crypto from 'node:crypto';

import type { ValuationsApi } from './credential';

async function valuationsApi(api: ValuationsApi, init: { method: 'POST' | 'DELETE'; path: string; body?: unknown }): Promise<Response> {
  const url = `${api.baseUrl.replace(/\/$/, '')}${init.path}`;
  const res = await api.fetch(url, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${api.apiKey}`,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Valuations REST ${init.method} ${init.path} failed: ${res.status} ${text}`);
  }
  return res;
}

/**
 * Register a delivery webhook with Valuations. The target URL is the stable key
 * (Valuations' webhook table has no per-endpoint grouping column; URL does the
 * work), so it is BOTH the registration argument and the `externalId` handed
 * back for `deregister` to delete by. The HMAC secret is generated here and
 * handed to Valuations (the sender) so the outbox worker can sign deliveries;
 * the same value rides the platform's subscription row to verify inbound.
 */
export async function registerValuationsWebhook(
  api: ValuationsApi,
  input: { targetUrl: string; eventTypes: string[] },
): Promise<{ externalId: string; secret: string }> {
  const secret = crypto.randomBytes(32).toString('hex');
  await valuationsApi(api, {
    method: 'POST',
    path: '/api/v1/valuations/webhooks',
    body: { url: input.targetUrl, eventTypes: input.eventTypes, secret },
  });
  return { externalId: input.targetUrl, secret };
}

/** Deregister by the target URL (`externalId`). DELETE matches by url, so all
 *  per-event-type rows for the destination soft-delete in one call. */
export async function deregisterValuationsWebhook(api: ValuationsApi, input: { externalId: string }): Promise<void> {
  await valuationsApi(api, {
    method: 'DELETE',
    path: `/api/v1/valuations/webhooks?url=${encodeURIComponent(input.externalId)}`,
  });
}
