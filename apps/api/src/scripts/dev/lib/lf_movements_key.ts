// The dev loop's key for a cloud lf's movements and store slots
// (`pnpm dev:lf-movements-verify`, ../lf_movements_verify.ts): a key with the
// `system` scope, pinned to the dev-loop team. It is named apart from
// `dev-loop-scheduler`, which the API's tick notifier read at boot and which
// must not be rotated.

import { getCoreQb } from '../../../lib/kysely';
import { ApiKeyService } from '../../../services/api_key';

export const LF_MOVEMENTS_KEY_NAME = 'dev-loop-lf-movements';

/** Revoke this owner's live lf-movements key and mint its replacement. A key's
 *  plaintext exists only at mint, so "the" key is whichever was minted last.
 *  Only this team's and this user's keys are touched. */
export async function rotateLfMovementsKey(owner: { teamId: string; userId: string }): Promise<string> {
  const live = await getCoreQb(['api_key'])
    .selectFrom('api_key')
    .where('name', '=', LF_MOVEMENTS_KEY_NAME)
    .where('team_id', '=', owner.teamId as never)
    .where('created_by', '=', owner.userId as never)
    .where('revoked_at', 'is', null)
    .select(['id'])
    .execute();
  for (const { id } of live) await ApiKeyService.revokeById(id);
  const { key } = await ApiKeyService.createForOwner({
    name: LF_MOVEMENTS_KEY_NAME,
    scopes: ['system'],
    teamId: owner.teamId,
    createdBy: owner.userId,
  });
  return key;
}
