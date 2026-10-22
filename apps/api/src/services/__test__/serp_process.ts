// One api process for web_search_two_processes.unit.test.ts: it installs the
// shared limiter as the server's boot does, then, on each command line read
// from stdin, fires that many Bright Data SERP searches at the test's fake
// endpoint. Its answers are stdout lines marked REPLY, so the engine's own log
// lines can share the stream.

import { createInterface } from 'node:readline';

import { installSharedLimiter } from '../../lib/limiter';
import { WebSearchService } from '../web_search';

const REPLY = '@serp-process ';
const BRIGHT_DATA = 'https://api.brightdata.com';

const fakeUrl = process.env.FAKE_BRIGHT_DATA_URL ?? '';
const realFetch = globalThis.fetch;
// The service names Bright Data's host outright; this process sends it to the
// fake, carrying the process's name so the fake can tell the two apart.
globalThis.fetch = (input, init) => {
  const url = String(input);
  if (!url.startsWith(BRIGHT_DATA)) return realFetch(input, init);
  return realFetch(fakeUrl + url.slice(BRIGHT_DATA.length), {
    ...init,
    headers: { ...init?.headers, 'x-process': process.env.PROCESS_NAME ?? '' },
  });
};

function reply(message: Record<string, unknown>): void {
  process.stdout.write(`${REPLY}${JSON.stringify(message)}\n`);
}

async function main(): Promise<void> {
  const installed = await installSharedLimiter();
  reply({ ready: true });
  for await (const line of createInterface({ input: process.stdin })) {
    const searches = Number(line);
    await Promise.all(Array.from({ length: searches }, (_, i) => WebSearchService.search(`query ${i}`)));
    reply({ answered: searches });
  }
  await installed.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
