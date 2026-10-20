// The hosted product's answer to which provider serves each chat model name:
// its MODEL_MAP and environment pick the vendor and its credentials. The seam
// itself (`ChatProvider`, `ChatCall`) lives with the shared client, @lf/anthropic.

import type { ChatCall, ChatProvider } from '@listen-fire/anthropic';
import type { Provider } from 'movement-engine/public/models';
import type { ChatModelName } from 'movement-engine/public/models';

import { assertRunBudget } from 'movement-engine/public/models';
import { neverAsAny } from 'movement-engine/public/types';
import { assertCallable, resolveModel } from 'movement-engine/public/models';
import type { GeminiAccess, GoogleCloudAccess } from './providers/gemini';

import { anthropicKeyedChatProvider } from '@listen-fire/anthropic';
import { anthropicChatProvider } from './providers/anthropic';
import { geminiChatProvider, geminiChatProviderOver, geminiClientOf } from './providers/gemini';
import { openAiChatProvider, openAiChatProviderOver, openAiClientOf } from './providers/openai';
import { vertexChatProvider, vertexChatProviderOf } from './providers/vertex';

function chatProviderFor(provider: Provider, env: NodeJS.ProcessEnv): ChatProvider {
  switch (provider) {
    case 'anthropic':
      return anthropicChatProvider(env);
    case 'vertex':
      return vertexChatProvider(env);
    case 'openai':
      return openAiChatProvider(env);
    case 'gemini':
      return geminiChatProvider(env);
    default:
      return neverAsAny(provider);
  }
}

export function chatCallFor(name: ChatModelName, env: NodeJS.ProcessEnv): ChatCall {
  const resolved = resolveModel(name, env);
  assertCallable(resolved, env);
  // A run that has spent its cost cap gets no further model call. Checked here
  // for the callers that make one request per call; the Anthropic seam's queue
  // checks again per request, for the ones that loop.
  assertRunBudget();
  return { client: chatProviderFor(resolved.provider, env), wireModel: resolved.wireModel, resolved };
}

/** One vendor on settings the caller holds (a models module's install), in
 *  place of this process's environment. */
export type VendorAccess =
  | { provider: 'anthropic'; apiKey: string; baseUrl?: string }
  | { provider: 'openai'; apiKey: string; baseUrl?: string }
  | { provider: 'gemini'; access: GeminiAccess }
  | { provider: 'vertex'; cloud: GoogleCloudAccess };

/** The chat seam on one vendor's own settings: the same translators the
 *  environment's providers use, built on the client the settings name. */
export function chatProviderOf(vendor: VendorAccess): ChatProvider {
  switch (vendor.provider) {
    case 'anthropic':
      return anthropicKeyedChatProvider({ apiKey: vendor.apiKey, ...(vendor.baseUrl !== undefined ? { baseUrl: vendor.baseUrl } : {}) });
    case 'openai':
      return openAiChatProviderOver(openAiClientOf(vendor));
    case 'gemini':
      return geminiChatProviderOver(geminiClientOf(vendor.access));
    case 'vertex':
      return vertexChatProviderOf(vendor.cloud);
    default:
      return neverAsAny(vendor);
  }
}

export type { ChatCall, ChatProvider, GeminiAccess, GoogleCloudAccess };
