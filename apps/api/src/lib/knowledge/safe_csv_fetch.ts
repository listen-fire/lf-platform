// SSRF-hardened fetch for the importCsv URL. The `csvUrl` is model-supplied, so
// a naive `fetch` could be steered at cloud metadata endpoints, internal
// services, or the loopback interface — directly or via a redirect. This module
// enforces https-only for external hosts, resolves each hop's hostname and
// rejects any address in a private/link-local/loopback/reserved range
// (`net/public_address.ts`), follows redirects manually (re-validating each new
// host so a redirect can't slip past the check), and caps the body while
// streaming so an oversized response can't OOM the process.
//
// The one carve-out is our OWN exposed-file blob base: URLs we minted (which
// 302-redirect to our S3) are trusted and fetched normally. In the dev loop
// that base is `http://localhost:3500`, which the https-only + block-loopback
// rule would otherwise reject, breaking the upload→import loop.

import { publicAddressesOf } from '../net/public_address';

const MAX_REDIRECTS = 3;

/** Reconstruct the exposed-file blob base exactly as `expose.ts` does. */
function ownBlobBase(): string {
  const base =
    process.env.EXPOSED_FILE_PUBLIC_BASE_URL ??
    process.env.OAUTH_REDIRECT_BASE_URL ??
    'http://localhost:3003';
  return `${base}/api/files/blob/`;
}

/** Read a web ReadableStream body enforcing a byte cap; return decoded UTF-8. */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    throw new Error('CSV exceeds the size limit.');
  }

  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('CSV exceeds the size limit.');
    }
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('CSV exceeds the size limit.');
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Fetch CSV text from a (possibly model-supplied) URL with SSRF protections.
 * Trusts our own exposed-file blob base; enforces https + IP-range blocking +
 * manual redirect re-validation + a streamed size cap for everything else.
 */
export async function fetchCsvFromUrl(
  url: string,
  opts: { maxBytes: number; timeoutMs: number },
): Promise<string> {
  // 1. Trusted own-origin carve-out (our minted blob URL 302s to our S3).
  if (url.startsWith(ownBlobBase())) {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Could not fetch csvUrl (HTTP ${res.status}).`);
    }
    return readBodyCapped(res, opts.maxBytes);
  }

  // 2-3. External URLs: https-only, block internal targets, follow redirects
  // manually while re-validating each hop.
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'https:') {
      throw new Error('Only https URLs are allowed for import.');
    }
    await publicAddressesOf(parsed.hostname);

    const res = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        // A 3xx with no Location isn't a redirect we can follow — treat as final.
        if (!res.ok) {
          throw new Error(`Could not fetch csvUrl (HTTP ${res.status}).`);
        }
        return readBodyCapped(res, opts.maxBytes);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    // 4-5. Final response.
    if (!res.ok) {
      throw new Error(`Could not fetch csvUrl (HTTP ${res.status}).`);
    }
    return readBodyCapped(res, opts.maxBytes);
  }

  throw new Error('Too many redirects.');
}
