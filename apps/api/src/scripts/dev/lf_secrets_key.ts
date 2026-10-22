/**
 * The dev loop's key for lf's secrets door (`/api/public/lf-secrets`): what a
 * cloud lf pointed at the agent stack sends as its `token` setting.
 *
 *   pnpm dev:lf-secrets-key    # prints the key's plaintext on the last line
 *
 * A key's plaintext exists only at mint, so each call revokes the dev-loop
 * team's live `dev-loop-lf-secrets` key and mints its replacement, leaving
 * exactly one, pinned to that team. Its owner is the dev-loop team,
 * provisioned as `dev:seed` does.
 */
import './_profile_loader';
import { ensureDevLoopTeam } from './_lib';
import { rotateLfSecretsKey } from './lib/lf_secrets_key';

async function main(): Promise<void> {
  const seed = await ensureDevLoopTeam();
  console.log(await rotateLfSecretsKey({ teamId: seed.teamId, userId: seed.userId }));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
