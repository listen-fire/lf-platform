// The platform's secrets module over the encrypted credential rows, against
// the test database: what lf sees through it, and what the platform's own
// flows (a re-connect, a delete in the UI, a refresh) do beside it.

import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import { SecretsLockAnswer, SecretsListed, SecretsRecord, SecretsWriteBackAnswer } from 'engine-contracts/slots';
import { SlotRefusal } from 'movement-engine/public/module-wire';
import { AttioAPIClient } from '@listen-fire/attio/api_client';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import * as cipher from '../../../lib/credentials';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { persistCredential } from '../../credentials/persist_credential';
import { mintRemoteCredential } from '../../credentials/remote_credential';
import { deleteCredential } from '../../credentials/delete_credential';
import { postgresSecrets, renamedPayloadShape } from '../../credentials/secrets_postgres';
import { platformSecretsModule } from '../module';

let teamA: TeamId;
let teamB: TeamId;

async function createTeam(): Promise<TeamId> {
  const id = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id, name: `lf-secrets-${id.slice(0, 8)}` } as any)
    .execute();
  return id;
}

beforeAll(async () => {
  teamA = await createTeam();
  teamB = await createTeam();
});

afterAll(async () => {
  await cleanupTeam(teamA);
  await cleanupTeam(teamB);
});

afterEach(() => jest.restoreAllMocks());

const lf = (teamId: TeamId) => {
  const module = platformSecretsModule({ teamId, userId: null });
  return {
    resolve: async (ref: string) => SecretsRecord.nullable().parse(await module['secrets.resolve']({ ref })),
    writeBack: async (ref: string, fields: Record<string, string>, expectedVersion: string) =>
      SecretsWriteBackAnswer.parse(await module['secrets.writeBack']({ ref, fields, expectedVersion })),
    list: async () => z.array(SecretsListed).parse(await module['secrets.list']({})),
    lock: async (ref: string, ttlMs = 30_000) => SecretsLockAnswer.parse(await module['secrets.lock']({ ref, ttlMs })),
    unlock: (ref: string, token: string) => module['secrets.unlock']({ ref, token }),
    create: (entry: { ref: string; external: string; binding: unknown; fields: Record<string, string> }) => module['secrets.create'](entry),
    replace: (entry: { ref: string; external: string; binding: unknown; fields: Record<string, string> }) => module['secrets.replace'](entry),
    delete: (ref: string) => module['secrets.delete']({ ref }),
    raw: module,
  };
};

const freshRef = () => `cred-${randomUUID().slice(0, 8)}`;

async function rowNamed(teamId: TeamId, name: string) {
  return getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId)
    .where('name', '=', name)
    .selectAll()
    .executeTakeFirst();
}

async function storedPayload(id: string): Promise<unknown> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', id as ExternalServiceCredentialsId)
    .select(['id', 'credentials'])
    .executeTakeFirstOrThrow();
  return JSON.parse(await cipher.decryptToken(row.credentials, row.id));
}

