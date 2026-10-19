// A third-party loop guard module for the tests: the loopGuard slot's
// methods (docs/contracts/loop-guard-slot.md) served as adapter protocol 2
// over HTTP, on the socket lf names (`MODULE_SOCKET`), over the TypeScript
// built-in (`FingerprintGuard`). It stands for a guard whose memory is
// elsewhere — Redis, a database — which is the same wire over other state. It
// refuses to be used before `guard.open`, as a real one would.

import { FingerprintGuard } from 'movement-engine/services/loop_guard/loop_guard';
import { serveSlot } from 'movement-engine/services/module_wire/wire';

const guard = new FingerprintGuard();
let opened = false;

void serveSlot({
  manifest: { protocolVersion: 2, name: 'acme_guard', kind: 'core', slot: 'loopGuard', methods: ['guard.open', 'guard.recordWrite', 'guard.isEcho'] },
  print: true,
  answer: async (method, params) => {
    if (method === 'guard.open') {
      opened = true;
      return null;
    }
    if (!opened) throw new Error('open me with guard.open first');
    switch (method) {
      case 'guard.recordWrite':
        await guard.recordWrite(params as never);
        return null;
      case 'guard.isEcho':
        return guard.isEcho(params as never);
      default:
        throw new Error(`no method "${method}"`);
    }
  },
});
