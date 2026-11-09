// Saving a movement pinned to 0.12, over the real save (real Postgres, the
// real saveMovement gate): an ordinary edit keeps its pin, is checked by 0.12's
// own checker, and records its validity against 0.12; and since this platform
// does not run 0.12, nothing is provisioned and the save says so. A library
// import across versions is an error on the current version too.

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { runningOf } from '@listen-fire/language-versions';

import { getMovement, listMovements, saveMovement } from '../provision';
import { getMovementRow } from '../store';

jest.mock('../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));
jest.mock('../../../../lib/slack', () => ({
  sendSlackNotification: async () => undefined,
}));

/** A manual listen as 0.12 spells it: the unit by name. */
const ECHO_012 = (text: string) =>
  `function echo(run: <manual-[:Invocation]->>) {\n  return run.${text}\n}\nlisten to manual fire echo\n`;
/** The same listen as 0.13 and later spell it. */
const ECHO_015 = `function echo(run: <manual-[:Invocation]->>) {\n  return run.Text\n}\nlisten to manual-[:Invocations]-> fire echo\n`;

describe('a 0.12 movement saved (real Postgres)', () => {
  let teamId: TeamId;

  beforeAll(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `k4-${teamId.slice(0, 8)}` } as any)
      .execute();
  });

  afterAll(async () => {
    await cleanupTeam(teamId);
  });

  /** A saved movement on `pin`, as production's 0.12 saves left it. */
  async function seed(name: string, source: string, pin: string): Promise<string> {
    const id = randomUUID();
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: id as MovementId, team_id: teamId, name, source, description: '', language_version: pin })
      .execute();
    return id;
  }

  async function triggerCount(movementId: string): Promise<number> {
    const rows = await getAutomationsQb(['trigger'])
      .selectFrom('trigger')
      .where('movement_id', '=', movementId as MovementId)
      .select('id')
      .execute();
    return rows.length;
  }

  it("keeps its pin, validates under 0.12, and a clean save goes live under it", async () => {
    const id = await seed('echo-012', ECHO_012('Text'), '0.12.13');

    const saved = await saveMovement({ audience: { for: 'run' }, teamId, id, source: ECHO_012('Content') });

    const row = await getMovementRow({ teamId, id });
    expect(row?.languageVersion).toBe('0.12.13');
    expect(row?.source).toBe(ECHO_012('Content'));
    expect(row?.validityStatus).toBe('valid');
    expect(row?.validityCheckedAgainst).toBe('0.12.13');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.listeners).toEqual([expect.objectContaining({ kind: 'manual', movementName: 'echo' })]);
    expect(saved.warnings).toEqual([]);
    expect(await triggerCount(id)).toBe(1);
  });

  it("an edit 0.12's checker rejects is held for consent, under 0.12, with 0.12's diagnostic", async () => {
    const id = await seed('typo-012', ECHO_012('Text'), '0.12.13');

    const saved = await saveMovement({ audience: { for: 'run' }, teamId, id, source: ECHO_012('Textt') });

    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.needsConfirmation).toBe(true);
    expect(saved.errors).toEqual([expect.stringContaining("no field 'Textt'")]);
    const row = await getMovementRow({ teamId, id });
    expect(row?.languageVersion).toBe('0.12.13');
    expect(row?.validityStatus).toBe('invalid');
    expect(row?.validityCheckedAgainst).toBe('0.12.13');
  });

  it('an edit in 0.15 spelling is not read as 0.15: the pin stays, and 0.12 reports it', async () => {
    const id = await seed('respelled-012', ECHO_012('Text'), '0.12.13');

    const saved = await saveMovement({ audience: { for: 'run' }, teamId, id, source: ECHO_015 });

    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.needsConfirmation).toBe(true);
    expect(saved.errors).toEqual([expect.stringContaining("Expected 'fire' after 'listen to manual'")]);
    expect((await getMovementRow({ teamId, id }))?.languageVersion).toBe('0.12.13');
  });

  it('a new movement is created on the current version', async () => {
    const saved = await saveMovement({ audience: { for: 'run' }, teamId, source: ECHO_015, name: 'fresh' });
    expect(saved.movementId).toBeDefined();
    const row = await getMovementRow({ teamId, id: saved.movementId ?? '' });
    expect(row?.languageVersion).toBe(LANGUAGE_VERSION);
  });

  it('a current movement importing a 0.12 library is an error naming both pins', async () => {
    await seed('lib-012', 'export function shout(t: <text>) {\n  return t\n}\n', '0.12.13');
    const importer = 'import { shout } from "lib-012"\n' + ECHO_015.replace('return run.Text', 'return shout(run.Text)');

    const saved = await saveMovement({ audience: { for: 'run' }, teamId, source: importer, name: 'importer' });

    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.needsConfirmation).toBe(true);
    expect(saved.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`on language ${LANGUAGE_VERSION.replace(/\./g, '\\.')}, and the library 'lib-012' it imports is on language 0\\.12\\.13`))]),
    );
  });

  it("listing automations answers 0.12's Run now availability without loading 0.12", async () => {
    const running = runningOf('0.12.13');
    if (running.kind !== 'carried') throw new Error('0.12 does not run on this build');
    const loads = jest.spyOn(running, 'lane');
    const pressable = await seed('pressable', ECHO_012('Text'), '0.12.13');
    const scheduled = await seed('scheduled', 'function tick(t: <cron-[:Tick]->>) {\n}\nlisten to cron { every: "1h" } fire tick\n', '0.12.13');

    const listed = await listMovements(teamId);

    expect(listed.find((m) => m.id === pressable)?.runnable).toBe(true);
    expect(listed.find((m) => m.id === scheduled)?.runnable).toBe(false);
    expect((await getMovement({ teamId, id: pressable }))?.runnable).toBe(true);
    expect(loads).not.toHaveBeenCalled();
    loads.mockRestore();
  });
});
