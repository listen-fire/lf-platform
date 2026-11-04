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
import { advanceLive, upgradeMovement, type Advance, type ValidateUnder } from '../language_upgrade';
import { movementCatalogForTeam } from '../catalog';
import { syncListenSubscriptions } from '../listen_subscriptions';
import { registerBringUpListensWork } from '../listens_up';
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

  async function seed(name: string, source: string): Promise<string> {
    const id = randomUUID();
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: id as MovementId, team_id: teamId, name, source, description: '', language_version: '0.12.13' })
      .execute();
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
    return getAutomationsQb(['work']).selectFrom('work').where('kind', '=', 'bring_up_listens').where('key', '=', `bring_up_listens:${id}`).select('id').execute();
  }

  async function triggersOf(id: string) {
    return getAutomationsQb(['trigger']).selectFrom('trigger').where('movement_id', '=', id as MovementId).select(['id', 'kind']).execute();
  }

  it('a member that cannot move rolls back the real saves before it: text, pin, version and listen rows; no provider is called', async () => {
    const lib = await seed('lib', LIBRARY);
    const listens = await seed('app_a', `${LISTENS}`);
    // The listening member is pulled into the group by importing the library.
    await getAutomationsQb(['movement'])
      .updateTable('movement')
      .set({ source: `import { shout } from "lib"\n${LISTENS}` })
      .where('id', '=', listens as MovementId)
      .execute();
    const app = await seed('app_b', importing('app_b', 'lib'));
    const sources: Record<string, string> = {};
    const saved: string[] = [];
    // The real preparation and the real save, until the last member refuses.
    const advance: Advance = async (input) => {
      sources[input.movement.name] = input.source;
      if (input.movement.name === 'app_b') return async () => ({ ok: false, detail: 'the rewritten text did not ship' });
      const move = await advanceLive(input);
      return async () => {
        const result = await move();
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

    expect(await rowOf(lib)).toEqual({ language_version: '0.12.13', source: LIBRARY, current_version_id: null });
    expect(await rowOf(listens)).toEqual(expect.objectContaining({ language_version: '0.12.13', current_version_id: null }));
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
      return async () => {
        await move();
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
