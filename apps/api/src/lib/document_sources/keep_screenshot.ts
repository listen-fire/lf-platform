import { Readable } from 'node:stream';

import { logger } from 'movement-engine/public/log';

import { services } from '../../adapters/registry';
import { ImageService } from '../../services/images';

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Keep the screenshot of a page a crawl failed on, for the ops alert. It is
 * hosted as an image (a link) where Cloudflare Images is configured and works,
 * else kept in the install's own document storage, in which case the reference
 * is the stored object's URI, not a link: a signed link would expire before
 * anyone reads the alert. Throws only when neither can keep it — the crawler
 * treats that as non-fatal and still sends the alert.
 */
export async function keepScreenshot(png: Buffer): Promise<string> {
  let imageHostingFailure: string | undefined;
  if (ImageService.isConfigured()) {
    try {
      return ImageService.getDeliveryUrl(await ImageService.upload(new Blob([png])));
    } catch (err) {
      imageHostingFailure = reasonOf(err);
      logger.warn('Image hosting could not keep a crawl screenshot; falling back to document storage', {
        err: imageHostingFailure,
      });
    }
  }

  try {
    const { objectUri } = await services.document.upload(Readable.from(png), {
      filename: 'crawler-error.png',
      mimeType: 'image/png',
      contentLength: png.length,
      keyPrefix: 'crawler-errors',
    });
    return objectUri;
  } catch (err) {
    throw new Error(
      `Could not keep the crawl screenshot: ${
        imageHostingFailure ? `image hosting failed (${imageHostingFailure})` : 'image hosting is not configured'
      }, and document storage failed (${reasonOf(err)})`,
    );
  }
}
