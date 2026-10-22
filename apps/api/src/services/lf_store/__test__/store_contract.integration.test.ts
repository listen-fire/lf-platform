// The store slot's contract suites (the engine's run_host/contract.ts: 50
// cases) against the platform's store module, over three bridges:
//   a. direct: the module's answer served in-process under one fixed tenant,
//      spoken to by the engine's RpcStoreBackend;
//   b. through lf's own client of a store module (`lf --contract-store-slot`),
//      pointed at that same served module by a scratch project, so lf's side
//      of the wire is held to the meaning the module has;
//   c. the real route of a running platform (LF_STORE_SLOT_URL, with
//      LF_STORE_SLOT_KEY), as the gate and the agent stack run it.
// Cases a and b get a fresh throwaway team each; c runs in the key's team.

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  callbackContractCases,
  cancelContractCases,
  deliveryContractCases,
  RpcStoreBackend,
  runHostContractCases,
  type DeliveryContractBackend,
  type RecordsContractBackend,
} from 'movement-engine/public/testing';
import { commonSlotCases } from 'module-runtime/module_wire/conformance';
import { serveSlot, SlotClient, startModule, type SlotAddress } from 'module-runtime/module_wire/wire';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { cleanupTeam } from '../../../test/harness/cleanup';
import { LF_STORE_MANIFEST, answerFor } from '../answer';
import { LF_STORE_METHODS } from '../methods';

const LF_BIN = process.env.LF_BIN;
const ROUTE_URL = process.env.LF_STORE_SLOT_URL;
const ROUTE_KEY = process.env.LF_STORE_SLOT_KEY;

/** One reached store: a backend over the wire, the tenant it acts in, and the
 *  address a raw slot client can speak to. */
interface Reached {
  tenant: string;
  address: SlotAddress;
  /** What starts a backend on it. */
  backend(): RpcStoreBackend;
  close(): Promise<void>;
}

interface Bridge {
  over: string;
  /** Why this bridge does not run here, or null. */
  skip: string | null;
  reach(): Promise<Reached>;
}

/** The platform's module served in-process under `tenant`, behind a token. */
async function serveModule(tenant: string) {
  const token = `tok-${randomUUID()}`;
  const served = await serveSlot({ manifest: LF_STORE_MANIFEST, answer: answerFor({ tenant }), listen: 0, token, print: false });
  return { served, token };
}

/** lf's scratch project: the store slot is the platform module at `url`, its key a setting from the environment. */
function scratchProject(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-platform-store-'));
  mkdirSync(join(dir, 'externals/platform_store'), { recursive: true });
  writeFileSync(
    join(dir, 'externals/platform_store/lf-external.yaml'),
    `name: platform_store\nkind: core\nslot: store\nurl: ${url}\nauth: { kind: bearer, field: key }\n`,
  );
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.12.0\ncore:\n  store: platform_store\n');
  return dir;
}

const bridges: Bridge[] = [
  {
    over: 'the module served directly',
    skip: null,
    reach: async () => {
      const tenant = randomUUID();
      const { served, token } = await serveModule(tenant);
      const address: SlotAddress = { ...served.address, token };
      return { tenant, address, backend: () => new RpcStoreBackend(address), close: () => served.close() };
    },
  },
  {
    over: "lf's client of the module",
    skip: LF_BIN === undefined || LF_BIN === '' ? 'LF_BIN is unset (the lf binary of the pinned release)' : null,
    reach: async () => {
      const tenant = randomUUID();
      const { served, token } = await serveModule(tenant);
      const args = ['--contract-store-slot', '--dir', scratchProject(served.address.baseUrl)];
      const settings = { LF_SECRET__PLATFORM_STORE__EXTERNAL: 'platform_store', LF_SECRET__PLATFORM_STORE__KEY: token };
      const bin = LF_BIN ?? '';
      // RpcStoreBackend starts the binary with the inherited environment, so the
      // settings are set around the start and the backend is made at once.
      const started = await startModule(bin, args, { env: settings });
      return {
        tenant,
        address: started.address,
        backend: () => new RpcStoreBackend(started.address),
        close: async () => {
          await started.close();
          await served.close();
        },
      };
    },
  },
  {
    over: 'the real route',
    skip: ROUTE_URL === undefined || ROUTE_KEY === undefined || ROUTE_URL === '' ? 'LF_STORE_SLOT_URL and LF_STORE_SLOT_KEY are unset (no platform to call)' : null,
    reach: async () => {
      const address: SlotAddress = { baseUrl: ROUTE_URL ?? '', token: ROUTE_KEY ?? '' };
      const opened = await new SlotClient(address).call('store.open', {});
      const tenant = (opened as { tenant?: unknown } | null)?.tenant;
      if (typeof tenant !== 'string') throw new Error('store.open did not answer a tenant');
      return { tenant, address, backend: () => new RpcStoreBackend(address), close: async () => undefined };
    },
  },
];

