// Image generation behind the model map, bound to the hosted product's
// environment and usage ledger. The vendors live in listen-fire's packages/model-providers.

import type { ImageModelName } from 'movement-engine/public/models';
import type { GeneratedImage, ImageRequest } from 'image-providers';

import { generateImage as generateImageWith } from 'image-providers';
import { hostedModelHost } from '../host';

export function generateImage(
  name: ImageModelName,
  req: ImageRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GeneratedImage> {
  return generateImageWith(name, req, hostedModelHost(env));
}

export type { GeneratedImage, ImageRequest };
