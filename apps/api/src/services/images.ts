import { getEnvVar } from '../lib/utils/environment';
import { streamToBlob } from '../lib/utils/stream';

// Read at first USE: image hosting is optional, and an eager read made
// importing this module enough to stop a production deployment booting.
const cloudflare = () => ({
  accountId: getEnvVar('CLOUDFLARE_ACCOUNT_ID', { devDefault: '' }),
  accountHash: getEnvVar('CLOUDFLARE_ACCOUNT_HASH', { devDefault: '' }),
  apiToken: getEnvVar('CLOUDFLARE_API_TOKEN', { devDefault: '' }),
});

const cloudflareHost = 'https://api.cloudflare.com';

class Images {
  /** Image hosting is optional; callers whose upload is incidental (a
   *  diagnostic screenshot) ask first rather than learning from a throw. */
  isConfigured(): boolean {
    const { accountId, accountHash, apiToken } = cloudflare();
    return !!(accountId && accountHash && apiToken);
  }

  async upload(data: ReadableStream | Blob, { idOverride }: { idOverride?: string } = {}) {
    const formData = new FormData();
    // NOTE: may cause memory issues
    // ideally we'd stream data right through fetch but formData doesn't support streams
    formData.append('file', data instanceof ReadableStream ? await streamToBlob(data) : data);
    if (idOverride) {
      formData.append('id', idOverride);
    }

    const uploadUrl = new URL(`/client/v4/accounts/${cloudflare().accountId}/images/v1`, cloudflareHost);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
      headers: {
        Authorization: `Bearer ${cloudflare().apiToken}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to upload');
    }

    const responseData: { result: { id: string } } = await response.json();
    return responseData?.result.id;
  }

  getDeliveryUrl(id: string) {
    return `https://imagedelivery.net/${cloudflare().accountHash}/${id}/public`;
  }

  async uploadFromUrl(imageUrl: string): Promise<string | null> {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to download image from url: ${imageUrl}`);
      }

      const imageBlob = await response.blob();
      const imageId = await this.upload(imageBlob);
      const deliveryUrl = this.getDeliveryUrl(imageId);

      return deliveryUrl;
    } catch (error) {
      console.error('Error downloading and uploading image:', error);
      return null;
    }
  }
}

const ImageService = new Images();

export { ImageService };
