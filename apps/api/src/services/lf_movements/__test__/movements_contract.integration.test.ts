// The movements slot's conformance suites against the platform's movements
// module, over three bridges:
//   a. direct: the module's answer served in-process under one fixed tenant,
//      spoken to by the engine's SlotClient;
//   b. through lf's own client of a movements module
//      (`lf --contract-movements-slot`), pointed at that same served module by
//      a scratch project, so lf's side of the wire is held to the meaning the
//      module has;
//   c. the real route of a running platform (LF_MOVEMENTS_SLOT_URL, with
//      LF_MOVEMENTS_SLOT_KEY), as the gate and the agent stack run it.
// Cases a and b get a fresh throwaway team each, lf-engined through `deps`,
// seeded with the movements `hello` and `lib/greet`; c runs in the key's team.
//
// The shared cases are not all held: the slot's own five cases that create
// files cannot hold for a module that is read-only, and the contract's
// read-only cases replace them. The three that write nothing are picked by
// name, and the suite asserts it found exactly those three.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { serveSlot, SlotClient, startModule, type SlotAddress } from 'module-runtime/module_wire/wire';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { saveMovement } from '../../translation_graph/movement/provision';
import { LF_MOVEMENTS_MANIFEST, answerFor } from '../answer';
import { WRITE_FREE_CASE_PREFIXES, isTokenlessCase, readOnlyModuleCases, writeFreeMatches } from './contract_cases';

const exec = promisify(execFile);

jest.mock('../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

const LF_BIN = process.env.LF_BIN;
const ROUTE_URL = process.env.LF_MOVEMENTS_SLOT_URL;
const ROUTE_KEY = process.env.LF_MOVEMENTS_SLOT_KEY;

const GREET = 'export function greet(name: <text>) {\n  return "Hello, ${name}!"\n}\n';
const GREET_NEW = 'export function greet(name: <text>) {\n  return "Hi, ${name}!"\n}\n';
const HELLO = `import { manual } from adapters
import { greet } from "lib/greet"

runs = connect manual

function hello(go: <runs-[:\`Invocation\`]->>) {
  return greet(go.\`Run by (name)\`)
}

listen to runs {} fire hello
`;

const lfEngined = { isLfEngineTeam: () => true };

interface Reached {
  address: SlotAddress;
  /** The team whose rows the bridge serves, or null for the real route (the key's own). */
  tenant: string | null;
  close(): Promise<void>;
}

interface Bridge {
  over: string;
  skip: string | null;
  reach(): Promise<Reached>;
}

async function makeTeam(): Promise<TeamId> {
  const id = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id, name: `lf-movements-contract-${id.slice(0, 8)}` } as any)
    .execute();
  return id;
}

async function dropTeam(teamId: string): Promise<void> {
  // cleanupTeam does not name the movement tables; versions cascade.
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId as TeamId).execute();
  await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId as TeamId).execute();
  await cleanupTeam(teamId as TeamId);
}

async function ship(teamId: string, name: string, source: string): Promise<void> {
  const saved = await saveMovement({ teamId, source, name });
  if (!saved.ok) throw new Error(`test: ${name} did not ship: ${JSON.stringify(saved)}`);
}

/** A fresh lf-engined team holding the shipped `lib/greet` and `hello`. */
async function seededTeam(): Promise<TeamId> {
  const team = await makeTeam();
  await ship(team, 'lib/greet', GREET);
  await ship(team, 'hello', HELLO);
  return team;
}

async function serveModule(tenant: string) {
  const token = `tok-${randomUUID()}`;
  const served = await serveSlot({
    manifest: LF_MOVEMENTS_MANIFEST,
    answer: answerFor({ tenant }, lfEngined),
    listen: 0,
    token,
    print: false,
  });
  return { served, token };
}

/** lf's scratch project: the movements slot is the platform module at `url`, its key a setting from the environment. */
function scratchProject(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-platform-movements-'));
  mkdirSync(join(dir, 'externals/platform_movements'), { recursive: true });
  writeFileSync(
    join(dir, 'externals/platform_movements/lf-external.yaml'),
    `name: platform_movements\nkind: core\nslot: movements\nurl: ${url}\nauth: { kind: bearer, field: key }\n`,
  );
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.12.0\ncore:\n  movements: platform_movements\n');
  return dir;
}

const settingsFor = (token: string) => ({ LF_SECRET__PLATFORM_MOVEMENTS__EXTERNAL: 'platform_movements', LF_SECRET__PLATFORM_MOVEMENTS__KEY: token });

