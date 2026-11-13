// Upgrading an import group saves every member in one database transaction
// (real Postgres, the real save): when a member cannot move, the members
// already moved are rolled back, their text, pin, version and listen rows
// together, and no provider has been called. An upgrade is always a save, so a
// 0.12 automation whose text the rewrite leaves alone still ends up with its
// listens provisioned under the new pin. Nothing reaches a provider while the
// transaction is open: what they are owed is a work row, which commits and
// rolls back with the move.

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { unsafeCurrentContext } from '../../../context';
import { listenPauses } from '../../../inbound/listen_pause';
import { setPaused } from '../../../lf_store/listens';
import { advanceLive, liveDeployCheckDeps, upgradeMovement, type Advance, type ValidateUnder } from '../language_upgrade';
import { getMovementRow } from '../store';
import { movementCatalogForTeam } from '../catalog';
import { syncListenSubscriptions } from '../listen_subscriptions';
import { registerBringUpListensWork } from '../listens_up';
import { mintMovementVersionIfChanged } from '../version_store';
import { drainUntilIdle, resetWorkHandlersForTests } from '../../../work/drain';

jest.mock('../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));
jest.mock('../../../../lib/slack', () => ({
  sendSlackNotification: async () => undefined,
}));
jest.mock('../listen_subscriptions', () => {
  const actual = jest.requireActual('../listen_subscriptions');
  return { ...actual, syncListenSubscriptions: jest.fn(actual.syncListenSubscriptions) };
});
jest.mock('../catalog', () => {
  const actual = jest.requireActual('../catalog');
  return { ...actual, movementCatalogForTeam: jest.fn(actual.movementCatalogForTeam) };
});

const mockedSync = syncListenSubscriptions as jest.Mock;
const mockedCatalog = movementCatalogForTeam as jest.Mock;

/** The library as 0.12 left it: the rewrite below renames its parameter, so a
 *  real save of new text runs. */
const LIBRARY = 'export function shout(before: <text>) {\n  return before\n}\n';
const REWRITTEN_LIBRARY = LIBRARY.replaceAll('before', 'after');
const importing = (name: string, library: string) => `import { shout } from "${library}"\nfunction ${name}(t: <text>) {\n  return shout(t)\n}\n`;
const LISTENS = 'function stamp(go: <manual-[:Invocations]->>) {\n}\n\nlisten to manual-[:Invocations]-> fire stamp\n';

/** Every member checks clean under the target; a text still saying `before`
 *  is offered the safe fix to say `after`, so the rewrite really changes it. */
const rewrites: ValidateUnder = async ({ movement, source }) => {
  const text = source ?? movement.source;
  const edits = text.split('\n').flatMap((lineText, index) => {
    const at = lineText.indexOf('before');
    return at < 0 ? [] : [{ line: index + 1, col: at + 1, endLine: index + 1, endCol: at + 1 + 'before'.length, text: 'after' }];
  });
  const [first] = edits;
  const diagnostics =
    first === undefined
      ? []
      : [
          {
            code: 'MOV_TEST_REWRITE',
            message: 'an old spelling',
            severity: 'warning' as const,
            upgrade: true as const,
            line: first.line,
            col: first.col,
            endLine: first.endLine,
            endCol: first.endCol,
            sourceLine: '',
            fix: { edits, safe: true as const },
          },
        ];
  return { ok: true, diagnostics, listenerCount: 0, firedMovements: [], catalogNotes: [], gaps: [] };
};

describe('an upgrading import group moves in one transaction (real Postgres, the real save)', () => {
  let teamId: TeamId;

  beforeAll(async () => {
    resetWorkHandlersForTests();
    registerBringUpListensWork();
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `k5a-${teamId.slice(0, 8)}` } as any)
      .execute();
  });

  afterAll(async () => {
    await cleanupTeam(teamId);
  });

  beforeEach(() => {
    mockedSync.mockClear();
    mockedCatalog.mockClear();
  });

  async function seedNeverShipped(name: string, source: string): Promise<string> {
    const id = randomUUID();
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: id as MovementId, team_id: teamId, name, source, description: '', language_version: '0.12.13' })
      .execute();
    return id;
  }

  /** On 0.12, shipped under that pin, as production left it. */
  async function seed(name: string, source: string): Promise<string> {
    const id = await seedNeverShipped(name, source);
    await mintMovementVersionIfChanged({ teamId, movementId: id, source, languageVersion: '0.12.13' });
    return id;
  }

  async function rowOf(id: string) {
    return getAutomationsQb(['movement'])
      .selectFrom('movement')
      .where('id', '=', id as MovementId)
      .select(['language_version', 'source', 'current_version_id'])
      .executeTakeFirstOrThrow();
  }

  async function parkRunOn(triggerId: TriggerId): Promise<TriggerRunId> {
    const runId = randomUUID() as TriggerRunId;
    await getAutomationsQb(['trigger_run'])
      .insertInto('trigger_run')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: runId, team_id: teamId, trigger_id: triggerId, trigger_type: 'manual', status: 'parked', trigger_payload: {} } as any)
      .execute();
    await getAutomationsQb(['parked_run'])
      .insertInto('parked_run')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: randomUUID(), run_id: runId, address: 'root', status: 'parked', park_reason: 'ask' } as any)
      .execute();
    return runId;
  }

  async function bringUpRowsOf(id: string) {
    // The row is the group's, found by the movement it lists.
    const rows = await getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('kind', '=', 'bring_up_listens').select(['id', 'payload']).execute();
    return rows.filter((row) => (row.payload as { movementIds: string[] }).movementIds.includes(id));
  }

  async function triggersOf(id: string) {
    return getAutomationsQb(['trigger']).selectFrom('trigger').where('movement_id', '=', id as MovementId).select(['id', 'kind']).execute();
  }

  it('a member that cannot move rolls back the real saves before it: text, pin, version and listen rows; no provider is called', async () => {
    const lib = await seed('lib', LIBRARY);
    // The listening member is pulled into the group by importing the library.
    const listens = await seed('app_a', `import { shout } from "lib"
${LISTENS}`);
    const app = await seed('app_b', importing('app_b', 'lib'));
    const libVersion = (await rowOf(lib)).current_version_id;
    const listensVersion = (await rowOf(listens)).current_version_id;
    const sources: Record<string, string> = {};
    const saved: string[] = [];
    // The real preparation and the real save, until the last member refuses.
    const advance: Advance = async (input) => {
      sources[input.movement.name] = input.source;
      if (input.movement.name === 'app_b') return async () => ({ ok: false, detail: 'the rewritten text did not ship' });
      const move = await advanceLive(input);
      return async (moving) => {
        const result = await move(moving);
        if (result.ok) saved.push(input.movement.name);
        // Inside the transaction, the listening member's listen row exists.
        if (input.movement.name === 'app_a') expect(await triggersOf(listens)).toHaveLength(1);
        return result;
      };
    };

    const result = await upgradeMovement({ teamId, id: app, acknowledge: true, validate: rewrites, advance });

    // The fixture really exercises a save of changed text, and a listen row.
    expect(sources.lib).toBe(REWRITTEN_LIBRARY);
    expect(sources.lib).not.toBe(LIBRARY);
    expect(saved).toEqual(['lib', 'app_a']);
    expect(result).toEqual(expect.objectContaining({ status: 'unverified', detail: 'app_b: the rewritten text did not ship; nothing moved' }));

    expect(await rowOf(lib)).toEqual({ language_version: '0.12.13', source: LIBRARY, current_version_id: libVersion });
    expect(await rowOf(listens)).toEqual(expect.objectContaining({ language_version: '0.12.13', current_version_id: listensVersion }));
    expect(await rowOf(app)).toEqual(expect.objectContaining({ language_version: '0.12.13' }));
    expect(await triggersOf(listens)).toEqual([]);
    expect(mockedSync).not.toHaveBeenCalled();
    expect(await bringUpRowsOf(app)).toEqual([]);
  });

  it('when every member can move, all of them are on the current version, under their rewritten text', async () => {
    const lib = await seed('lib2', LIBRARY);
    const app = await seed('app2', importing('app2', 'lib2'));

    const result = await upgradeMovement({ teamId, id: app, acknowledge: true, validate: rewrites });

    expect(result).toEqual(expect.objectContaining({ status: 'upgraded' }));
    expect(await rowOf(lib)).toEqual(expect.objectContaining({ language_version: LANGUAGE_VERSION, source: REWRITTEN_LIBRARY }));
    expect(await rowOf(app)).toEqual(expect.objectContaining({ language_version: LANGUAGE_VERSION }));
  });

  it('a pin only upgrade of a 0.12 automation that listens leaves it with its listens, under the new pin, its version minted', async () => {
    const id = await seed('stamp', LISTENS);
    expect(await triggersOf(id)).toEqual([]);

    const result = await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites });

    expect(result).toEqual(expect.objectContaining({ status: 'upgraded' }));
    if (result.status === 'not_found') throw new Error('unreachable');
    // The rewrite left the text alone.
    expect(result.upgradedSource).toBeUndefined();
    expect(await triggersOf(id)).toEqual([expect.objectContaining({ kind: 'manual' })]);
    const row = await rowOf(id);
    expect(row.language_version).toBe(LANGUAGE_VERSION);
    const version = await getAutomationsQb(['movement_version'])
      .selectFrom('movement_version')
      .where('id', '=', row.current_version_id!)
      .select(['language_version', 'source'])
      .executeTakeFirstOrThrow();
    expect(version).toEqual({ language_version: LANGUAGE_VERSION, source: LISTENS });
  });

  describe('an upgrade never changes whether an automation is live', () => {
    it('a never-shipped automation moves its text and pin, provisions nothing, and stays never-shipped', async () => {
      const id = await seedNeverShipped('draft_stamp', `${LISTENS}// before\n`);

      const result = await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites });

      expect(result.status).toBe('upgraded');
      expect(await rowOf(id)).toEqual({ language_version: LANGUAGE_VERSION, source: `${LISTENS}// after\n`, current_version_id: null });
      expect(await triggersOf(id)).toEqual([]);
      expect(await bringUpRowsOf(id)).toEqual([]);
      expect(mockedCatalog).not.toHaveBeenCalled();
    });

    it('an automation shipped while the upgrade ran is not moved as a draft: nothing moves, and the answer says so', async () => {
      const id = await seedNeverShipped('shipped_meanwhile', `${LISTENS}// before\n`);
      // Prepared as it was found, never shipped; shipped by the time the transaction runs.
      const shippedBetween: Advance = async (input) => {
        const move = await advanceLive(input);
        await mintMovementVersionIfChanged({ teamId, movementId: id, source: input.movement.source, languageVersion: '0.12.13' });
        return move;
      };

      const result = await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites, advance: shippedBetween });

      expect(result).toEqual(expect.objectContaining({ status: 'unverified', detail: expect.stringContaining('shipped while the upgrade ran') }));
      expect(await rowOf(id)).toEqual(expect.objectContaining({ language_version: '0.12.13', source: `${LISTENS}// before\n` }));
      expect(await bringUpRowsOf(id)).toEqual([]);
    });

    const pausedRowOf = (id: string) =>
      getAutomationsQb(['trigger'])
        .selectFrom('trigger')
        .where('movement_id', '=', id as MovementId)
        .select(['kind', 'run_mode', 'guard_paused_at', 'guard_paused_reason', 'guard_paused_signal'])
        .execute();

    /** A row 0.12 left: `config` is what the new plan matches it by, or fails to. */
    async function leftRow(id: string, row: { kind: string; run_mode?: string; guard?: boolean; config?: unknown; fires?: string }): Promise<TriggerId> {
      const triggerId = randomUUID() as TriggerId;
      await getAutomationsQb(['trigger'])
        .insertInto('trigger')
        .values({
          id: triggerId,
          team_id: teamId,
          name: `left-${triggerId.slice(0, 8)}`,
          kind: row.kind,
          config: JSON.stringify(row.config ?? {}),
          movement_id: id as MovementId,
          fired_movement_name: row.fires ?? null,
          run_mode: row.run_mode ?? 'live',
          ...(row.guard === true ? { guard_paused_at: new Date(), guard_paused_reason: 'a team budget breach', guard_paused_signal: 'team_budget' } : {}),
        })
        .execute();
      return triggerId;
    }

    it('a row paused by run_mode stays off, the new listen matched to it', async () => {
      const id = await seed('paused_off', LISTENS);
      const triggerId = await leftRow(id, { kind: 'manual', run_mode: 'off' });

      expect((await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites })).status).toBe('upgraded');

      expect(await triggersOf(id)).toEqual([{ id: triggerId, kind: 'manual' }]);
      expect(await pausedRowOf(id)).toEqual([expect.objectContaining({ run_mode: 'off' })]);
    });

    it('a row the loop guard paused stays paused, the new listen matched to it', async () => {
      const id = await seed('paused_guard', LISTENS);
      await leftRow(id, { kind: 'manual', guard: true });

      await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites });

      expect(await pausedRowOf(id)).toEqual([expect.objectContaining({ run_mode: 'live', guard_paused_reason: 'a team budget breach', guard_paused_signal: 'team_budget', guard_paused_at: expect.any(Date) })]);
    });

    it('a pause on a row the new plan cannot match passes to the row it makes', async () => {
      const off = await seed('paused_unmatched_off', LISTENS);
      await leftRow(off, { kind: 'attio', run_mode: 'off' });
      const guard = await seed('paused_unmatched_guard', LISTENS);
      await leftRow(guard, { kind: 'attio', guard: true });

      await upgradeMovement({ teamId, id: off, acknowledge: true, validate: rewrites });
      await upgradeMovement({ teamId, id: guard, acknowledge: true, validate: rewrites });

      expect(await pausedRowOf(off)).toEqual([expect.objectContaining({ kind: 'manual', run_mode: 'off' })]);
      expect(await pausedRowOf(guard)).toEqual([expect.objectContaining({ kind: 'manual', guard_paused_reason: 'a team budget breach' })]);
    });

    it("the loop breaker's pause outlasts the listen's new pipeline", async () => {
      const id = await seed('paused_breaker', LISTENS);
      const oldPipeline = `listen:paused_breaker:stamp:${randomUUID().slice(0, 8)}`;
      await leftRow(id, { kind: 'manual', config: { listen: { pipeline: oldPipeline } } });
      await setPaused({ tenant: teamId }, { pipeline: oldPipeline, paused: 'LISTEN_LOOP: it echoes itself' });

      expect((await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites })).status).toBe('upgraded');

      const [row] = await triggersOf(id);
      expect(await listenPauses({ teamId, triggerIds: [row!.id] })).toEqual(new Map([[row!.id, { reason: 'LISTEN_LOOP: it echoes itself', held: 0 }]]));
    });

    const TWO_LISTENS =
      'function stamp(go: <manual-[:Invocations]->>) {\n}\n\nfunction other(go: <manual-[:Invocations]->>) {\n}\n\nlisten to manual-[:Invocations]-> fire stamp\nlisten to manual-[:Invocations]-> fire other\n';
    const pausedByMovement = (id: string) =>
      getAutomationsQb(['trigger'])
        .selectFrom('trigger')
        .where('movement_id', '=', id as MovementId)
        .select(['fired_movement_name', 'run_mode'])
        .orderBy('fired_movement_name')
        .execute();

    it('two listens of one channel, one paused: each new listen takes its own predecessor\'s state, found by the movement it fires', async () => {
      const id = await seed('two_listens', TWO_LISTENS);
      await leftRow(id, { kind: 'manual', fires: 'stamp' });
      await leftRow(id, { kind: 'manual', fires: 'other', run_mode: 'off' });

      const result = await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites });

      expect(result.status).toBe('upgraded');
      expect(await pausedByMovement(id)).toEqual([
        { fired_movement_name: 'other', run_mode: 'off' },
        { fired_movement_name: 'stamp', run_mode: 'live' },
      ]);
      expect(result).not.toHaveProperty('warnings');
    });

    it('listens that cannot be told apart, one paused: the pause is kept on the new listen, and the answer names it', async () => {
      const id = await seed('told_apart', LISTENS);
      await leftRow(id, { kind: 'manual', fires: 'stamp', config: { key: 'a' } });
      await leftRow(id, { kind: 'manual', fires: 'stamp', config: { key: 'b' }, run_mode: 'off' });

      const result = await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites });

      expect(result.status).toBe('upgraded');
      expect(await pausedByMovement(id)).toEqual([{ fired_movement_name: 'stamp', run_mode: 'off' }]);
      if (result.status !== 'upgraded') throw new Error('unreachable');
      expect(result.warnings).toEqual([expect.stringContaining('manual listen that fires stamp')]);
    });

    it('a listen whose predecessor is gone from the new plan keeps the pause, and the answer names it', async () => {
      const id = await seed('predecessor_gone', LISTENS);
      await leftRow(id, { kind: 'attio', fires: 'elsewhere', run_mode: 'off' });

      const result = await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites });

      expect(await pausedByMovement(id)).toEqual([{ fired_movement_name: 'stamp', run_mode: 'off' }]);
      if (result.status !== 'upgraded') throw new Error('unreachable');
      expect(result.warnings).toEqual([expect.stringContaining('manual listen that fires stamp')]);
    });

    it("the loop breaker's pause on a row the new plan cannot match follows the listen to its new pipeline", async () => {
      const id = await seed('breaker_retired', LISTENS);
      const oldPipeline = `listen:breaker_retired:stamp:${randomUUID().slice(0, 8)}`;
      await leftRow(id, { kind: 'attio', config: { listen: { pipeline: oldPipeline } } });
      await setPaused({ tenant: teamId }, { pipeline: oldPipeline, paused: 'LISTEN_LOOP: it echoes itself' });

      expect((await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites })).status).toBe('upgraded');

      const [row] = await triggersOf(id);
      expect(await listenPauses({ teamId, triggerIds: [row!.id] })).toEqual(new Map([[row!.id, { reason: 'LISTEN_LOOP: it echoes itself', held: 0 }]]));
    });

    it('the deploy sweep stops a 0.12 automation: its plain rows go, and an upgrade after it finds a pause on the rows that stay', async () => {
      const paused = await seed('swept_paused', LISTENS);
      await leftRow(paused, { kind: 'manual', run_mode: 'off' });
      const guarded = await seed('swept_guarded', LISTENS);
      await leftRow(guarded, { kind: 'manual', guard: true });
      const plain = await seed('swept_plain', LISTENS);
      await leftRow(plain, { kind: 'manual' });
      const { unprovision } = liveDeployCheckDeps({ tag: 't', language: { current: LANGUAGE_VERSION, legacy: new Set<string>(), deprecated: new Set<string>() } });

      for (const id of [paused, guarded, plain]) await unprovision((await getMovementRow({ teamId, id }))!);

      expect(await triggersOf(plain)).toHaveLength(0);
      expect(await pausedRowOf(guarded)).toHaveLength(1);
      expect(await pausedRowOf(paused)).toHaveLength(1);

      await upgradeMovement({ teamId, id: paused, acknowledge: true, validate: rewrites });

      expect(await pausedRowOf(paused)).toEqual([expect.objectContaining({ run_mode: 'off' })]);
    });
  });

  it('a member whose save retires a listen settles the run parked on it, in the open transaction', async () => {
    const id = await seed('stamp_parked', LISTENS);
    // A listen left from before the upgrade, on a channel the new text does not
    // listen on, so the save retires it.
    const leftover = randomUUID() as TriggerId;
    await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({ id: leftover, team_id: teamId, name: 'leftover', kind: 'attio', config: JSON.stringify({}), movement_id: id as MovementId })
      .execute();
    const runId = await parkRunOn(leftover);

    const result = await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites });

    expect(result.status).toBe('upgraded');
    expect(await triggersOf(id)).toEqual([expect.objectContaining({ kind: 'manual' })]);
    const run = await getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', runId).select(['status', 'failure_reason']).executeTakeFirstOrThrow();
    expect(run).toEqual({ status: 'failed', failure_reason: expect.stringContaining('its listener was removed') });
    expect(await getAutomationsQb(['parked_run']).selectFrom('parked_run').where('run_id', '=', runId).select('run_id').execute()).toEqual([]);
  });

  it('when the group rolls back, the run parked on a listen a member retired is still parked', async () => {
    const id = await seed('stamp_parked_back', LISTENS);
    const leftover = randomUUID() as TriggerId;
    await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({ id: leftover, team_id: teamId, name: 'leftover', kind: 'attio', config: JSON.stringify({}), movement_id: id as MovementId })
      .execute();
    const runId = await parkRunOn(leftover);
    const advance: Advance = async (input) => {
      const move = await advanceLive(input);
      return async (moving) => {
        await move(moving);
        return { ok: false, detail: 'a later member refused' };
      };
    };

    const result = await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites, advance });

    expect(result).toEqual(expect.objectContaining({ status: 'unverified' }));
    expect(await triggersOf(id)).toEqual([expect.objectContaining({ id: leftover })]);
    const run = await getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', runId).select(['status']).executeTakeFirstOrThrow();
    expect(run.status).toBe('parked');
    expect(await getAutomationsQb(['parked_run']).selectFrom('parked_run').where('run_id', '=', runId).select('run_id').execute()).toHaveLength(1);
  });

  it('nothing reaches a provider while the transaction is open: the catalog before it, the subscriptions by the work row after', async () => {
    await drainUntilIdle({ teamId });
    const seen: { reached: string; inTransaction: boolean }[] = [];
    const actualCatalog = jest.requireActual('../catalog').movementCatalogForTeam;
    mockedCatalog.mockImplementation((...args: unknown[]) => {
      seen.push({ reached: 'catalog', inTransaction: unsafeCurrentContext()?.kyselyTrx !== undefined });
      return actualCatalog(...args);
    });
    const actualSync = jest.requireActual('../listen_subscriptions').syncListenSubscriptions;
    mockedSync.mockImplementation((...args: unknown[]) => {
      seen.push({ reached: 'subscriptions', inTransaction: unsafeCurrentContext()?.kyselyTrx !== undefined });
      return actualSync(...args);
    });
    const id = await seed('stamp_open', LISTENS);

    const result = await upgradeMovement({ teamId, id, acknowledge: true, validate: rewrites });

    expect(result.status).toBe('upgraded');
    expect(seen).toEqual([{ reached: 'catalog', inTransaction: false }]);
    expect(await bringUpRowsOf(id)).toHaveLength(1);

    await drainUntilIdle({ teamId });

    expect(seen).toEqual([
      { reached: 'catalog', inTransaction: false },
      { reached: 'subscriptions', inTransaction: false },
    ]);
    expect(await bringUpRowsOf(id)).toEqual([]);
  });
});
