// The movements module over the platform's movement tables (real DB), called
// in-process as the slot route calls it, under two throwaway teams that are
// both lf-engined through `deps`. What it must list: a team's shipped,
// current-pin movements whose listeners are not paused and whose names are
// paths, at their shipped text. What it must never reach: another team's rows,
// a draft, a legacy pin. What it must never do: write.

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION, compatible } from 'movement-lang';
import { SlotRefusal } from 'module-runtime/module_wire/wire';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { saveMovement } from '../../translation_graph/movement/provision';
import { upsertMovementRow } from '../../translation_graph/movement/store';
import {
  mintMovementVersionIfChanged,
  movementSourceHash,
  repinCurrentVersion,
} from '../../translation_graph/movement/version_store';
import { clearGuardPaused, setGuardPaused } from '../../loop_guard/pause';
import { persistCredential } from '../../credentials/persist_credential';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { READ_ONLY_REASON, answerFor, platformEngineRefusal } from '../answer';

jest.mock('../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

/** A movement with one manual listener: it saves clean and derives a trigger. */
const MANUAL = (fn: string) => `import { manual } from adapters

runs = connect manual

function ${fn}(go: <runs-[:\`Invocation\`]->>) {
}

listen to runs {} fire ${fn}
`;

/** Names an adapter the team does not have: the save gate withholds it. */
const UNKNOWN_ADAPTER = `import { manual, no_such_adapter_anywhere } from adapters

runs = connect manual
elsewhere = connect no_such_adapter_anywhere

function hello(go: <runs-[:\`Invocation\`]->>) {
}

listen to runs {} fire hello
`;

const lfEngined = { isLfEngineTeam: () => true };

let teamA: TeamId;
let teamB: TeamId;

async function makeTeam(): Promise<TeamId> {
  const id = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id, name: `lf-movements-${id.slice(0, 8)}` } as any)
    .execute();
  return id;
}

async function dropTeam(teamId: TeamId): Promise<void> {
  // cleanupTeam does not name the movement tables; versions cascade.
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
}

beforeEach(async () => {
  teamA = await makeTeam();
  teamB = await makeTeam();
});

afterEach(async () => {
  await dropTeam(teamA);
  await dropTeam(teamB);
});

function slot(tenant: string, deps = lfEngined) {
  const answer = answerFor({ tenant }, deps);
  return (method: string, params: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) =>
    answer(method, params, settings);
}

const list = async (tenant: string) =>
  ((await slot(tenant)('movements.list')) as Array<{ path: string; version: string }>).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
const read = (tenant: string, path: string) =>
  slot(tenant)('movements.read', { path }) as Promise<{ text: string; version: string } | null>;
const paths = async (tenant: string) => (await list(tenant)).map((file) => file.path);

/** A shipped movement, outside the save gate: the row and its version at `pin`. */
async function seed(teamId: string, name: string, source: string, pin: string = LANGUAGE_VERSION): Promise<string> {
  const row = await upsertMovementRow({ teamId, name, source });
  await mintMovementVersionIfChanged({ teamId, movementId: row.id, source, languageVersion: pin });
  return row.id;
}

async function triggerOf(movementId: string): Promise<TriggerId> {
  const row = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('movement_id', '=', movementId as MovementId)
    .select('id')
    .executeTakeFirstOrThrow();
  return row.id as TriggerId;
}