const bridges: Bridge[] = [
  {
    over: 'the module served directly',
    skip: null,
    reach: async () => {
      const tenant = await seededTeam();
      const { served, token } = await serveModule(tenant);
      return { tenant, address: { ...served.address, token }, close: () => served.close() };
    },
  },
  {
    over: "lf's client of the module",
    skip: LF_BIN === undefined || LF_BIN === '' ? 'LF_BIN is unset (the lf binary of the pinned release)' : null,
    reach: async () => {
      const tenant = await seededTeam();
      const { served, token } = await serveModule(tenant);
      const project = scratchProject(served.address.baseUrl);
      const started = await startModule(LF_BIN ?? '', ['--contract-movements-slot', '--dir', project], { env: settingsFor(token) });
      return {
        tenant,
        address: started.address,
        close: async () => {
          await started.close();
          await served.close();
          rmSync(project, { recursive: true, force: true });
        },
      };
    },
  },
  {
    over: 'the real route',
    skip: ROUTE_URL === undefined || ROUTE_KEY === undefined || ROUTE_URL === '' ? 'LF_MOVEMENTS_SLOT_URL and LF_MOVEMENTS_SLOT_KEY are unset (no platform to call)' : null,
    reach: async () => ({ tenant: null, address: { baseUrl: ROUTE_URL ?? '', token: ROUTE_KEY ?? '' }, close: async () => undefined }),
  },
];

interface Listed {
  path: string;
  version: string;
}

const listed = async (client: SlotClient) => (await client.call('movements.list', {})) as Listed[];
const readOf = async (client: SlotClient, path: string) => (await client.call('movements.read', { path })) as { text: string; version: string } | null;

describe('the movements slot over the platform module', () => {
  it('holds exactly the three write-free cases of the slot, by name', () => {
    expect(WRITE_FREE_CASE_PREFIXES).toHaveLength(3);
    expect(writeFreeMatches.map((found) => found.length)).toEqual([1, 1, 1]);
  });

  for (const bridge of bridges) {
    const group = bridge.skip === null ? describe : describe.skip;
    if (bridge.skip !== null) console.warn(`movements contract: "${bridge.over}" skipped: ${bridge.skip}`);

    group(bridge.over, () => {
      let reached: Reached | null = null;
      let tenants: string[] = [];

      async function reachOne(): Promise<Reached> {
        const one = await bridge.reach();
        reached = one;
        if (one.tenant !== null) tenants.push(one.tenant);
        return one;
      }

      afterEach(async () => {
        await reached?.close();
        reached = null;
        // The real route's tenant is the key's team: its rows are the stack's, not this test's to clear.
        for (const tenant of tenants) await dropTeam(tenant);
        tenants = [];
      });

      for (const slotCase of readOnlyModuleCases()) {
        // The platform's authentication answers a request with no credential 403, as for every private route (slots_movements.integration asserts it).
        const skipHere = bridge.over === 'the real route' && isTokenlessCase(slotCase);
        (skipHere ? it.skip : it)(slotCase.name, async () => {
          const one = await reachOne();
          await slotCase.run(new SlotClient(one.address));
        });
      }

      it('lists the seeded movements with their versions, and a listed version is the one read answers', async () => {
        const one = await reachOne();
        const client = new SlotClient(one.address);
        const files = await listed(client);
        if (one.tenant !== null) expect(files.map((file) => file.path).sort()).toEqual(['hello.mvt', 'lib/greet.mvt']);
        for (const file of files) {
          expect(file.version).toMatch(/^[0-9a-f]{64}$/);
          expect((await readOf(client, file.path))?.version).toBe(file.version);
        }
      });

      it('two listings agree', async () => {
        const one = await reachOne();
        const client = new SlotClient(one.address);
        expect(await listed(client)).toEqual(await listed(client));
      });

      // A real route's team is the stack's: its movements are not this test's to save.
      (bridge.over === 'the real route' ? it.skip : it)('a fresh shipped save of lib/greet changes its version, and hello keeps its own', async () => {
        const one = await reachOne();
        const client = new SlotClient(one.address);
        const before = new Map((await listed(client)).map((file) => [file.path, file.version]));
        await ship(one.tenant ?? '', 'lib/greet', GREET_NEW);
        const after = new Map((await listed(client)).map((file) => [file.path, file.version]));
        expect(after.get('lib/greet.mvt')).toBeDefined();
        expect(after.get('lib/greet.mvt')).not.toBe(before.get('lib/greet.mvt'));
        expect(after.get('hello.mvt')).toBe(before.get('hello.mvt'));
        expect((await readOf(client, 'lib/greet.mvt'))?.text).toBe(GREET_NEW);
      });
    });
  }

  // Review Focus 4: an import between two listed movements resolves in lf.
  (LF_BIN === undefined || LF_BIN === '' ? it.skip : it)('an import between two listed movements resolves in lf', async () => {
    const tenant = await seededTeam();
    const { served, token } = await serveModule(tenant);
    const project = scratchProject(served.address.baseUrl);
    const env = { ...process.env, ...settingsFor(token) };
    try {
      const check = await exec(LF_BIN ?? '', ['check', '--dir', project], { env });
      expect(check.stdout).toContain('2 file(s), 0 error(s)');
      const run = await exec(LF_BIN ?? '', ['run', 'hello', '--dir', project], { env });
      expect(run.stdout).toContain('Hello, ');
    } finally {
      await served.close();
      rmSync(project, { recursive: true, force: true });
      await dropTeam(tenant);
    }
  }, 60_000);
});
