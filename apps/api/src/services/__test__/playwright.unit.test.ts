import { PlaywrightService, BrowserUnavailableError } from '../playwright';

describe('PlaywrightService.getBrowser on the slim image', () => {
  const original = process.env.LISTEN_FIRE_IMAGE_VARIANT;

  afterEach(() => {
    if (original === undefined) delete process.env.LISTEN_FIRE_IMAGE_VARIANT;
    else process.env.LISTEN_FIRE_IMAGE_VARIANT = original;
  });

  it('fails naming the browser variant instead of launching', async () => {
    process.env.LISTEN_FIRE_IMAGE_VARIANT = 'slim';

    const attempt = PlaywrightService.getBrowser();

    await expect(attempt).rejects.toBeInstanceOf(BrowserUnavailableError);
    await expect(attempt).rejects.toThrow(/ghcr\.io\/listen-fire\/api,/);
  });
});