async function refusal(promise: Promise<unknown>): Promise<SlotRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SlotRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the movements module', () => {
  it("another tenant's movements are invisible to list and read", async () => {
    await seed(teamA, 'shared', 'function a() {}\n');
    await seed(teamA, 'only_a', 'function only() {}\n');
    await seed(teamB, 'shared', 'function b() {}\n');

    expect(await list(teamB)).toEqual([{ path: 'shared.mvt', version: movementSourceHash('function b() {}\n') }]);
    expect(await read(teamB, 'only_a.mvt')).toBeNull();
    expect(await read(teamB, 'shared.mvt')).toEqual({
      text: 'function b() {}\n',
      version: movementSourceHash('function b() {}\n'),
    });
    expect(await paths(teamA)).toEqual(['only_a.mvt', 'shared.mvt']);
  });

  it('a draft is never listed: a never-shipped save is absent and an unshipped edit keeps the shipped text and version', async () => {
    const draft = await saveMovement({ teamId: teamA, source: UNKNOWN_ADAPTER, name: 'draft' });
    expect(draft).toMatchObject({ ok: false, needsConfirmation: true });
    expect(await paths(teamA)).toEqual([]);
    expect(await read(teamA, 'draft.mvt')).toBeNull();

    const shipped = MANUAL('hello');
    const saved = await saveMovement({ teamId: teamA, source: shipped, name: 'hello' });
    if (!saved.ok) throw new Error(`test: hello did not save: ${JSON.stringify(saved)}`);
    const edit = await saveMovement({ teamId: teamA, id: saved.movementId, source: UNKNOWN_ADAPTER, name: 'hello' });
    expect(edit).toMatchObject({ ok: false, needsConfirmation: true });
    const live = await getAutomationsQb(['movement'])
      .selectFrom('movement')
      .where('id', '=', saved.movementId as MovementId)
      .select('source')
      .executeTakeFirstOrThrow();
    expect(live.source).toBe(UNKNOWN_ADAPTER);

    const version = movementSourceHash(shipped);
    expect(await list(teamA)).toEqual([{ path: 'hello.mvt', version }]);
    expect(await read(teamA, 'hello.mvt')).toEqual({ text: shipped, version });
  });

  it('a legacy-pin movement is never listed or read', async () => {
    expect(compatible('0.13.0', LANGUAGE_VERSION)).toBe(false);
    await seed(teamA, 'one', 'movement one() {}\n', '1');
    await seed(teamA, 'four', 'movement four() {}\n', '4');
    await seed(teamA, 'later', 'function later() {}\n', '0.13.0');
    await seed(teamA, 'current', 'function current() {}\n');

    expect(await paths(teamA)).toEqual(['current.mvt']);
    for (const path of ['one.mvt', 'four.mvt', 'later.mvt']) expect(await read(teamA, path)).toBeNull();
  });

  it('a movement whose listener is paused is not listed until it is resumed', async () => {
    const guarded = await saveMovement({ teamId: teamA, source: MANUAL('guarded'), name: 'guarded' });
    const off = await saveMovement({ teamId: teamA, source: MANUAL('off'), name: 'off' });
    if (!guarded.ok || !off.ok) throw new Error('test: the paused probes did not save');
    expect(await paths(teamA)).toEqual(['guarded.mvt', 'off.mvt']);

    const guardedTrigger = await triggerOf(guarded.movementId);
    await setGuardPaused({ triggerId: guardedTrigger, reason: 'test', signal: 'team_budget' });
    await getAutomationsQb(['trigger'])
      .updateTable('trigger')
      .set({ run_mode: 'off' })
      .where('id', '=', await triggerOf(off.movementId))
      .execute();

    expect(await paths(teamA)).toEqual([]);
    expect(await read(teamA, 'guarded.mvt')).toBeNull();
    expect(await read(teamA, 'off.mvt')).toBeNull();

    await clearGuardPaused({ triggerId: guardedTrigger, teamId: teamA, resumedBy: 'test' });
    expect(await paths(teamA)).toEqual(['guarded.mvt']);
  });

  it('a movement importing a credential the secrets module does not serve is left out, with what imports it', async () => {
    await persistCredential({
      teamId: teamA,
      userId: null,
      name: 'served_cred',
      type: ExternalServiceType.REMOTE,
      appId: 'acme_crm',
      declaredCredential: 'oauth',
      credentials: { access_token: 't' },
    });
    await seed(teamA, 'uses_served', 'import { served_cred as c } from credentials\n\nfunction a() {}\n');
    await seed(teamA, 'uses_unserved', 'import { missing_cred } from credentials\n\nfunction b() {}\n');
    await seed(teamA, 'imports_the_unserved', 'import { b } from "uses_unserved"\n\nfunction c() {}\n');
    await seed(teamA, 'no_credentials', 'function d() {}\n');

    expect(await paths(teamA)).toEqual(['no_credentials.mvt', 'uses_served.mvt']);
    expect(await read(teamA, 'uses_unserved.mvt')).toBeNull();
    expect(await read(teamA, 'imports_the_unserved.mvt')).toBeNull();
    expect(await read(teamA, 'uses_served.mvt')).not.toBeNull();
    // Another team's credential of the same name serves nothing here.
    expect(await paths(teamB)).toEqual([]);
  });

  it('a paused library a served movement imports is listed; a paused movement nothing imports is not', async () => {
    const lib = await saveMovement({ teamId: teamA, source: MANUAL('lib'), name: 'lib' });
    const deeper = await saveMovement({ teamId: teamA, source: MANUAL('deeper'), name: 'deeper' });
    const alone = await saveMovement({ teamId: teamA, source: MANUAL('alone'), name: 'alone' });
    if (!lib.ok || !deeper.ok || !alone.ok) throw new Error('test: the probes did not save');
    await seed(teamA, 'user', 'import { lib } from "lib"\n\nfunction user() {}\n');
    await seed(teamA, 'paused_user', 'import { deeper } from "deeper"\n\nfunction paused_user() {}\n');
    for (const saved of [lib, deeper, alone]) {
      await getAutomationsQb(['trigger']).updateTable('trigger').set({ run_mode: 'off' }).where('id', '=', await triggerOf(saved.movementId)).execute();
    }

    expect(await paths(teamA)).toEqual(['deeper.mvt', 'lib.mvt', 'paused_user.mvt', 'user.mvt']);
    expect(await read(teamA, 'alone.mvt')).toBeNull();
  });

  it('a name that is not a movement path is left out; a nested name is its path', async () => {
    await seed(teamA, 'a\\b', 'function back() {}\n');
    await seed(teamA, 'x//y', 'function empty() {}\n');
    await seed(teamA, 'lib/greet', 'export function greet() {}\n');

    expect(await paths(teamA)).toEqual(['lib/greet.mvt']);
    expect(await read(teamA, 'lib/greet.mvt')).toMatchObject({ text: 'export function greet() {}\n' });
  });

  it('the version is the shipped text: listed equals read, a repin keeps it, a new text moves it; read is byte-exact', async () => {
    const text = 'function café() {\n  return "naïve — ✓ 日本"\n}\n';
    const id = await seed(teamA, 'versioned', text);
    const [listed] = await list(teamA);
    const first = await read(teamA, 'versioned.mvt');
    expect(first).toEqual({ text, version: listed?.version });
    expect(await list(teamA)).toEqual(await list(teamA));

    const repin = '0.12.0';
    expect(compatible(repin, LANGUAGE_VERSION)).toBe(true);
    expect(repin).not.toBe(LANGUAGE_VERSION);
    const before = await getAutomationsQb(['movement']).selectFrom('movement').where('id', '=', id as MovementId).select('current_version_id').executeTakeFirstOrThrow();
    await repinCurrentVersion({ teamId: teamA, movementId: id, languageVersion: repin });
    const after = await getAutomationsQb(['movement']).selectFrom('movement').where('id', '=', id as MovementId).select('current_version_id').executeTakeFirstOrThrow();
    expect(after.current_version_id).not.toBe(before.current_version_id);
    expect(await read(teamA, 'versioned.mvt')).toEqual(first);

    const changed = `${text}// more\n`;
    await upsertMovementRow({ teamId: teamA, id, name: 'versioned', source: changed });
    await mintMovementVersionIfChanged({ teamId: teamA, movementId: id, source: changed, languageVersion: LANGUAGE_VERSION });
    const moved = await read(teamA, 'versioned.mvt');
    expect(moved).toEqual({ text: changed, version: movementSourceHash(changed) });
    expect(moved?.version).not.toBe(first?.version);
  });

  it('a write is answered read_only after its params are checked, and changes nothing', async () => {
    await seed(teamA, 'kept', 'function kept() {}\n');
    const snapshot = async () => ({
      movements: await getAutomationsQb(['movement']).selectFrom('movement').where('team_id', '=', teamA).selectAll().execute(),
      versions: await getAutomationsQb(['movement_version']).selectFrom('movement_version').where('team_id', '=', teamA).selectAll().execute(),
    });
    const before = await snapshot();
    const write = (params: Record<string, unknown>) => slot(teamA)('movements.write', params);

    expect(await write({ path: 'kept.mvt', text: 'function other() {}\n', expectedVersion: movementSourceHash('function kept() {}\n') })).toEqual({
      kind: 'read_only',
      reason: READ_ONLY_REASON,
    });
    expect(await write({ path: 'fresh.mvt', text: 'function fresh() {}\n', expectedVersion: null })).toEqual({
      kind: 'read_only',
      reason: READ_ONLY_REASON,
    });
    for (const params of [
      { path: '../kept.mvt', text: 'x', expectedVersion: null },
      { path: 'kept.txt', text: 'x', expectedVersion: null },
      { path: 'kept.mvt', expectedVersion: null },
      { path: 'kept.mvt', text: 'x' },
    ]) {
      expect((await refusal(write(params))).code).toBe('bad_request');
    }
    expect((await refusal(slot(teamA)('movements.read', { path: 'a\\b.mvt' }))).code).toBe('bad_request');
    expect(await snapshot()).toEqual(before);
  });

  it('a team that is not lf-engined is refused every method, and so is a request naming another tenant', async () => {
    await seed(teamA, 'hidden', 'function hidden() {}\n');
    const unmarked = slot(teamA, { isLfEngineTeam: () => false });
    const text = platformEngineRefusal(teamA);
    for (const [method, params] of [
      ['movements.list', {}],
      ['movements.read', { path: 'hidden.mvt' }],
      ['movements.write', { path: 'hidden.mvt', text: 'x', expectedVersion: null }],
      ['movements.nothing', {}],
    ] as const) {
      const refused = await refusal(unmarked(method, params));
      expect({ code: refused.code, message: refused.message }).toEqual({ code: 'settings', message: text });
    }

    const elsewhere = await refusal(slot(teamA)('movements.list', {}, { tenant: teamB }));
    expect(elsewhere.code).toBe('settings');
    expect(await slot(teamA)('movements.list', {}, { tenant: teamA })).toEqual([
      { path: 'hidden.mvt', version: movementSourceHash('function hidden() {}\n') },
    ]);
    expect((await refusal(slot(teamA)('movements.nothing'))).code).toBe('method_not_implemented');
  });
});
