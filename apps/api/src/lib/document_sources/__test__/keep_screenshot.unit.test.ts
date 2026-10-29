import { services } from '../../../adapters/registry';
import { ImageService } from '../../../services/images';
import { keepScreenshot } from '../keep_screenshot';

const png = Buffer.from('png');

function documentStore(upload: jest.Mock) {
  services.document = { upload } as unknown as typeof services.document;
}

afterEach(() => jest.restoreAllMocks());

describe('keepScreenshot', () => {
  it('stores in document storage when Cloudflare Images is not configured', async () => {
    jest.spyOn(ImageService, 'isConfigured').mockReturnValue(false);
    const imageUpload = jest.spyOn(ImageService, 'upload');
    const upload = jest.fn().mockResolvedValue({ objectUri: 's3://bucket/crawler-errors/x.png', checksum: '' });
    documentStore(upload);

    await expect(keepScreenshot(png)).resolves.toBe('s3://bucket/crawler-errors/x.png');

    expect(imageUpload).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mimeType: 'image/png', contentLength: png.length, keyPrefix: 'crawler-errors' }),
    );
  });

  it('uses Cloudflare Images, and not document storage, when it is configured', async () => {
    jest.spyOn(ImageService, 'isConfigured').mockReturnValue(true);
    jest.spyOn(ImageService, 'upload').mockResolvedValue('img-1');
    jest.spyOn(ImageService, 'getDeliveryUrl').mockReturnValue('https://imagedelivery.net/h/img-1/public');
    const upload = jest.fn();
    documentStore(upload);

    await expect(keepScreenshot(png)).resolves.toBe('https://imagedelivery.net/h/img-1/public');
    expect(upload).not.toHaveBeenCalled();
  });

  it('falls back to document storage when the Cloudflare upload fails', async () => {
    jest.spyOn(ImageService, 'isConfigured').mockReturnValue(true);
    jest.spyOn(ImageService, 'upload').mockRejectedValue(new Error('Failed to upload'));
    documentStore(jest.fn().mockResolvedValue({ objectUri: 's3://bucket/crawler-errors/y.png', checksum: '' }));

    await expect(keepScreenshot(png)).resolves.toBe('s3://bucket/crawler-errors/y.png');
  });

  it('throws a clear error naming both causes when neither can keep it', async () => {
    jest.spyOn(ImageService, 'isConfigured').mockReturnValue(true);
    jest.spyOn(ImageService, 'upload').mockRejectedValue(new Error('Failed to upload'));
    documentStore(jest.fn().mockRejectedValue(new Error('Object storage is not configured')));

    await expect(keepScreenshot(png)).rejects.toThrow(
      /image hosting failed \(Failed to upload\), and document storage failed \(Object storage is not configured\)/,
    );
  });

  it('says image hosting is not configured when it never was', async () => {
    jest.spyOn(ImageService, 'isConfigured').mockReturnValue(false);
    documentStore(jest.fn().mockRejectedValue(new Error('no storage')));

    await expect(keepScreenshot(png)).rejects.toThrow(/image hosting is not configured, and document storage failed/);
  });
});
