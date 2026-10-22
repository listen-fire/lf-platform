// The secrets module's lease on a credential: what lf holds across the two
// requests a refresh spans (`secrets.lock`, then `secrets.unlock`), so two lf
// processes refreshing one credential make one token call and spend a
// rotating refresh token once. A compare-and-swap alone would let both spend
// it; the platform's own advisory lock is transaction-scoped and cannot last
// between two HTTP requests.
//
// The lease table's columns are written as SQL: its generated row type brands
// `team_id` and `ref` as the table's own keys, which a team id is not.
//
// The platform's refresh and lf's lease exclude each other: `lock` refuses
// while a platform refresh holds the row's advisory lock, and the platform's
// `exclusive` (secrets_postgres.ts) waits out a live lease before it refreshes.

import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type { TeamId } from '../../generated/kysely/core/Team';
import type AutomationsSchema from '../../generated/kysely/automations/AutomationsSchema';
import { getAutomationsQb } from '../../lib/kysely';
import { credentialLockKey } from '../credentials/secrets_postgres';

type LeaseDb = Kysely<Pick<AutomationsSchema, 'external_service_credentials'>>;

const leaseDb = (): LeaseDb => getAutomationsQb(['external_service_credentials']);

/** Take `ref`'s lease for `ttlMs`, or null while another holds it or the
 *  platform is refreshing the credential. */
export async function lockLease({ teamId, ref, ttlMs }: { teamId: TeamId; ref: string; ttlMs: number }): Promise<{ token: string } | null> {
  const outer = leaseDb();
  const run = async (trx: LeaseDb): Promise<{ token: string } | null> => {
    const row = await trx
      .selectFrom('external_service_credentials')
      .where('team_id', '=', teamId)
      .where('name', '=', ref)
      .select('id')
      .executeTakeFirst();
    if (row !== undefined) {
      const { rows } = await sql<{ free: boolean }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${credentialLockKey(row.id)}, 0)) AS free`.execute(trx);
      if (rows[0]?.free !== true) return null;
    }
    const token = randomUUID();
    const { rows } = await sql<{ token: string }>`
      INSERT INTO automations.lf_secrets_lease (team_id, ref, token, expires_at)
      VALUES (${teamId}, ${ref}, ${token}, clock_timestamp() + ${ttlMs}::double precision * interval '1 millisecond')
      ON CONFLICT (team_id, ref) DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
      WHERE lf_secrets_lease.expires_at <= clock_timestamp()
      RETURNING token
    `.execute(trx);
    await sql`DELETE FROM automations.lf_secrets_lease WHERE team_id = ${teamId} AND expires_at < clock_timestamp() - interval '1 hour'`.execute(trx);
    return rows[0] === undefined ? null : { token: rows[0].token };
  };
  // Inside an open transaction the advisory lock is held until that one ends.
  return outer.isTransaction ? run(outer) : outer.transaction().execute(run);
}

/** Release `ref`'s lease if `token` is the one holding it. */
export async function unlockLease({ teamId, ref, token }: { teamId: TeamId; ref: string; token: string }): Promise<null> {
  await sql`DELETE FROM automations.lf_secrets_lease WHERE team_id = ${teamId} AND ref = ${ref} AND token = ${token}`.execute(leaseDb());
  return null;
}