async function refusal(answer: Promise<unknown>): Promise<string> {
  try {
    await answer;
  } catch (error) {
    if (error instanceof SlotRefusal) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, got an answer');
}

const oauthEntry = (ref: string, accessToken: string) => ({
  ref,
  external: 'acme_crm',
  binding: { credential: 'oauth' },
  fields: { access_token: accessToken, refresh_token: 'r1', expires_at: '2026-10-22T12:00:00.000Z' },
});

describe('list', () => {
  it('names each served row with the version resolve answers, and never decrypts', async () => {
    const ref = freshRef();
    await lf(teamA).create(oauthEntry(ref, 'a1'));
    const decrypt = jest.spyOn(cipher, 'decryptToken');
    const listed = (await lf(teamA).list()).find((entry) => entry.ref === ref);
    expect(decrypt).not.toHaveBeenCalled();
    decrypt.mockRestore();
    expect(listed).toEqual({ ref, external: 'acme_crm', binding: { credential: 'oauth' }, version: (await lf(teamA).resolve(ref))?.version });
  });

  it('leaves out shells and rows lf cannot read', async () => {
    const shell = freshRef();
    const native = freshRef();
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values([
        { id: randomUUID() as ExternalServiceCredentialsId, name: shell, team_id: teamA, type: ExternalServiceType.DROPBOX, credentials: null, reconnect_required_at: new Date() },
        { id: randomUUID() as ExternalServiceCredentialsId, name: native, team_id: teamA, type: ExternalServiceType.NATIVE_VALUATIONS, credentials: Buffer.from('x') },
      ])
      .execute();
    const refs = (await lf(teamA).list()).map((entry) => entry.ref);
    expect(refs).not.toContain(shell);
    expect(refs).not.toContain(native);
    expect(await lf(teamA).resolve(shell)).toBeNull();
    expect(await lf(teamA).resolve(native)).toBeNull();
  });
});

describe('reconnect under an lf lease', () => {
  it('the platform re-connects unblocked; lf\'s write-back answers conflict with the reconnected record, and the reconnected tokens survive', async () => {
    const ref = freshRef();
    await lf(teamA).create(oauthEntry(ref, 'stale'));
    const lease = await lf(teamA).lock(ref);
    expect(lease).not.toBeNull();
    const read = await lf(teamA).resolve(ref);

    const started = Date.now();
    await persistCredential({
      teamId: teamA,
      userId: null,
      name: ref,
      type: ExternalServiceType.REMOTE,
      appId: 'acme_crm',
      declaredCredential: 'oauth',
      credentials: { access_token: 'reconnected', refresh_token: 'r2', expires_at: '2026-10-23T12:00:00.000Z' },
      replaceExisting: true,
    });
    expect(Date.now() - started).toBeLessThan(2_000);

    const answer = await lf(teamA).writeBack(ref, { access_token: 'lf-refreshed' }, read!.version);
    expect(answer.kind).toBe('conflict');
    expect(answer.kind === 'conflict' ? answer.current.fields.access_token : undefined).toBe('reconnected');
    expect((await lf(teamA).resolve(ref))?.fields.access_token).toBe('reconnected');
    await lf(teamA).unlock(ref, lease!.token);
  });
});

describe('tenant isolation', () => {
  it('a team never lists, resolves, writes back, locks or deletes another team\'s rows', async () => {
    const shared = freshRef();
    const onlyA = freshRef();
    await lf(teamA).create(oauthEntry(shared, 'team-a'));
    await lf(teamB).create(oauthEntry(shared, 'team-b'));
    await lf(teamA).create(oauthEntry(onlyA, 'only-a'));

    expect((await lf(teamA).resolve(shared))?.fields.access_token).toBe('team-a');
    expect((await lf(teamB).resolve(shared))?.fields.access_token).toBe('team-b');
    expect((await lf(teamB).list()).map((entry) => entry.ref)).not.toContain(onlyA);
    expect(await lf(teamB).resolve(onlyA)).toBeNull();

    const versionA = (await lf(teamA).resolve(onlyA))!.version;
    expect(await lf(teamB).writeBack(onlyA, { access_token: 'stolen' }, versionA)).toEqual({ kind: 'missing' });
    expect(await refusal(lf(teamB).delete(onlyA))).toBe('missing');

    const leaseA = await lf(teamA).lock(shared);
    const leaseB = await lf(teamB).lock(shared);
    expect(leaseA).not.toBeNull();
    expect(leaseB).not.toBeNull();
    await lf(teamB).unlock(shared, leaseA!.token);
    expect(await lf(teamA).lock(shared)).toBeNull();
    await lf(teamA).unlock(shared, leaseA!.token);
    await lf(teamB).unlock(shared, leaseB!.token);

    await lf(teamB).replace(oauthEntry(onlyA, 'b-own'));
    expect((await lf(teamA).resolve(onlyA))?.fields.access_token).toBe('only-a');
    expect((await lf(teamB).resolve(onlyA))?.fields.access_token).toBe('b-own');

    await lf(teamB).delete(shared);
    expect((await lf(teamA).resolve(shared))?.fields.access_token).toBe('team-a');
  });
});

describe('deleted in the UI mid-run', () => {
  it('write-back answers missing, list omits it, and nothing re-creates the row', async () => {
    const ref = freshRef();
    await lf(teamA).create(oauthEntry(ref, 'a1'));
    const read = await lf(teamA).resolve(ref);
    const row = await rowNamed(teamA, ref);
    await deleteCredential({ teamId: teamA, id: row!.id });

    expect(await lf(teamA).writeBack(ref, { access_token: 'a2' }, read!.version)).toEqual({ kind: 'missing' });
    expect((await lf(teamA).list()).map((entry) => entry.ref)).not.toContain(ref);
    expect(await lf(teamA).resolve(ref)).toBeNull();
    expect(await rowNamed(teamA, ref)).toBeUndefined();
  });
});

describe('replace', () => {
  it('keeps the row id and a webhook subscription pointing at it', async () => {
    const ref = freshRef();
    await lf(teamA).create(oauthEntry(ref, 'a1'));
    const before = await rowNamed(teamA, ref);
    const subscription = randomUUID();
    await getAutomationsQb(['webhook_subscription'])
      .insertInto('webhook_subscription')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: subscription, team_id: teamA, provider: 'acme_crm', credentials_id: before!.id, webhook_secret: 'whsec' } as any)
      .execute();

    expect(await lf(teamA).replace({ ...oauthEntry(ref, 'a2'), binding: 'install' })).toBeNull();

    const after = await rowNamed(teamA, ref);
    expect(after?.id).toBe(before!.id);
    expect(after?.wire_binding).toBe('install');
    const kept = await getAutomationsQb(['webhook_subscription']).selectFrom('webhook_subscription').where('id', '=', subscription as never).select(['credentials_id']).executeTakeFirst();
    expect(kept?.credentials_id).toBe(before!.id);
    expect((await lf(teamA).resolve(ref))?.fields.access_token).toBe('a2');
    expect((await lf(teamA).list()).find((entry) => entry.ref === ref)?.binding).toBe('install');
  });

  it('is the whole entry, but keeps what the platform stores beside the fields', async () => {
    const ref = freshRef();
    const { credentialsId } = await mintRemoteCredential({
      teamId: teamA,
      adapterType: 'acme_crm',
      displayName: ref,
      secret: 's1',
      oauthClients: { oauth: { clientId: 'c1', clientSecret: 'cs1' } },
    });
    await lf(teamA).replace({ ref, external: 'acme_crm', binding: 'install', fields: { secret: 's2', workspace: 'w2' } });
    expect(await storedPayload(credentialsId)).toEqual({ secret: 's2', workspace: 'w2', oauthClients: { oauth: { clientId: 'c1', clientSecret: 'cs1' } } });
    expect((await lf(teamA).resolve(ref))?.fields).toEqual({ secret: 's2', workspace: 'w2' });
  });

  it('refuses to change a row\'s type', async () => {
    const ref = freshRef();
    await lf(teamA).create({ ref, external: 'dropbox', binding: { credential: 'dropbox' }, fields: { access_token: 'a1' } });
    expect(await refusal(lf(teamA).replace(oauthEntry(ref, 'a2')))).toBe('type_change');
  });

  it('of a missing entry creates it', async () => {
    const ref = freshRef();
    expect(await lf(teamA).replace(oauthEntry(ref, 'a1'))).toBeNull();
    expect((await lf(teamA).resolve(ref))?.fields.access_token).toBe('a1');
  });
});

