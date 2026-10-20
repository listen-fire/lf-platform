// Claude on Google Cloud, passed through: the Vertex SDK serves the same
// messages surface as Anthropic's own, minus endpoints the seam never asks for.

import type { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

import type { ChatProvider } from '../chat';
import type { GoogleCloudAccess } from './gemini';

import { googleAuth, googleModelRegion, googleServiceAccount } from './google_account';

let client: AnthropicVertex | undefined;

// Loaded on first use: the Vertex SDK is an optional peer of this package.
function vertexSdk(): typeof import('@anthropic-ai/vertex-sdk') {
  return require('@anthropic-ai/vertex-sdk');
}

export function vertexChatProvider(env: NodeJS.ProcessEnv): ChatProvider {
  return (client ??= new (vertexSdk().AnthropicVertex)({
    projectId: googleServiceAccount(env).projectId,
    region: googleModelRegion(env),
    googleAuth: googleAuth(env),
  }));
}

/** Claude on Vertex on settings the caller holds. Without a service account
 *  the SDK reaches Google with the environment's own credentials. */
export function vertexChatProviderOf(access: GoogleCloudAccess): ChatProvider {
  const { project, location, serviceAccount, baseUrl } = access;
  return new (vertexSdk().AnthropicVertex)({
    projectId: project,
    region: location,
    ...(serviceAccount !== undefined
      ? { googleAuth: googleAuth({ GOOGLE_PROJECT_ID: project, GOOGLE_CLIENT_EMAIL: serviceAccount.clientEmail, GOOGLE_PRIVATE_KEY: serviceAccount.privateKey }) }
      : {}),
    // A fake answers without a token, as the Gemini client's redirect does.
    ...(baseUrl !== undefined ? { baseURL: baseUrl, accessToken: 'fake-vertex-token' } : {}),
  });
}
