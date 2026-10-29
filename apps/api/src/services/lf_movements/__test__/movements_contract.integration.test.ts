// The movements slot's conformance suites against the platform's movements
// module, over three bridges:
//   a. direct: the module's answer served in-process under one fixed tenant,
//      spoken to by the engine's SlotClient;
//   b. through listen-fire's own client of a movements module
//      (`listen-fire --contract-movements-slot`), pointed at that same served module by
//      a scratch project, so lf's side of the wire is held to the meaning the
//      module has;
//   c. the real route of a running platform (LF_MOVEMENTS_SLOT_URL, with
//      LF_MOVEMENTS_SLOT_KEY), as the gate and the agent stack run it.
// Cases a and b get a fresh throwaway team each, lf-engined through `deps`,
// seeded with the movements `hello` and `lib/greet`; c runs in the key's team.
//
// The shared cases are not all held: the slot's own cases that create files
// cannot hold for a module that is read-only, and the contract's read-only
// cases replace them. The six that write nothing are picked by name, and the
// suite asserts it found exactly those six. The watch cases that need a change
// (added, changed, removed, two watchers) are the platform's own below: the
// change is a ship, an unship or a pause made through the platform, and the
// watch is asked over the bridge.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import { serveSlot, SlotClient, startModule, type SlotAddress } from 'module-runtime/module_wire/wire';
import { MovementsWatchAnswer, type MovementsChangeShape } from 'engine-contracts/slots';

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
    skip: LF_BIN === undefined || LF_BIN === '' ? 'LF_BIN is unset (the listen-fire binary of the pinned release)' : null,
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
const watched = (client: SlotClient, params: { cursor?: string; waitMs: number }) => client.read('movements.watch', params, MovementsWatchAnswer);

async function cursorOf(client: SlotClient): Promise<string> {
  const answer = await watched(client, { waitMs: 0 });
  if (!('cursor' in answer)) throw new Error('test: a watch without a cursor answered resync');
  return answer.cursor;
}

/** Asks from `cursor` (held up to a second at a time) until an event is
 *  `wanted`, for at most 10 s, as the slot's own watch cases do. */
async function watchedUntil(
  client: SlotClient,
  cursor: string,
  wanted: (event: MovementsChangeShape) => boolean,
): Promise<{ cursor: string; seen: MovementsChangeShape[] }> {
  const deadline = Date.now() + 10_000;
  const seen: MovementsChangeShape[] = [];
  let from = cursor;
  while (Date.now() < deadline) {
    const answer = await watched(client, { cursor: from, waitMs: 1_000 });
    if (!('cursor' in answer)) throw new Error(`test: ${from} answered resync`);
    from = answer.cursor;
    seen.push(...answer.events);
    if (answer.events.some(wanted)) return { cursor: from, seen };
  }
  throw new Error(`test: no wanted event within 10 s; saw ${JSON.stringify(seen)}`);
}

const eventAt = (path: string, kind: MovementsChangeShape['kind']) => (event: MovementsChangeShape) => event.path === path && event.kind === kind;
const versionIn = (seen: MovementsChangeShape[], wanted: (event: MovementsChangeShape) => boolean) => {
  const event = seen.find(wanted);
  return event !== undefined && event.kind !== 'removed' ? event.version : undefined;
};
const readOf = async (client: SlotClient, path: string) => (await client.call('movements.read', { path })) as { text: string; version: string } | null;

