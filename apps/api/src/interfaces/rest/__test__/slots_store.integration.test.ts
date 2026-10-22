// The store slot's route, as a cloud lf reaches it (real DB): adapter protocol
// 2's envelope at `POST /api/v1/system/slots/store`, behind the host's own
// authentication and the system caller gate, acting in the tenant of the key's
// owner. The key travels as `Authorization: Bearer`, as the drain scheduler
// sends it.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import express from 'express';

import type { AddressInfo } from 'node:net';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { ApiKeyService } from '../../../services/api_key';
import { jsonBodyParser } from '../../../lib/middleware/body_parser';
import { contextInjector } from '../../../lib/middleware/context';
import { createAuthenticationHandler } from '../../../lib/middleware/authentication';
import { authorisationHandler } from '../../../lib/middleware/authorisation';
import { defersToSystemCaller } from '../../../services/system_auth';
import { LF_STORE_METHODS } from '../../../services/lf_store/methods';
import { systemRouter } from '../v1/system';

let server: Server;
let url: string;
let owner: { teamId: TeamId; userId: UserId };
let systemKey: string;
let knowledgeKey: string;

async function makeOwner(): Promise<{ teamId: TeamId; userId: UserId }> {
  const teamId = randomUUID() as TeamId;
  const userId = randomUUID() as UserId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `slot-${teamId.slice(0, 8)}` }).execute();
  await getCoreQb(['user'])
    .insertInto('user')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: userId, default_team_id: teamId, username: `slot-${userId.slice(0, 8)}`, granted_access_at: new Date() } as any)
    .execute();
  await getCoreQb(['team_membership']).insertInto('team_membership').values({ user_id: userId, team_id: teamId, access: 'write' }).execute();
  return { teamId, userId };
}

beforeAll(async () => {
  owner = await makeOwner();
  systemKey = (await ApiKeyService.createForOwner({ name: 'lf store', scopes: ['system'], teamId: owner.teamId, createdBy: owner.userId })).key;
  knowledgeKey = (await ApiKeyService.createForOwner({ name: 'reader', scopes: ['knowledge'], teamId: owner.teamId, createdBy: owner.userId })).key;
  const app = express();
  app.use(jsonBodyParser);
  app.use(contextInjector);
  app.use(createAuthenticationHandler({ doors: [], defer: defersToSystemCaller }));
  app.use(authorisationHandler);
  app.use('/api/v1/system', systemRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/system/slots/store`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await getCoreQb(['api_key']).deleteFrom('api_key').where('team_id', '=', owner.teamId).execute();
  await cleanupTeam(owner.teamId);
});

function post(body: unknown, key: string | null = systemKey) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key !== null ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
}

const call = (method: string, params: Record<string, unknown> = {}, settings: Record<string, string> = {}) =>
  post({ protocolVersion: '2', method, cacheScopeId: '<slot>', params, settings });

describe('the store slot route', () => {
  it('answers its manifest: the store slot and its 64 methods', async () => {
    const res = await call('manifest');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      result: { protocolVersion: 2, name: 'lf-platform-store', kind: 'core', slot: 'store', methods: [...LF_STORE_METHODS] },
    });
    expect(LF_STORE_METHODS).toHaveLength(64);
  });

  it('refuses an unknown method, a lost protocol version, and a body that is not the envelope', async () => {
    const unknown = await call('runs.nothing');
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: false, error: { code: 'method_not_implemented', message: 'no method "runs.nothing"', retryable: false } });

    const older = await post({ protocolVersion: '1', method: 'manifest', params: {} });
    expect(older.status).toBe(200);
    expect(await older.json()).toEqual({ ok: false, error: { code: 'protocol_version', message: 'this module speaks protocol 2', retryable: false } });

    const bad = await post({ method: 'manifest' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'bad_request' });

    const badParam = await call('runs.get', { runId: 7 });
    expect(await badParam.json()).toMatchObject({ ok: false, error: { code: 'bad_request', retryable: false } });
  });

  it('is refused without a key, with an unknown key, and with a key that does not hold the system scope', async () => {
    expect((await post({ protocolVersion: '2', method: 'manifest' }, null)).status).toBe(403);
    expect((await post({ protocolVersion: '2', method: 'manifest' }, `${systemKey.slice(0, -4)}0000`)).status).toBe(401);
    const scoped = await post({ protocolVersion: '2', method: 'manifest' }, knowledgeKey);
    expect(scoped.status).toBe(403);
    expect(await scoped.json()).toEqual({ error: 'API key missing required scope: system' });
  });

  it("acts in the tenant of the key's owner, whatever the settings say", async () => {
    const elsewhere = randomUUID();
    const opened = await call('store.open', { settings: { tenant: elsewhere } }, { tenant: elsewhere });
    expect(await opened.json()).toEqual({ ok: true, result: { tenant: owner.teamId } });

    const runId = randomUUID();
    const started = await call('runs.start', { id: runId, file: 'welcome.lf', movement: 'welcome', startedAt: new Date().toISOString(), input: '{}' }, { tenant: elsewhere });
    expect(await started.json()).toEqual({ ok: true, result: null });
    const row = await getAutomationsQb(['trigger_run']).selectFrom('trigger_run').select(['team_id', 'host']).where('id', '=', runId as never).executeTakeFirstOrThrow();
    expect(row).toEqual({ team_id: owner.teamId, host: 'lf' });

    const leased = await (await call('leases.claim', { runId, ttlMs: 60_000 })).json();
    expect(leased).toMatchObject({ ok: true, result: { token: expect.any(String) } });
    const lost = await call('parks.commit', { runId, address: 's0', state: {}, fence: randomUUID(), park: { kind: 'limit' } });
    expect(await lost.json()).toEqual({
      ok: false,
      error: { code: 'run_lease_lost', message: 'run lease lost; another instance may hold the run', retryable: false, data: { runId } },
    });
  });
});
