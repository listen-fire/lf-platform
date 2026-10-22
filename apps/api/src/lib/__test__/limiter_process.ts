// One api process for limiter_two_processes.unit.test.ts: it installs the
// shared limiter as the server's boot does, then, on each command line read
// from stdin, fires that many model calls through @lf/anthropic's client at
// the test's fake Messages server. Its answers are stdout lines marked
// REPLY, so the engine's own log lines can share the stream.

import { createInterface } from 'node:readline';

import { z } from 'zod';
import { anthropicClient, anthropicKeyedChatProvider } from '@listen-fire/anthropic';

import { installSharedLimiter } from '../limiter';

const REPLY = '@limiter-process ';

// One key for both processes, since the limit is per key; the fake server tells
// the processes apart by the first path segment instead.
const baseUrl = `${process.env.FAKE_ANTHROPIC_URL}/${process.env.PROCESS_NAME ?? ''}`;
const apiKey = 'the-shared-key';

const client = anthropicClient({
  chatCallFor: (name) => ({
    client: anthropicKeyedChatProvider({ apiKey, baseUrl }),
    wireModel: 'claude-fake',
    resolved: { preferred: name, provider: 'anthropic', wireModel: 'claude-fake' },
  }),
  recordUsage: async () => {},
  logFields: () => ({}),
});

function call(): Promise<{ ok: boolean }> {
  return client.anthropicChatStructured({
    system: 'answer',
    userMessage: 'answer',
    schema: z.object({ ok: z.boolean() }),
    toolName: 'answer',
    toolDescription: 'answer',
  });
}

function reply(message: Record<string, unknown>): void {
  process.stdout.write(`${REPLY}${JSON.stringify(message)}\n`);
}

async function main(): Promise<void> {
  const installed = await installSharedLimiter();
  reply({ ready: true });
  for await (const line of createInterface({ input: process.stdin })) {
    const calls = Number(line);
    const startedAt = Date.now();
    const answers = await Promise.all(Array.from({ length: calls }, call));
    reply({ answered: answers.filter((answer) => answer.ok).length, startedAt, finishedAt: Date.now() });
  }
  await installed.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
