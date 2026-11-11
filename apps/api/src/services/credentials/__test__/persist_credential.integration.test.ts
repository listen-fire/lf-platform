// Real-DB gate for the (team_id, name) unique constraint on
// external_service_credentials and the service-level guard in persistCredential.
//
// The constraint is the primary enforcement surface; the service guard
// translates a raw unique-violation DB error into a typed
// CredentialNameTakenError so callers get a clean signal instead of a
// Postgres error object.
//
// Uses the integration test DB (DATABASE_URL_TEST) with the migration applied
// via globalSetup. Heavy lifecycle deps (Attio API calls, token registration)
// are irrelevant to this gate and are isolated via a jest.mock.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

// credentialLifecycle imports Attio API clients and token registries that
// require a live adapter stack. They are not the subject of this test.
jest.mock('../credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

import { persistCredential, CredentialNameTakenError } from '../persist_credential';
import { deleteCredential } from '../delete_credential';
import { StatementStore } from '../../access/statement';
import { ProvisioningService } from '../../provisioning';
import { cleanupTeam } from '../../../test/harness/cleanup';

let teamId: TeamId;

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `persist-cred-test-${teamId.slice(0, 8)}` } as any)
    .execute();
});

afterAll(async () => {
  await getAutomationsQb(['external_service_credentials'])
    .deleteFrom('external_service_credentials')
    .where('team_id', '=', teamId)
    .execute();
  await cleanupTeam(teamId);
});

afterEach(async () => {
  await getAutomationsQb(['access_statement']).deleteFrom('access_statement').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['external_service_credentials'])
    .deleteFrom('external_service_credentials')
    .where('team_id', '=', teamId)
    .execute();
});

const baseInput = () => ({
  teamId,
  // user_id is nullable on the table; cast null past the non-optional TypeScript param
  userId: null as unknown as import('../../../generated/kysely/core/User').UserId,
  type: ExternalServiceType.GOOGLE,
  credentials: { access_token: 'test-token' },
  use: [{ kind: 'team' as const }],
});

describe('persistCredential', () => {
  it('inserts a new credential and returns its uuid', async () => {
    const id = await persistCredential({ ...baseInput(), name: 'My Google Creds' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('throws CredentialNameTakenError on a second insert with the same (teamId, name)', async () => {
    await persistCredential({ ...baseInput(), name: 'Duplicate' });

    await expect(
      persistCredential({ ...baseInput(), name: 'Duplicate' }),
    ).rejects.toThrow(CredentialNameTakenError);
  });

  it('CredentialNameTakenError message names the conflicting credential', async () => {
    await persistCredential({ ...baseInput(), name: 'Named Cred' });

    await expect(
      persistCredential({ ...baseInput(), name: 'Named Cred' }),
    ).rejects.toThrow(/Named Cred/);
  });

  it('replaceExisting: true upserts without error', async () => {
    await persistCredential({ ...baseInput(), name: 'Replace Me' });

    await expect(
      persistCredential({ ...baseInput(), name: 'Replace Me', replaceExisting: true }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  // A new key for a connection is not a choice of who may use it.
  it('reconnecting keeps the use list of the connection it replaces, and leaves no statement on the old one', async () => {
    const { userId } = await ProvisioningService.provisionUser({ teamId, email: `persist-${randomUUID().slice(0, 8)}@example.com`, access: 'write' });
    const only = [{ kind: 'user' as const, userId }];
    const first = await persistCredential({ ...baseInput(), name: 'Shared', use: only });
    const second = await persistCredential({ ...baseInput(), name: 'Shared', replaceExisting: true, use: [{ kind: 'team' }] });

    expect(await StatementStore.grantsOf({ thing: 'connection', id: second }, { teamId, verb: 'use' })).toEqual(only);
    expect(await StatementStore.hasAnyStatement({ thing: 'connection', id: first })).toBe(false);
  });

  it('reconnecting with nothing to replace states the use list it was given', async () => {
    const id = await persistCredential({ ...baseInput(), name: 'Fresh', replaceExisting: true });
    expect(await StatementStore.grantsOf({ thing: 'connection', id }, { teamId, verb: 'use' })).toEqual([{ kind: 'team' }]);
  });

  it('deleting a connection deletes what is stated about it', async () => {
    const id = await persistCredential({ ...baseInput(), name: 'Going' });
    await deleteCredential({ teamId, id: id as ExternalServiceCredentialsId });
    expect(await StatementStore.hasAnyStatement({ thing: 'connection', id })).toBe(false);
  });

  it('different names on the same team do not conflict', async () => {
    await persistCredential({ ...baseInput(), name: 'Cred A' });
    await expect(
      persistCredential({ ...baseInput(), name: 'Cred B' }),
    ).resolves.toBeTruthy();
  });
});
