// Upgrading an import group saves every member in one database transaction
// (real Postgres, the real save): when a member cannot move, the members
// already moved are rolled back, their text, pin, version and listen rows
// together, and no provider has been called. An upgrade is always a save, so a
// 0.12 automation whose text the rewrite leaves alone still ends up with its
// listens provisioned under the new pin. Nothing reaches a provider while the
// transaction is open.

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { unsafeCurrentContext } from '../../../context';
import { advanceLive, upgradeMovement, type Advance, type ValidateUnder } from '../language_upgrade';
import { movementCatalogForTeam } from '../catalog';
import { syncListenSubscriptions } from '../listen_subscriptions';

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
      return async (afterCommit) => {
        const result = await move(afterCommit);
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

  it('nothing reaches a provider while the transaction is open: the catalog before it, the subscriptions after', async () => {
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
    expect(seen).toEqual([
      { reached: 'catalog', inTransaction: false },
      { reached: 'subscriptions', inTransaction: false },
    ]);
  });
});