describe('the movements slot over the platform module', () => {
  it('holds exactly the six write-free cases of the slot, by name', () => {
    expect(WRITE_FREE_CASE_PREFIXES).toHaveLength(6);
    expect(writeFreeMatches.map((found) => found.length)).toEqual([1, 1, 1, 1, 1, 1]);
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

      // The platform's changes to a real route's team are the stack's, not this test's to make.
      const changing = bridge.over === 'the real route' ? it.skip : it;

      changing('a shipped movement is reported added and a new shipped text changed, each with the version read answers', async () => {
        const one = await reachOne();
        const client = new SlotClient(one.address);
        const cursor = await cursorOf(client);
        await ship(one.tenant ?? '', 'fresh', HELLO.replaceAll('hello', 'fresh'));
        const added = await watchedUntil(client, cursor, eventAt('fresh.mvt', 'added'));
        expect(versionIn(added.seen, eventAt('fresh.mvt', 'added'))).toBe((await readOf(client, 'fresh.mvt'))?.version);

        await ship(one.tenant ?? '', 'lib/greet', GREET_NEW);
        const changed = await watchedUntil(client, added.cursor, eventAt('lib/greet.mvt', 'changed'));
        expect(versionIn(changed.seen, eventAt('lib/greet.mvt', 'changed'))).toBe((await readOf(client, 'lib/greet.mvt'))?.version);
        expect(changed.seen.filter(eventAt('fresh.mvt', 'added'))).toEqual([]);
      });

      changing('an unshipped movement and a paused one are reported removed', async () => {
        const one = await reachOne();
        const client = new SlotClient(one.address);
        const tenant = (one.tenant ?? '') as TeamId;
        await ship(tenant, 'paused', HELLO.replaceAll('hello', 'paused'));
        const cursor = await cursorOf(client);

        await getAutomationsQb(['movement']).updateTable('movement').set({ current_version_id: null }).where('team_id', '=', tenant).where('name', '=', 'hello').execute();
        const unshipped = await watchedUntil(client, cursor, eventAt('hello.mvt', 'removed'));

        const paused = await getAutomationsQb(['movement']).selectFrom('movement').where('team_id', '=', tenant).where('name', '=', 'paused').select('id').executeTakeFirstOrThrow();
        await getAutomationsQb(['trigger']).updateTable('trigger').set({ run_mode: 'off' }).where('movement_id', '=', paused.id).execute();
        await watchedUntil(client, unshipped.cursor, eventAt('paused.mvt', 'removed'));
      });

      changing('two watchers from one cursor both see a ship', async () => {
        const one = await reachOne();
        const client = new SlotClient(one.address);
        const cursor = await cursorOf(client);
        await ship(one.tenant ?? '', 'both', HELLO.replaceAll('hello', 'both'));
        await watchedUntil(client, cursor, eventAt('both.mvt', 'added'));
        await watchedUntil(client, cursor, eventAt('both.mvt', 'added'));
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

  // listen-fire's own watch over the module: a long-running `listen-fire serve` takes a ship and
  // an unship made on the platform without a restart, as lf prints them.
  (LF_BIN === undefined || LF_BIN === '' ? it.skip : it)('listen-fire serve follows a ship and an unship over the module without a restart', async () => {
    const tenant = await seededTeam();
    const { served, token } = await serveModule(tenant);
    const project = scratchProject(served.address.baseUrl);
    const server = spawn(LF_BIN ?? '', ['serve', '--port', '0', '--dir', project], {
      env: { ...process.env, ...settingsFor(token) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    const waiters: Array<{ pattern: RegExp; found: () => void }> = [];
    for (const output of [server.stdout, server.stderr]) {
      createInterface({ input: output }).on('line', (line) => {
        lines.push(line);
        for (const waiter of [...waiters]) {
          if (!waiter.pattern.test(line)) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.found();
        }
      });
    }
    const printed = (pattern: RegExp, ms: number) =>
      new Promise<number>((resolve, reject) => {
        const since = Date.now();
        if (lines.some((line) => pattern.test(line))) return resolve(0);
        const timer = setTimeout(() => reject(new Error(`listen-fire serve printed no ${pattern} in ${ms} ms:\n${lines.join('\n')}`)), ms);
        waiters.push({ pattern, found: () => (clearTimeout(timer), resolve(Date.now() - since)) });
      });
    const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
    try {
      await printed(/serving on http:\/\/127\.0\.0\.1:\d+/, 30_000);
      // lf takes its first cursor after the open; give it a moment to hold its watch.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await ship(tenant, 'fresh', HELLO.replaceAll('hello', 'fresh'));
      expect(await printed(/^movements: fresh\.mvt added$/, 5_000)).toBeLessThan(5_000);

      await getAutomationsQb(['movement']).updateTable('movement').set({ current_version_id: null }).where('team_id', '=', tenant).where('name', '=', 'fresh').execute();
      await printed(/^movements: fresh\.mvt removed$/, 5_000);
    } finally {
      server.kill('SIGTERM');
      await exited;
      await served.close();
      rmSync(project, { recursive: true, force: true });
      await dropTeam(tenant);
    }
  }, 60_000);
});
