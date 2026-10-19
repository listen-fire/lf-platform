// A third-party limiter module for the tests: the limiter slot's methods
// (docs/contracts/limiter-slot.md) served as adapter protocol 2 over HTTP, on
// the socket lf names (`MODULE_SOCKET`), over the TypeScript built-in
// (`MemoryLimiter`). It stands for a limiter shared by many hosts — Redis, a
// database — which is the same wire over other state. It refuses to be used
// before `limiter.open`, as a real one would.

import { MemoryLimiter } from 'movement-engine/services/limiter/limiter';
import { serveSlot } from 'movement-engine/services/module_wire/wire';

const limiter = new MemoryLimiter();
let opened = false;

void serveSlot({
  manifest: { protocolVersion: 2, name: 'acme_limits', kind: 'core', slot: 'limiter', methods: ['limiter.open', 'limiter.acquire', 'limiter.release', 'limiter.throttle'] },
  print: true,
  answer: async (method, params) => {
    if (method === 'limiter.open') {
      opened = true;
      return null;
    }
    if (!opened) throw new Error('open me with limiter.open first');
    switch (method) {
      case 'limiter.acquire':
        return limiter.acquire(params as never);
      case 'limiter.release':
        await limiter.release(String(params.permit));
        return null;
      case 'limiter.throttle':
        await limiter.throttle({ key: String(params.key), until: String(params.until) });
        return null;
      default:
        throw new Error(`no method "${method}"`);
    }
  },
});
