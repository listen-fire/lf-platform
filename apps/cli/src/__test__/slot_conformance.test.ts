// Every core slot over the one transport (adapter protocol 2's HTTP, on a
// Unix socket): lf's built-in modules served as modules (`lf --contract-
// <slot>`) are held to the slot conformance cases (movement-engine
// `public/module-wire`) — the cases every slot module answers alike (its
// manifest, the envelope's refusals) and the models, judge and files slots'
// own. The store, limiter and loop guard are held to their families' contract
// cases over the same wire in run_host_contract, limiter_contract and
// loop_guard_contract. The browser slot, which lf builds none of, is held to
// its contract through the wire client, against the scripted page served as a
// browser module.

import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILES_METHODS, JUDGE_METHODS, MODELS_METHODS } from 'engine-contracts/slots';
import {
  SlotClient,
  browserSlotAnswer,
  commonSlotCases,
  filesSlotCases,
  judgeSlotCases,
  modelsSlotCases,
  remoteBrowserSlot,
  serveSlot,
  startModule,
  type SlotConformanceCase,
} from 'movement-engine/public/module-wire';
import { browserContractCases, type ContractSite } from 'movement-engine/services/browser/contract';
import { fakeBrowser, type FakeSite } from 'movement-engine/services/browser/fake_browser';
import { lfBinary } from './lf_bin';

/** A Messages API that streams one text answer to every request. */
async function fakeAnthropic(): Promise<{ url: string; server: Server }> {
  const text = '{"greeting":"hello"}';
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const builtIns: Array<{ slot: Parameters<typeof commonSlotCases>[0]; args: () => string[]; methods: readonly string[]; cases: SlotConformanceCase[] }> = [
  { slot: 'models', args: () => ['--contract-models'], methods: MODELS_METHODS, cases: modelsSlotCases },
  { slot: 'judge', args: () => ['--contract-judge'], methods: JUDGE_METHODS, cases: judgeSlotCases },
  { slot: 'files', args: () => ['--contract-files'], methods: FILES_METHODS, cases: filesSlotCases },
  { slot: 'store', args: () => ['--contract-store', join(mkdtempSync(join(tmpdir(), 'lf-slot-')), 'state.db')], methods: ['store.open', 'runs.start', 'work.claimDue'], cases: [] },
  { slot: 'limiter', args: () => ['--contract-limiter'], methods: ['limiter.acquire'], cases: [] },
  { slot: 'loopGuard', args: () => ['--contract-guard'], methods: ['guard.isEcho'], cases: [] },
];

for (const builtIn of builtIns) {
  for (const conformance of [...commonSlotCases(builtIn.slot, builtIn.methods), ...builtIn.cases]) {
    test(`lf's built-in ${builtIn.slot} module: ${conformance.name}`, async () => {
      const anthropic = builtIn.slot === 'models' ? await fakeAnthropic() : undefined;
      const module = await startModule(lfBinary(), builtIn.args());
      try {
        await conformance.run(new SlotClient(module.address, anthropic !== undefined ? { api_key: 'test-key', base_url: anthropic.url } : {}));
      } finally {
        await module.close();
        anthropic?.server.close();
      }
    });
  }
}

const SITE: ContractSite = { url: 'https://contract.test/page', title: 'Browser contract', heading: 'Hello' };
const site: FakeSite = {
  open(url) {
    if (url !== SITE.url) throw new Error(`fake site: nothing at ${url}`);
    return { title: () => SITE.title, query: (selector) => (selector === 'h1' ? [{ text: SITE.heading }] : []) };
  },
};

for (const contractCase of browserContractCases) {
  test(`a browser module over the wire: ${contractCase.name}`, async () => {
    const served: Array<{ close(): Promise<void> }> = [];
    try {
      await contractCase.run((limits) => {
        // The slot's limits are the browser module's; the client learns its sessions' deadline from it.
        const answer = browserSlotAnswer(fakeBrowser(site, limits).slot, { sessionMs: limits.sessionMs });
        const ready = serveSlot({ manifest: { protocolVersion: 2, name: 'fake-browser', kind: 'core', slot: 'browser', methods: ['browser.open', 'browser.page', 'browser.close'] }, answer, token: 'browser-token' });
        let slot: ReturnType<typeof remoteBrowserSlot> | undefined;
        return {
          module: 'fake-browser',
          withPage: async (fn, options) => {
            if (slot === undefined) {
              const module = await ready;
              served.push(module);
              slot = remoteBrowserSlot(module.address, 'fake-browser');
            }
            return slot.withPage(fn, options);
          },
        };
      }, SITE);
    } finally {
      await Promise.all(served.map((module) => module.close()));
    }
  });
}
