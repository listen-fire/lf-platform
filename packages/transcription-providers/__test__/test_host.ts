import type { ModelHost, UsageRecord } from 'model-providers/host';

/** A host for tests: a word counts as a token, and usage goes to `recordUsage`. */
export function testHost(
  env: NodeJS.ProcessEnv,
  recordUsage: (usage: UsageRecord) => Promise<void>,
): ModelHost {
  return { env, recordUsage, countTokens: (text) => text.trim().split(/\s+/).length };
}
