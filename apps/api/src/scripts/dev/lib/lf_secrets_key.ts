// The dev loop's key for lf's secrets door (`pnpm dev:lf-secrets-key`,
// ../lf_secrets_key.ts): a key with the `secrets` scope, pinned to the
// dev-loop team, for a cloud lf the dev loop points at the platform.

import { getCoreQb } from '../../../lib/kysely';
import { ApiKeyService } from '../../../services/api_key';

export const LF_SECRETS_KEY_NAME = 'dev-loop-lf-secrets';

/** Revoke this owner's live lf-secrets key and mint its replacement. A key's
 *  plaintext exists only at mint, so "the" key is whichever was minted last.
 *  Only this team's and this user's keys are touched. */
export async function rotateLfSecretsKey(owner: { teamId: string; userId: string }): Promise<string> {
  const live = await getCoreQb(['api_key'])
    .selectFrom('api_key')
    .where('name', '=', LF_SECRETS_KEY_NAME)
    .where('team_id', '=', owner.teamId as never)
    .where('created_by', '=', owner.userId as never)
    .where('revoked_at', 'is', null)
    .select(['id'])
    .execute();
  for (const { id } of live) await ApiKeyService.revokeById(id);
  const { key } = await ApiKeyService.createForOwner({
    name: LF_SECRETS_KEY_NAME,
    scopes: ['secrets'],
    teamId: owner.teamId,
    createdBy: owner.userId,
  });
  return key;
}
