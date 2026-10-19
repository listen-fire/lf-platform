// The platform's gated-document reader: `@lf/web`'s reader over the
// platform's own services — its browser slot (Chromium on the api image),
// its model routing and metering for the vision fallback, its prompt for
// picking a data room's deck, its ops channel and image store for alerts.
// These are exactly the services the sources called when they lived here.

import type Anthropic from '@anthropic-ai/sdk';

import { documentReader, type DocumentReaderHost } from '@listen-fire/web';
import { logger } from 'movement-engine/public/log';
import { handleError } from '../errors';
import { recordLlmUsage } from '../llm_usage';
import { chatCallFor } from '../models/chat';
import { Prompt } from '../prompts';
import { sendSlackNotification } from '../slack';
import { getEnvVar } from '../utils/environment';
import { ImageService } from '../../services/images';
import { platformBrowser } from '../../services/playwright';

const VISION_MODEL = 'claude-sonnet-5';

const platformReaderHost: DocumentReaderHost = {
  browser: platformBrowser,
  log: logger,
  fetch: (input, init) => fetch(input, init),
  async vision({ system, screenshot, text, label }) {
    const startMs = Date.now();
    const { client, wireModel, resolved } = chatCallFor(VISION_MODEL);
    const response = await client.messages.create({
      model: wireModel,
      max_tokens: 4096,
      system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot.toString('base64') } },
            { type: 'text', text },
          ],
        },
      ],
    });
    recordLlmUsage({
      resolved,
      callType: 'chat',
      label,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      durationMs: Date.now() - startMs,
    }).catch(() => {});
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  },
  async deckName(documentNames) {
    const { name } = await Prompt.getPitchDeckName({ message: documentNames });
    return name;
  },
  async alert({ channel, text, opsTitle }) {
    await sendSlackNotification({ type: channel, text, opsTitle });
  },
  async keepScreenshot(png) {
    const imageId = await ImageService.upload(new Blob([png]));
    return ImageService.getDeliveryUrl(imageId);
  },
  reportError: (err) => handleError(err),
  googleDriveApiKey: () => getEnvVar('GOOGLE_DRIVE_API_KEY', { devDefault: 'local' }),
};

export const DocumentSourceService = documentReader(platformReaderHost, {
  // Rendering Figma needs a GPU, which production does not have.
  figma: process.env.EXPERIMENTAL_DOCUMENT_SOURCE_FIGMA?.toLowerCase() === 'true',
});

export type { PdfStream, ExternalUrl } from '@listen-fire/web';
