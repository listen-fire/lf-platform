// `movements.watch` over the platform's tables (real DB), called in-process as
// the slot route calls it. Each "instance" is its own watcher with its own
// LISTEN connection, as two api processes behind one database would be: a
// cursor one answered is answered by the other, and a write wakes a watch held
// by either. A file leaving the served set for any reason is `removed`, and
// coming back is `added`.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { LANGUAGE_VERSION } from 'movement-lang';

import type { MovementsChangeShape, MovementsWatchAnswerShape } from 'engine-contracts/slots';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { getDatabaseUrl } from '../../../prisma';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { saveMovement } from '../../translation_graph/movement/provision';
import { deleteMovementRow, upsertMovementRow } from '../../translation_graph/movement/store';
import { mintMovementVersionIfChanged } from '../../translation_graph/movement/version_store';
import { clearGuardPaused, setGuardPaused } from '../../loop_guard/pause';
import { persistCredential } from '../../credentials/persist_credential';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { answerFor } from '../answer';
import { postgresTeamChanges, type TeamChanges } from '../team_changes';
import { WATCH_HOLD_MS, movementsWatcher, type MovementsWatcher } from '../watch';

jest.mock('../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

const MANUAL = (fn: string) => `import { manual } from adapters

runs = connect manual

function ${fn}(go: <runs-[:\`Invocation\`]->>) {
}

listen to runs {} fire ${fn}
`;

const databaseUrl = getDatabaseUrl(false).url ?? '';

let team: TeamId;
let other: TeamId;
const opened: TeamChanges[] = [];

/** One api instance: its own watcher over its own LISTEN connection. */
function instance(options: { holdMs?: number; heldPerTeam?: number } = {}): MovementsWatcher {
  const changes = postgresTeamChanges(databaseUrl);
  opened.push(changes);
  return movementsWatcher({ changes, ...options });
}

function watchOn(watcher: MovementsWatcher, tenant: string = team) {
  const answer = answerFor({ tenant }, { isLfEngineTeam: () => true, watcher });
  return async (params: { cursor?: string; waitMs: number }) => (await answer('movements.watch', params, {})) as MovementsWatchAnswerShape;
}

async function cursorFrom(watcher: MovementsWatcher, tenant: string = team): Promise<string> {
  const answer = await watchOn(watcher, tenant)({ waitMs: 0 });
  if (!('cursor' in answer)) throw new Error('test: a watch without a cursor answered resync');
  expect(answer.events).toEqual([]);
  return answer.cursor;
}

async function makeTeam(): Promise<TeamId> {
  const id = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id, name: `lf-movements-watch-${id.slice(0, 8)}` } as any)
    .execute();
  return id;
}

async function dropTeam(teamId: TeamId): Promise<void> {
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId).execute();
  await sql`DELETE FROM automations.lf_movements_listing WHERE team_id = ${teamId}`.execute(getAutomationsQb(['lf_movements_listing']));
  await cleanupTeam(teamId);
}

async function ship(name: string, source: string = MANUAL(name.replaceAll('/', '_'))): Promise<string> {
  const saved = await saveMovement({ teamId: team, source, name });
  if (!saved.ok) throw new Error(`test: ${name} did not ship: ${JSON.stringify(saved)}`);
  return saved.movementId;
}

