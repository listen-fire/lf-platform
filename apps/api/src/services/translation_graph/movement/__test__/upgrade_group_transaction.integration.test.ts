// Upgrading an import group saves every member in one database transaction
// (real Postgres): when a member cannot move, the members already moved are
// rolled back, so no importer is left on 0.12 importing a library moved to
// the current version.

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { advanceLive, upgradeMovement, type Advance, type ValidateUnder } from '../language_upgrade';

jest.mock('../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));
jest.mock('../../../../lib/slack', () => ({
  sendSlackNotification: async () => undefined,
}));

const LIBRARY = 'export function shout(t: <text>) {\n  return t\n}\n';
const importing = (name: string) => `import { shout } from "lib"\nfunction ${name}(t: <text>) {\n  return shout(t)\n}\n`;

/** Every member checks clean under the target: the move is what is tested. */
const clean: ValidateUnder = async () => ({ ok: true, diagnostics: [], listenerCount: 0, firedMovements: [], catalogNotes: [], gaps: [] });

describe('an upgrading import group moves in one transaction (real Postgres)', () => {
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

  async function seed(name: string, source: string): Promise<string> {
    const id = randomUUID();
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: id as MovementId, team_id: teamId, name, source, description: '', language_version: '0.12.13' })
      .execute();
    return id;
  }

  async function pinOf(id: string): Promise<string | undefined> {
    const row = await getAutomationsQb(['movement'])
      .selectFrom('movement')
      .where('id', '=', id as MovementId)
      .select('language_version')
      .executeTakeFirst();
    return row?.language_version;
  }

  it('a member that cannot move rolls back the library already moved; nothing moves', async () => {
    const lib = await seed('lib', LIBRARY);
    const app = await seed('app', importing('app'));
    const moved: string[] = [];
    // The library moves for real (its save writes inside the group's
    // transaction); the importer's save then fails.
    const advance: Advance = async (input) => {
      if (input.movement.name === 'app') return { ok: false, detail: 'the rewritten text did not ship' };
      const result = await advanceLive(input);
      if (result.ok) moved.push(input.movement.name);
      return result;
    };

    const result = await upgradeMovement({ teamId, id: app, acknowledge: true, validate: clean, advance });

    expect(moved).toEqual(['lib']);
    expect(result).toEqual(expect.objectContaining({ status: 'unverified', detail: 'app: the rewritten text did not ship; nothing moved' }));
    expect(await pinOf(lib)).toBe('0.12.13');
    expect(await pinOf(app)).toBe('0.12.13');
  });

  it('when every member can move, all of them are on the current version afterwards', async () => {
    const lib = await seed('lib2', LIBRARY);
    const app = await seed('app2', importing('app2').replace('"lib"', '"lib2"'));

    const result = await upgradeMovement({ teamId, id: app, acknowledge: true, validate: clean });

    expect(result.status).toBe('upgraded');
    expect(await pinOf(lib)).toBe(LANGUAGE_VERSION);
    expect(await pinOf(app)).toBe(LANGUAGE_VERSION);
  });
});
