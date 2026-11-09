// The save rule against a REAL database: a person's save that creates an
// automation commits it with its statements, in one transaction, and records
// who created it; a refused save stores nothing.

import { randomUUID } from 'node:crypto';

import { runWithPrincipal } from 'principal';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { accessTo } from '../../../access/decide';
import { StatementStore } from '../../../access/statement';
import { userPrincipal } from '../../../principal';
import { ProvisioningService } from '../../../provisioning';
import { saveMovement } from '../provision';
import { inOneTransaction } from '../save_access';

jest.mock('../../../credentials/credential_lifecycle', () => ({ credentialLifecycle: () => undefined }));
jest.mock('../../../../lib/slack', () => ({ sendSlackNotification: async () => undefined }));

const RUN_NOW = `function go(t: <manual-[:Invocation]->>) {
  # nothing yet
}

listen to manual-[:Invocations]-> fire go
`;

describe('the save rule (real Postgres)', () => {
  let teamId: TeamId;
  let alice: UserId;

  const asAlice = () => userPrincipal({ userId: alice, teamId, access: 'write' });
  const movements = () => getAutomationsQb(['movement']).selectFrom('movement').selectAll().where('team_id', '=', teamId).execute();

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `save-access-${teamId.slice(0, 8)}` }).execute();
    alice = (await ProvisioningService.provisionUser({ teamId, email: `save-access-${randomUUID().slice(0, 8)}@example.com`, access: 'write' })).userId;
  });

  afterEach(async () => {
    await getAutomationsQb(['access_statement']).deleteFrom('access_statement').where('team_id', '=', teamId).execute();
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
    await getAutomationsQb(['movement_version']).deleteFrom('movement_version').where('team_id', '=', teamId).execute();
    await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId).execute();
    await cleanupTeam(teamId);
  });

  it('creates an automation with its statements, and its creator', async () => {
    const principal = asAlice();
    const saved = await runWithPrincipal(principal, () =>
      saveMovement({
        teamId,
        source: RUN_NOW,
        audience: { for: principal },
        userId: alice,
        statements: { read: [{ kind: 'team' }], write: [{ kind: 'user', userId: alice }], fire: [{ kind: 'anyone' }] },
      }),
    );
    expect(saved).toMatchObject({ ok: true });
    if (saved.movementId === undefined) throw new Error('nothing saved');
    const target = { thing: 'automation', id: saved.movementId } as const;
    expect(await StatementStore.grantsOf(target, { teamId, verb: 'write' })).toEqual([{ kind: 'user', userId: alice }]);
    expect(await StatementStore.grantsOf(target, { teamId, verb: 'read' })).toEqual([{ kind: 'team' }]);
    expect(await StatementStore.grantsOf(target, { teamId, verb: 'fire' })).toEqual([{ kind: 'anyone' }]);
    expect(await accessTo(principal, { target, verb: 'write' })).toBe(true);
    expect((await movements())[0]).toMatchObject({ created_by_user_id: alice });
  });

  it('stores nothing for a creation without its statements', async () => {
    const principal = asAlice();
    const refused = await runWithPrincipal(principal, () => saveMovement({ teamId, source: RUN_NOW, audience: { for: principal } }));
    expect(refused).toMatchObject({ ok: false, refused: { kind: 'missing_statement' } });
    expect(await movements()).toEqual([]);
  });

  it('rolls back what its own transaction wrote when the work inside it fails', async () => {
    const id = randomUUID() as MovementId;
    await expect(
      runWithPrincipal(asAlice(), () =>
        inOneTransaction(async () => {
          await getAutomationsQb(['movement']).insertInto('movement').values({ id, team_id: teamId, name: 'Doomed', source: '' }).execute();
          throw new Error('a statement could not be stored');
        }),
      ),
    ).rejects.toThrow();
    expect(await movements()).toEqual([]);
  });
});
