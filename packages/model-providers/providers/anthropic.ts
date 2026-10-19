// Anthropic's own API on this deployment's key: @lf/anthropic's keyed
// provider, so the platform and a module calling Claude on its own key build
// the one client the same way.

import type { ChatProvider } from '@listen-fire/anthropic';

import { anthropicKeyedChatProvider } from '@listen-fire/anthropic';

export function anthropicChatProvider(env: NodeJS.ProcessEnv): ChatProvider {
  return anthropicKeyedChatProvider(anthropicKeyFrom(env));
}

function anthropicKeyFrom(env: NodeJS.ProcessEnv): { apiKey: string } {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey === undefined) {
    throw new Error(
      'The ANTHROPIC_API_KEY environment variable is required — it is the key for every model name that resolves to the anthropic provider',
    );
  }
  return { apiKey };
}
