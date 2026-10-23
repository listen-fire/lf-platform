// The team's engine on its settings page, against a REAL DB: any member reads
// it; only a member with write access switches it, and only on their own team.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../../../lib/kysely';
import { Context } from '../../../../services/context';
import { userPrincipal } from '../../../../services/principal';
import { readTeamEngine } from '../../../../services/lf_engine/team_engine';
import { trpc } from '../../trpc';
import { teamEngineRouter } from '../teamEngine';

type Actor = { userId: string; teamId: TeamId; access: 'read' | 'write' };

function callerFor() {
  return teamEngineRouter(trpc.procedure).createCaller({ authorise: async () => {} });
}

/** The call's outcome, settled INSIDE the context: a Context that ends in an
 *  error re-emits it as an unhandled 'error' event, hiding the tRPC code. */
function actingAs<T>(actor: Actor, fn: (caller: ReturnType<typeof callerFor>) => Promise<T>): Promise<{ ok: T } | { error: unknown }> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal(actor));
  return ctx.runAsync(() =>
    fn(callerFor()).then(
      (ok) => ({ ok }),
      (error: unknown) => ({ error }),
    ),
  );
}

let teamId: TeamId;
let otherTeamId: TeamId;
let admin: Actor;
let reader: Actor;
let outsider: Actor;

beforeEach(() => {
  teamId = randomUUID() as TeamId;
  otherTeamId = randomUUID() as TeamId;
  admin = { userId: randomUUID(), teamId, access: 'write' };
  reader = { userId: randomUUID(), teamId, access: 'read' };
  outsider = { userId: randomUUID(), teamId: otherTeamId, access: 'write' };
});

afterEach(async () => {
  await getAutomationsQb(['team_engine']).deleteFrom('team_engine').where('team_id', 'in', [teamId, otherTeamId]).execute();
});

describe("the team's engine on its settings page", () => {
  it('any member reads it: the platform until someone switches it', async () => {
    expect(await actingAs(reader, (c) => c.get())).toEqual({ ok: { engine: 'platform', changedAt: null, changedBy: null } });
  });

  it('a member with write access switches it, and is recorded as the one who did', async () => {
    expect(await actingAs(admin, (c) => c.set({ engine: 'lf' }))).toEqual({ ok: { engine: 'lf', changed: true } });
    const read = await actingAs(reader, (c) => c.get());
    expect(read).toEqual({ ok: { engine: 'lf', changedAt: expect.any(String), changedBy: admin.userId } });

    expect(await actingAs(admin, (c) => c.set({ engine: 'platform' }))).toEqual({ ok: { engine: 'platform', changed: true } });
    expect((await readTeamEngine(teamId)).engine).toBe('platform');
  });

  it('a read-only member is refused, and the setting does not move', async () => {
    const refused = await actingAs(reader, (c) => c.set({ engine: 'lf' }));
    expect(refused).toEqual({ error: expect.objectContaining({ code: 'FORBIDDEN' }) });
    expect(await readTeamEngine(teamId)).toEqual({ engine: 'platform', changedAt: null, changedBy: null });
  });

  it("a switch acts on the actor's own team only", async () => {
    expect(await actingAs(outsider, (c) => c.set({ engine: 'lf' }))).toEqual({ ok: { engine: 'lf', changed: true } });
    expect((await readTeamEngine(otherTeamId)).engine).toBe('lf');
    expect((await readTeamEngine(teamId)).engine).toBe('platform');
  });

  it('an engine that is neither platform nor lf is refused before anything is written', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the wire can carry any string
    const refused = await actingAs(admin, (c) => c.set({ engine: 'cloud' as any }));
    expect(refused).toEqual({ error: expect.objectContaining({ code: 'BAD_REQUEST' }) });
    expect((await readTeamEngine(teamId)).engine).toBe('platform');
  });
});
