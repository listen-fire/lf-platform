import { Readable } from 'node:stream';

import { Queue } from 'movement-engine/public/queue';
import { ttlCache } from './ttl_cache';

const requestQueue = new Queue<Readable | null>({ concurrency: 10 });

async function getIconForUrl(hostname: string, size: string) {
  return await requestQueue.enqueue(() => getIconForUrlInner(hostname, size));
}

// have to manually cast this due to inconsistent types:
// https://stackoverflow.com/questions/73308289/typescript-error-converting-a-native-fetch-body-webstream-to-a-node-stream
// Also, Node has experimentally introduced the web streams API.
// We're converting this to existing node streams for stability and
// interoperability with express
async function getIconForUrlInner(hostname: string, size: string) {
  const cached = await getCachedIcon(hostname, size);
  if (cached) {
    return Readable.from(cached);
  }

  const googleIconUrl = `https://www.google.com/s2/favicons?sz=${size}&domain_url=${hostname}`;
  try {
    const googleResponse = await fetch(googleIconUrl, { signal: AbortSignal.timeout(5000) });
    if (googleResponse.ok) {
      const arrayBuffer = await googleResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await cacheIcon(hostname, size, buffer);
      return Readable.from(buffer);
    }
  } catch (err) {
    console.warn(err);
  }

  // TODO: this doesn't respect `size` - should we resize it ourselves?
  const ddgIconUrl = `https://icons.duckduckgo.com/ip3/${hostname}.ico`;
  try {
    const ddgResponse = await fetch(ddgIconUrl, { signal: AbortSignal.timeout(5000) });
    if (ddgResponse.ok) {
      const arrayBuffer = await ddgResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await cacheIcon(hostname, size, buffer);

      return Readable.from(buffer);
    }
  } catch (err) {
    console.warn(err);
  }

  return null;
}

async function getCachedIcon(hostname: string, size: string) {
  const cacheKey = `${hostname}:${size}`;
  try {
    return await ttlCache.get(cacheKey);
  } catch (error) {
    console.error(`Failed to get cache for ${cacheKey}:`, error);
    return null;
  }
}

async function cacheIcon(hostname: string, size: string, buffer: Buffer) {
  const oneMonthMs = 30 * 24 * 60 * 60 * 1000;
  const cacheKey = `${hostname}:${size}`;
  try {
    await ttlCache.set(cacheKey, buffer, oneMonthMs);
  } catch (error) {
    console.error(`Failed to cache icon for ${cacheKey}:`, error);
  }
}

export { getIconForUrl };