function recordsBackend(backend: RpcStoreBackend, tenant: string): RecordsContractBackend {
  return {
    store: backend.store,
    callbacks: backend.callbacks,
    runs: backend.runs,
    teamId: tenant,
    newRun: async () => {
      const id = randomUUID();
      await backend.startRun({ id, file: 'f', movement: 'm', startedAt: new Date().toISOString(), input: '{}' });
      return id;
    },
    requestCancel: (input) => backend.requestCancel(input),
    runStatus: (runId) => backend.runStatus(runId),
    completeRun: (runId) => backend.completeRun(runId),
  };
}

function deliveryBackend(backend: RpcStoreBackend, tenant: string): DeliveryContractBackend {
  return {
    teamId: tenant,
    keepDelivery: (input) => backend.keepDelivery(input),
    deliveries: (input) => backend.deliveries(input),
    delivery: (input) => backend.delivery(input),
    sweepDeliveries: (input) => backend.sweepDeliveries(input),
    checkpoint: (input) => backend.checkpoint(input),
    startRun: (input) => backend.startRun(input),
    completeRun: (runId) => backend.completeRun(runId),
    runGet: (input) => backend.runGet(input),
    claimDue: (input) => backend.store.work.claimDue(input),
  };
}

const recordCases = [...runHostContractCases, ...callbackContractCases, ...cancelContractCases];

describe('the store slot over the platform module', () => {
  it('holds the engine contract to its 50 cases', () => {
    expect(recordCases.length + deliveryContractCases.length).toBe(50);
  });

  for (const bridge of bridges) {
    const group = bridge.skip === null ? describe : describe.skip;
    if (bridge.skip !== null) console.warn(`store contract: "${bridge.over}" skipped: ${bridge.skip}`);

    group(bridge.over, () => {
      let reached: Reached | null = null;
      let tenants: string[] = [];

      async function reachOne(): Promise<Reached> {
        const one = await bridge.reach();
        reached = one;
        tenants.push(one.tenant);
        return one;
      }

      afterEach(async () => {
        await reached?.close();
        reached = null;
        // The real route's tenant is the key's team: its rows are the stack's, not this test's to clear.
        if (bridge.over !== 'the real route') for (const tenant of tenants) await cleanupTeam(tenant as TeamId);
        tenants = [];
      });

      it('answers the common slot cases', async () => {
        const one = await reachOne();
        const client = new SlotClient(one.address);
        for (const slotCase of commonSlotCases('store', LF_STORE_METHODS)) {
          // The platform's authentication answers a request with no credential 403, as for every private route (slots_store.integration asserts it).
          if (bridge.over === 'the real route' && slotCase.name.includes("without the module's token")) continue;
          await slotCase.run(client);
        }
      });

      for (const contractCase of recordCases) {
        it(contractCase.name, async () => {
          const one = await reachOne();
          const backend = one.backend();
          try {
            await contractCase.run(recordsBackend(backend, one.tenant));
          } finally {
            await backend.close();
          }
        });
      }

      for (const contractCase of deliveryContractCases) {
        it(contractCase.name, async () => {
          const one = await reachOne();
          const backend = one.backend();
          try {
            await contractCase.run(deliveryBackend(backend, one.tenant));
          } finally {
            await backend.close();
          }
        });
      }
    });
  }
});
