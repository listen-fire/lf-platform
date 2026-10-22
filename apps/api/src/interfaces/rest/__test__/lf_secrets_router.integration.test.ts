// The secrets module's door, `/api/public/lf-secrets`, against the test
// database: who may call it (an api key carrying `secrets`), which team a
// call acts in (the `team` setting, which a pinned key cannot escape), and
// the protocol's envelope, refusals and errors as lf's client reads them.

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import express from 'express';
import { z } from 'zod';
import { SlotClient, SlotRefused, type SlotAddress } from 'movement-engine/public/module-wire';
import { SecretsListed, WireSlotManifest } from 'engine-contracts/slots';
import { logger } from 'movement-engine/public/log';

import type { AddressInfo } from 'node:net';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { encryptToken } from '../../../lib/credentials';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { ApiKeyService } from '../../../services/api_key';
import { createLfSecretsRouter } from '../lfSecrets';

let server: Server;
let baseUrl: string;
let teamA: TeamId;
let teamB: TeamId;
let userId: UserId;
const keys: string[] = [];

async function createTeam(): Promise<TeamId> {
  const id = randomUUID() as TeamId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await getCoreQb(['team']).insertInto('team').values({ id, name: `lf-secrets-door-${id.slice(0, 8)}` } as any).execute();
  return id;
}

async function mintKey(scopes: string[], teamId: TeamId | null): Promise<string> {
  const { id, key } = await ApiKeyService.createForOwner({ name: 'lf-secrets-door-test', scopes, teamId, createdBy: userId });
  keys.push(id);
  return key;
}

beforeAll(async () => {
  teamA = await createTeam();
  teamB = await createTeam();
  userId = randomUUID() as UserId;
  await getCoreQb(['user'])
    .insertInto('user')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: userId, default_team_id: teamA, username: `lf-door-${userId.slice(0, 8)}`, granted_access_at: new Date() } as any)
    .execute();
  await getCoreQb(['team_membership'])
    .insertInto('team_membership')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ user_id: userId, team_id: teamA, access: 'write' } as any)
    .execute();

  const app = express();
  app.use('/api/public/lf-secrets', createLfSecretsRouter());
  server = createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/public/lf-secrets`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  for (const id of keys) await getCoreQb(['api_key']).deleteFrom('api_key').where('id', '=', id as never).execute();
  await cleanupTeam(teamA);
  await cleanupTeam(teamB);
});

afterEach(() => jest.restoreAllMocks());

const client = (token: string | undefined, settings: Record<string, string> = { team: teamA }) => {
  const address: SlotAddress = token === undefined ? { baseUrl } : { baseUrl, token };
  return new SlotClient(address, settings);
};

async function refusedCode(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof SlotRefused) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, got an answer');
}

const post = (token: string | undefined, body: string) =>
  fetch(baseUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, body });

describe('who may call the door', () => {
  it('answers 401 without a key, and with a key that is not one', async () => {
    const envelope = JSON.stringify({ protocolVersion: '2', method: 'manifest', params: {} });
    expect((await post(undefined, envelope)).status).toBe(401);
    expect((await post('lf_not-a-key', envelope)).status).toBe(401);
    expect(await (await post(undefined, envelope)).json()).toEqual({ error: 'unauthorized' });
  });

  it('answers 403 to a key without the secrets scope', async () => {
    const key = await mintKey(['automation'], teamA);
    const answer = await post(key, JSON.stringify({ protocolVersion: '2', method: 'secrets.list', params: {}, settings: { team: teamA } }));
    expect(answer.status).toBe(403);
  });
});

describe('team setting must match the key', () => {
  it('a key pinned to one team is refused another team, and a call naming no team', async () => {
    const key = await mintKey(['secrets'], teamA);
    expect(Array.isArray(await client(key, { team: teamA }).call('secrets.list', {}))).toBe(true);
    expect(await refusedCode(client(key, { team: teamB }).call('secrets.list', {}))).toBe('settings');
    expect(await refusedCode(client(key, {}).call('secrets.list', {}))).toBe('settings');
  });

  it('a key that spans its user\'s teams acts only in one the user belongs to', async () => {
    const key = await mintKey(['secrets'], null);
    expect(Array.isArray(await client(key, { team: teamA }).call('secrets.list', {}))).toBe(true);
    expect(await refusedCode(client(key, { team: teamB }).call('secrets.list', {}))).toBe('settings');
  });

  it('acts in the team it names: an entry created there is listed there only', async () => {
    const key = await mintKey(['secrets'], teamA);
    const ref = `door-${randomUUID().slice(0, 8)}`;
    await client(key).call('secrets.create', { ref, external: 'acme_crm', binding: 'legacy', fields: { api_key: 'k1' } });
    const listed = z.array(SecretsListed).parse(await client(key).call('secrets.list', {}));
    expect(listed.find((entry) => entry.ref === ref)).toMatchObject({ external: 'acme_crm', binding: 'legacy' });
    const inB = await getAutomationsQb(['external_service_credentials']).selectFrom('external_service_credentials').where('team_id', '=', teamB).where('name', '=', ref).select('id').executeTakeFirst();
    expect(inB).toBeUndefined();
  });
});

describe('the envelope', () => {
  it('answers manifest, refuses an unknown method, another protocol version and a body that is not JSON', async () => {
    const key = await mintKey(['secrets'], teamA);
    const manifest = WireSlotManifest.parse(await client(key).call('manifest', {}));
    expect(manifest).toMatchObject({ protocolVersion: 2, name: 'lf_platform_secrets', kind: 'core', slot: 'secrets' });
    expect(manifest.methods).toContain('secrets.writeBack');
    expect(await refusedCode(client(key).call('secrets.noSuchMethod', {}))).toBe('method_not_implemented');
    const other = await post(key, JSON.stringify({ protocolVersion: '1', method: 'manifest', params: {} }));
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ ok: false, error: { code: 'protocol_version' } });
    expect((await post(key, '{not json')).status).toBe(400);
  });

  it('turns a failure into a fixed module_error, and logs only the method, the ref and the code', async () => {
    const key = await mintKey(['secrets'], teamA);
    const ref = `broken-${randomUUID().slice(0, 8)}`;
    const id = randomUUID();
    const canary = `canary-${randomUUID()}`;
    // A row whose ciphertext was written for another id: decrypting it fails.
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({ id: id as ExternalServiceCredentialsId, name: ref, team_id: teamA, type: ExternalServiceType.REMOTE, app_id: 'acme_crm', credentials: await encryptToken(JSON.stringify({ api_key: canary }), randomUUID()) })
      .execute();
    const logged: unknown[][] = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }

    const answer = await post(key, JSON.stringify({ protocolVersion: '2', method: 'secrets.resolve', params: { ref }, settings: { team: teamA } }));
    expect(await answer.json()).toEqual({ ok: false, error: { code: 'module_error', message: `the platform could not resolve "${ref}"`, retryable: true } });
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(canary);
    expect(JSON.stringify(logged)).toContain(ref);
  });
});
