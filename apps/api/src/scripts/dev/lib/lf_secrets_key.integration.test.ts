// The dev loop's lf-secrets key: one live key, carrying `secrets` alone,
// pinned to its owner's team (real DB).

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';

import { getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { ApiKeyService } from '../../../services/api_key';
import { LF_SECRETS_KEY_NAME, rotateLfSecretsKey } from './lf_secrets_key';

describe('rotateLfSecretsKey (real DB)', () => {
  let teamId: TeamId;
  let userId: UserId;

  beforeAll(async () => {
    teamId = randomUUID() as TeamId;
    userId = randomUUID() as UserId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `lfk-${teamId.slice(0, 8)}` } as any).execute();
    await getCoreQb(['user'])
      .insertInto('user')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: userId, default_team_id: teamId, username: `lfk-${userId.slice(0, 8)}` } as any)
      .execute();
  });

  afterAll(async () => {
    await getCoreQb(['api_key']).deleteFrom('api_key').where('team_id', '=', teamId).execute();
    await cleanupTeam(teamId);
  });

  it('leaves exactly one live key, pinned to the team, carrying only `secrets`', async () => {
    const first = await rotateLfSecretsKey({ teamId, userId });
    const second = await rotateLfSecretsKey({ teamId, userId });
    expect(second).not.toBe(first);
    const live = await getCoreQb(['api_key'])
      .selectFrom('api_key')
      .where('team_id', '=', teamId)
      .where('name', '=', LF_SECRETS_KEY_NAME)
      .where('revoked_at', 'is', null)
      .select(['scopes', 'team_id'])
      .execute();
    expect(live).toEqual([{ scopes: ['secrets'], team_id: teamId }]);
    expect((await ApiKeyService.validateKey(first)).valid).toBe(false);
    expect((await ApiKeyService.validateKey(second)).valid).toBe(true);
  });
});