describe('create', () => {
  it('an lf-created Attio row reads back through the platform\'s own store', async () => {
    jest.spyOn(AttioAPIClient.prototype, 'identifyApiTokenId').mockResolvedValue(null);
    const ref = freshRef();
    await lf(teamA).create({ ref, external: 'attio', binding: { credential: 'attio' }, fields: { access_token: 'attio-t1' } });
    const row = await rowNamed(teamA, ref);
    expect(row?.type).toBe(ExternalServiceType.ATTIO);
    expect(row?.user_id).toBeNull();
    const platform = postgresSecrets({ teamId: teamA, shape: renamedPayloadShape({ accessToken: 'access_token' }) });
    expect((await platform.resolve(row!.id))?.fields.access_token).toBe('attio-t1');
    expect(await storedPayload(row!.id)).toMatchObject({ accessToken: 'attio-t1' });
  });

  it('refuses a name the team already uses', async () => {
    const ref = freshRef();
    await lf(teamA).create(oauthEntry(ref, 'a1'));
    expect(await refusal(lf(teamA).create(oauthEntry(ref, 'a2')))).toBe('exists');
    expect((await lf(teamA).resolve(ref))?.fields.access_token).toBe('a1');
  });

  it('refuses params without their shape as bad_request', async () => {
    expect(await refusal(lf(teamA).raw['secrets.resolve']({}))).toBe('bad_request');
    expect(await refusal(lf(teamA).raw['secrets.lock']({ ref: freshRef() }))).toBe('bad_request');
    expect(await refusal(lf(teamA).raw['secrets.create']({ ref: freshRef(), external: 'acme_crm', fields: {} }))).toBe('bad_request');
  });
});

describe('the lease beside the platform\'s own refresh', () => {
  it('a platform refresh waits for a live lf lease', async () => {
    const ref = freshRef();
    await lf(teamA).create(oauthEntry(ref, 'a1'));
    const row = await rowNamed(teamA, ref);
    const lease = await lf(teamA).lock(ref);
    expect(lease).not.toBeNull();

    let entered = false;
    const refresh = postgresSecrets({ teamId: teamA }).exclusive!(row!.id, async () => {
      entered = true;
    });
    await new Promise((done) => setTimeout(done, 300));
    expect(entered).toBe(false);
    await lf(teamA).unlock(ref, lease!.token);
    await refresh;
    expect(entered).toBe(true);
  });

  it('an lf lock answers null while a platform refresh runs', async () => {
    const ref = freshRef();
    await lf(teamA).create(oauthEntry(ref, 'a1'));
    const row = await rowNamed(teamA, ref);
    let during: unknown = 'not asked';
    await postgresSecrets({ teamId: teamA }).exclusive!(row!.id, async () => {
      during = await lf(teamA).lock(ref);
    });
    expect(during).toBeNull();
    const after = await lf(teamA).lock(ref);
    expect(after).not.toBeNull();
    await lf(teamA).unlock(ref, after!.token);
  });

  it('a lapsed lease is taken over, and unlock with another token frees nothing', async () => {
    const ref = freshRef();
    const held = await lf(teamA).lock(ref, 100);
    expect(held).not.toBeNull();
    await lf(teamA).unlock(ref, `${held!.token}-not`);
    expect(await lf(teamA).lock(ref)).toBeNull();
    await new Promise((done) => setTimeout(done, 250));
    const taken = await lf(teamA).lock(ref);
    expect(taken).not.toBeNull();
    await lf(teamA).unlock(ref, taken!.token);
  });
});
