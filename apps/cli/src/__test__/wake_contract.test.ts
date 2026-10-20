// The wake slot's conformance cases (module-runtime `module_wire/
// conformance.ts`) against a test wake module standing for a cloud queue
// (wake_module/serve.ts): spoken to directly, and through lf's own client of
// it (`lf --contract-wake-slot`, the project's wake slot), so lf's side of
// the wire is held to the meaning the module is. lf builds no wake module in;
// these cases are what keep a separately shipped one honest.

import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { WAKE_METHODS } from 'engine-contracts/slots';
import { SlotClient, commonSlotCases, startModule, wakeSlotCases, type StartedModule } from 'movement-engine/public/module-wire';
import { lfBinary } from './lf_bin';
import { WAKE_MODULE_COMMAND, wakeModuleProject } from './wake_module/project';

/** The endpoint a wake is delivered to: each delivery a worker started, when it arrived. */
async function workerEndpoint(): Promise<{ url: string; starts: number[]; server: Server }> {
  const starts: number[] = [];
  const server = createServer((request, response) => {
    starts.push(Date.now());
    request.resume();
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('the worker endpoint is not on a port');
  return { url: `http://127.0.0.1:${bound.port}/start`, starts, server };
}

const bridges: Array<{ over: string; start(target: string): Promise<{ module: StartedModule; settings: Record<string, string> }> }> = [
  {
    over: 'a wake module',
    start: async (target) => {
      const [command = process.execPath, ...args] = WAKE_MODULE_COMMAND;
      return { module: await startModule(command, args), settings: { target } };
    },
  },
  {
    over: "lf's client of a wake module",
    start: async (target) => ({
      module: await startModule(lfBinary(), ['--contract-wake-slot', '--dir', wakeModuleProject()], {
        env: { LF_SECRET__ACME_WAKE__EXTERNAL: 'acme_wake', LF_SECRET__ACME_WAKE__TARGET: target },
      }),
      settings: {},
    }),
  },
];

for (const bridge of bridges) {
  for (const conformance of commonSlotCases('wake', WAKE_METHODS)) {
    test(`${bridge.over}: ${conformance.name}`, async () => {
      const endpoint = await workerEndpoint();
      const { module, settings } = await bridge.start(endpoint.url);
      try {
        await conformance.run(new SlotClient(module.address, settings));
      } finally {
        await module.close();
        endpoint.server.close();
      }
    });
  }
  for (const conformance of wakeSlotCases) {
    test(`${bridge.over}: ${conformance.name}`, async () => {
      const endpoint = await workerEndpoint();
      const { module, settings } = await bridge.start(endpoint.url);
      try {
        await conformance.run({ client: new SlotClient(module.address, settings), started: async () => [...endpoint.starts], slackMs: 2_000 });
      } finally {
        await module.close();
        endpoint.server.close();
      }
    });
  }
}
