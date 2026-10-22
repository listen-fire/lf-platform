// The secrets module's door held to the slot's conformance cases (the common
// ones, including the 401 without the token, and the secrets slot's own) and
// to the family's eleven contract cases through lf's slot client: the same
// lists lf runs against its own modules. The platform changes its entries, so
// the read-only cases are skipped, as the contract allows.

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import express from 'express';
import { SECRETS_METHODS } from 'engine-contracts/slots';
import { SecretsSlotBackend, SlotClient, commonSlotCases, secretsReadOnlySlotCases, secretsSlotCases, type SlotAddress } from 'movement-engine/public/module-wire';
import { secretsContractCases, type SecretsContractBackend } from 'movement-engine/public/secrets-testing';

import type { AddressInfo } from 'node:net';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import { getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { ApiKeyService } from '../../../services/api_key';
import { createLfSecretsRouter } from '../lfSecrets';

let server: Server;
let address: SlotAddress;
let team: TeamId;
let userId: UserId;
let keyId: string;

beforeAll(async () => {
  team = randomUUID() as TeamId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await getCoreQb(['team']).insertInto('team').values({ id: team, name: `lf-secrets-conf-${team.slice(0, 8)}` } as any).execute();
  userId = randomUUID() as UserId;
  await getCoreQb(['user'])
    .insertInto('user')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: userId, default_team_id: team, username: `lf-conf-${userId.slice(0, 8)}`, granted_access_at: new Date() } as any)
    .execute();
  await getCoreQb(['team_membership'])
    .insertInto('team_membership')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ user_id: userId, team_id: team, access: 'write' } as any)
    .execute();
  const minted = await ApiKeyService.createForOwner({ name: 'lf-secrets-conformance', scopes: ['secrets'], teamId: team, createdBy: userId });
  keyId = minted.id;

  const app = express();
  app.use('/api/public/lf-secrets', createLfSecretsRouter());
  server = createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  address = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/public/lf-secrets`, token: minted.key };
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await getCoreQb(['api_key']).deleteFrom('api_key').where('id', '=', keyId as never).execute();
  await cleanupTeam(team);
});

const settings = () => ({ team });
const client = () => new SlotClient(address, settings());

describe('the common slot cases', () => {
  for (const conformance of commonSlotCases('secrets', SECRETS_METHODS)) {
    it(conformance.name, () => conformance.run(client()));
  }
});

describe('the secrets slot cases', () => {
  for (const conformance of secretsSlotCases) {
    it(conformance.name, () => conformance.run(client()));
  }
});

describe('the read-only secrets slot cases', () => {
  // The platform changes its entries; the contract lets such a module skip these.
  for (const conformance of secretsReadOnlySlotCases) {
    it.skip(`${conformance.name} (the platform writes its entries)`, () => conformance.run(client()));
  }
});

describe('the family\'s contract cases, through lf\'s slot client', () => {
  for (const contractCase of secretsContractCases) {
    it(contractCase.name, async () => {
      const handle = () => new SecretsSlotBackend(address, settings());
      const backend: SecretsContractBackend = {
        backend: handle(),
        sibling: handle,
        seed: async (fields) => {
          const ref = `c${randomUUID().replaceAll('-', '').slice(0, 12)}`;
          await handle().seed(ref, 'acme_crm', fields);
          return ref;
        },
        missingRef: () => `missing_${randomUUID().replaceAll('-', '').slice(0, 8)}`,
      };
      await contractCase.run(backend);
    });
  }
});
