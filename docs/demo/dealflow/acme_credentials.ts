// The site's dealflow program connects `using acme_mail`, `acme_main` and
// `acme_slack`, so the recording connects the same names: each is a copy of
// the dev loop's seeded credential (the same fake account, re-encrypted under
// its own id). Re-running replaces the copies, so they follow a fresh seed.
// Run from apps/api (see capture.sh) so its tsconfig paths and .env apply.
import '../../../apps/api/src/scripts/dev/_profile_loader';
import { randomUUID } from 'node:crypto';
import { getAutomationsQb } from '../../../apps/api/src/lib/kysely';
import { encryptToken, decryptToken } from '../../../apps/api/src/lib/credentials';
import type { ExternalServiceCredentialsId } from '../../../apps/api/src/generated/kysely/automations/ExternalServiceCredentials';

const COPIES = [
  { from: 'Dev Loop Gmail', to: 'acme_mail' },
  { from: 'Dev Loop Attio', to: 'acme_main' },
  { from: 'Dev Loop Slack', to: 'acme_slack' },
] as const;

(async () => {
  const teamId = process.env.TEST_HARNESS_TEAM_ID;
  if (!teamId) throw new Error('TEST_HARNESS_TEAM_ID is unset; run `pnpm dev:seed` first');
  const qb = getAutomationsQb(['external_service_credentials']);
  for (const { from, to } of COPIES) {
    const source = await qb
      .selectFrom('external_service_credentials')
      .selectAll()
      .where('team_id', '=', teamId)
      .where('name', '=', from)
      .executeTakeFirst();
    if (!source?.credentials) throw new Error(`the dev loop team has no credential named '${from}'; run \`pnpm dev:seed\``);
    await qb.deleteFrom('external_service_credentials').where('team_id', '=', teamId).where('name', '=', to).execute();
    const id = randomUUID() as ExternalServiceCredentialsId;
    const secret = await decryptToken(source.credentials, source.id);
    const { created_at: _created, updated_at: _updated, ...rest } = source;
    await qb
      .insertInto('external_service_credentials')
      .values({ ...rest, id, name: to, credentials: await encryptToken(secret, id) })
      .execute();
    process.stdout.write(`${to}: a copy of ${from}\n`);
  }
  process.exit(0);
})();