/** A shipped movement outside the save gate (no listener). */
async function seed(name: string, source: string): Promise<string> {
  const row = await upsertMovementRow({ teamId: team, name, source });
  await mintMovementVersionIfChanged({ teamId: team, movementId: row.id, source, languageVersion: LANGUAGE_VERSION });
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

async function versionOf(path: string): Promise<string | undefined> {
  const answer = answerFor({ tenant: team }, { isLfEngineTeam: () => true });
  const read = (await answer('movements.read', { path }, {})) as { version: string } | null;
  return read?.version;
}

/** Holds a watch from `cursor`, makes `write` while it is held, and answers
 *  what the watch answered: within 2 s of the write, so the write's own
 *  trigger woke it (a missed wake would hold for the full 10 s). */
async function heldThrough(
  watcher: MovementsWatcher,
  cursor: string,
  write: () => Promise<unknown>,
): Promise<{ cursor: string; events: MovementsChangeShape[] }> {
  const held = watchOn(watcher)({ cursor, waitMs: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const wrote = Date.now();
  await write();
  const answer = await held;
  expect(Date.now() - wrote).toBeLessThan(2_000);
  if (!('cursor' in answer)) throw new Error(`test: ${cursor} answered resync`);
  return answer;
}

beforeEach(async () => {
  team = await makeTeam();
  other = await makeTeam();
});

afterEach(async () => {
  await dropTeam(team);
  await dropTeam(other);
});

afterAll(async () => {
  for (const changes of opened) await changes.close();
});

describe('movements.watch on the platform', () => {
  it('a cursor minted by one instance is answered by another: the difference since it, and nothing twice', async () => {
    const first = instance();
    const second = instance();
    await ship('kept');
    const cursor = await cursorFrom(first);

    await ship('fresh');
    const answer = await watchOn(second)({ cursor, waitMs: 0 });
    expect(answer).toEqual({ cursor: expect.any(String), events: [{ kind: 'added', path: 'fresh.mvt', version: await versionOf('fresh.mvt') }] });

    // The same listing hashes to the same cursor on either instance, and from it nothing is new.
    if (!('cursor' in answer)) throw new Error('test: resync');
    expect(await cursorFrom(first)).toBe(answer.cursor);
    expect(await watchOn(first)({ cursor: answer.cursor, waitMs: 0 })).toEqual({ cursor: answer.cursor, events: [] });
  });

  it('a watch held by one instance from a cursor another minted wakes within 2 s of a ship, with the version read answers', async () => {
    const holder = instance();
    const cursor = await cursorFrom(instance());
    const asked = Date.now();
    const held = watchOn(holder)({ cursor, waitMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const shipped = Date.now();
    await ship('woken');
    const answer = await held;
    const answered = Date.now();

    expect(answered - shipped).toBeLessThan(2_000);
    expect(answered - asked).toBeGreaterThanOrEqual(1_000);
    expect(answer).toEqual({ cursor: expect.any(String), events: [{ kind: 'added', path: 'woken.mvt', version: await versionOf('woken.mvt') }] });
  });

  it('a new shipped text is changed with the new version; another team\'s ship is not an event here', async () => {
    const watcher = instance();
    await seed('lib/greet', 'export function greet() {\n  return "Hello"\n}\n');
    const cursor = await cursorFrom(watcher);

    const changed = await heldThrough(watcher, cursor, () => seed('lib/greet', 'export function greet() {\n  return "Hi"\n}\n'));
    expect(changed.events).toEqual([{ kind: 'changed', path: 'lib/greet.mvt', version: await versionOf('lib/greet.mvt') }]);

    const elsewhere = answerFor({ tenant: other }, { isLfEngineTeam: () => true });
    await saveMovement({ teamId: other, source: MANUAL('theirs'), name: 'theirs' });
    expect(await elsewhere('movements.list', {}, {})).toHaveLength(1);
    expect(await watchOn(watcher)({ cursor: changed.cursor, waitMs: 1_500 })).toEqual({ cursor: changed.cursor, events: [] });
  });

  it('unshipping is removed: a current version cleared, and a movement deleted; shipping again is added', async () => {
    const watcher = instance();
    const cleared = await ship('cleared');
    const deleted = await ship('deleted');
    const cursor = await cursorFrom(watcher);

    const first = await heldThrough(watcher, cursor, () =>
      getAutomationsQb(['movement']).updateTable('movement').set({ current_version_id: null }).where('id', '=', cleared as MovementId).execute(),
    );
    expect(first.events).toEqual([{ kind: 'removed', path: 'cleared.mvt' }]);
    const second = await heldThrough(watcher, first.cursor, () => deleteMovementRow({ teamId: team, id: deleted }));
    expect(second.events).toEqual([{ kind: 'removed', path: 'deleted.mvt' }]);

    const third = await heldThrough(watcher, second.cursor, () => ship('deleted'));
    expect(third.events).toEqual([{ kind: 'added', path: 'deleted.mvt', version: await versionOf('deleted.mvt') }]);
  });

  it('pausing is removed (the loop guard, and run mode off); resuming is added', async () => {
    const watcher = instance();
    const guarded = await triggerOf(await ship('guarded'));
    const off = await triggerOf(await ship('off'));
    const cursor = await cursorFrom(watcher);

    const paused = await heldThrough(watcher, cursor, () => setGuardPaused({ triggerId: guarded, reason: 'test', signal: 'team_budget' }));
    expect(paused.events).toEqual([{ kind: 'removed', path: 'guarded.mvt' }]);
    const switchedOff = await heldThrough(watcher, paused.cursor, () =>
      getAutomationsQb(['trigger']).updateTable('trigger').set({ run_mode: 'off' }).where('id', '=', off).execute(),
    );
    expect(switchedOff.events).toEqual([{ kind: 'removed', path: 'off.mvt' }]);

    const resumed = await heldThrough(watcher, switchedOff.cursor, () => clearGuardPaused({ triggerId: guarded, teamId: team, resumedBy: 'test' }));
    expect(resumed.events).toEqual([{ kind: 'added', path: 'guarded.mvt', version: await versionOf('guarded.mvt') }]);
  });

  it('a credential no longer served removes what imports it; connecting it again adds it back', async () => {
    const watcher = instance();
    await persistCredential({
      teamId: team,
      userId: null,
      name: 'crm',
      type: ExternalServiceType.REMOTE,
      appId: 'acme_crm',
      declaredCredential: 'oauth',
      credentials: { access_token: 't' },
    });
    await seed('uses_crm', 'import { crm } from credentials\n\nfunction a() {}\n');
    const cursor = await cursorFrom(watcher);

    // A shell: the row stays, its secret goes (what a team export leaves).
    const gone = await heldThrough(watcher, cursor, () =>
      getAutomationsQb(['external_service_credentials'])
        .updateTable('external_service_credentials')
        .set({ credentials: null })
        .where('team_id', '=', team)
        .execute(),
    );
    expect(gone.events).toEqual([{ kind: 'removed', path: 'uses_crm.mvt' }]);

    await getAutomationsQb(['external_service_credentials']).deleteFrom('external_service_credentials').where('team_id', '=', team).execute();
    const back = await heldThrough(watcher, gone.cursor, () =>
      persistCredential({
        teamId: team,
        userId: null,
        name: 'crm',
        type: ExternalServiceType.REMOTE,
        appId: 'acme_crm',
        declaredCredential: 'oauth',
        credentials: { access_token: 't2' },
      }),
    );
    expect(back.events).toEqual([{ kind: 'added', path: 'uses_crm.mvt', version: await versionOf('uses_crm.mvt') }]);
  });

  it('a cursor never minted, or minted for another team, is resync; a listing unseen for a day is deleted on the next store', async () => {
    const watcher = instance();
    await ship('mine');
    const mine = await cursorFrom(watcher);
    expect(await watchOn(watcher)({ cursor: 'never-minted', waitMs: 0 })).toEqual({ resync: true });
    expect(await watchOn(watcher, other)({ cursor: mine, waitMs: 0 })).toEqual({ resync: true });

    await sql`UPDATE automations.lf_movements_listing SET seen_at = now() - interval '25 hours' WHERE team_id = ${team}`.execute(
      getAutomationsQb(['lf_movements_listing']),
    );
    await ship('later');
    await cursorFrom(watcher);
    expect(await watchOn(watcher)({ cursor: mine, waitMs: 0 })).toEqual({ resync: true });
  });

  it('at most four watches of a team are held at once in one instance; a fifth is answered at once with no events', async () => {
    const watcher = instance({ holdMs: 3_000 });
    const cursor = await cursorFrom(watcher);
    const asked = Date.now();
    const holding = [1, 2, 3, 4].map(() => watchOn(watcher)({ cursor, waitMs: 3_000 }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const fifth = Date.now();
    expect(await watchOn(watcher)({ cursor, waitMs: 3_000 })).toEqual({ cursor, events: [] });
    expect(Date.now() - fifth).toBeLessThan(1_000);
    // Another team's watch is not counted against this one's.
    const theirs = await cursorFrom(watcher, other);
    const otherAsked = Date.now();
    await watchOn(watcher, other)({ cursor: theirs, waitMs: 1_000 });
    expect(Date.now() - otherAsked).toBeGreaterThanOrEqual(900);

    for (const answer of await Promise.all(holding)) expect(answer).toEqual({ cursor, events: [] });
    expect(Date.now() - asked).toBeGreaterThanOrEqual(2_900);
  });

  it(`a quiet watch is held for the hold bound (${WATCH_HOLD_MS} ms) whatever waitMs asks, and answers its own cursor`, async () => {
    const watcher = instance();
    await ship('quiet');
    const cursor = await cursorFrom(watcher);
    const asked = Date.now();
    expect(await watchOn(watcher)({ cursor, waitMs: 60_000 })).toEqual({ cursor, events: [] });
    const took = Date.now() - asked;
    expect(took).toBeGreaterThanOrEqual(WATCH_HOLD_MS - 50);
    expect(took).toBeLessThan(WATCH_HOLD_MS + 2_000);
  }, WATCH_HOLD_MS + 15_000);
});
