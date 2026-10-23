// The movements slot's route, as a cloud lf reaches it (real DB): adapter
// protocol 2's envelope at `POST /api/v1/system/slots/movements`, behind the
// host's own authentication and the system caller gate, acting in the tenant
// of the key's owner. The key travels as `Authorization: Bearer`.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import express from 'express';
import { MOVEMENTS_METHODS } from 'engine-contracts/slots';

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
import { upsertMovementRow } from '../../../services/translation_graph/movement/store';
import { mintMovementVersionIfChanged, movementSourceHash } from '../../../services/translation_graph/movement/version_store';
import { LANGUAGE_VERSION } from 'movement-lang';
import { systemRouter } from '../v1/system';
import { switchTeamEngine } from '../../../services/lf_engine/switch';
import { platformEngineRefusal } from '../../../services/lf_movements/answer';

let server: Server;
let url: string;
let owner: { teamId: TeamId; userId: UserId };
let other: { teamId: TeamId; userId: UserId };
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

async function seed(teamId: string, name: string, source: string): Promise<void> {
  const row = await upsertMovementRow({ teamId, name, source });
  await mintMovementVersionIfChanged({ teamId, movementId: row.id, source, languageVersion: LANGUAGE_VERSION });
}

beforeAll(async () => {
  owner = await makeOwner();
  other = await makeOwner();
  systemKey = (await ApiKeyService.createForOwner({ name: 'lf movements', scopes: ['system'], teamId: owner.teamId, createdBy: owner.userId })).key;
  knowledgeKey = (await ApiKeyService.createForOwner({ name: 'reader', scopes: ['knowledge'], teamId: owner.teamId, createdBy: owner.userId })).key;
  await seed(owner.teamId, 'mine', 'function mine() {}\n');
  await seed(other.teamId, 'theirs', 'function theirs() {}\n');
  const app = express();
  app.use(jsonBodyParser);
  app.use(contextInjector);
  app.use(createAuthenticationHandler({ doors: [], defer: defersToSystemCaller }));
  app.use(authorisationHandler);
  app.use('/api/v1/system', systemRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/system/slots/movements`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await getCoreQb(['api_key']).deleteFrom('api_key').where('team_id', '=', owner.teamId).execute();
  for (const { teamId } of [owner, other]) {
    await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId).execute();
    await getAutomationsQb(['team_engine']).deleteFrom('team_engine').where('team_id', '=', teamId).execute();
    await cleanupTeam(teamId);
  }
});

afterEach(async () => {
  for (const { teamId } of [owner, other]) await switchTeamEngine(teamId, { engine: 'platform', changedBy: null });
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

describe('the movements slot route', () => {
  it('answers its manifest: the movements slot and its three methods', async () => {
    const res = await call('manifest');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      result: { protocolVersion: 2, name: 'lf-platform-movements', kind: 'core', slot: 'movements', methods: [...MOVEMENTS_METHODS] },
    });
    expect(MOVEMENTS_METHODS).toHaveLength(3);
  });

  it('refuses an unknown method, a lost protocol version, and a body that is not the envelope', async () => {
    await switchTeamEngine(owner.teamId, { engine: 'lf', changedBy: null });
    const unknown = await call('movements.nothing');
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: false, error: { code: 'method_not_implemented', message: 'no method "movements.nothing"', retryable: false } });

    const older = await post({ protocolVersion: '1', method: 'manifest', params: {} });
    expect(older.status).toBe(200);
    expect(await older.json()).toEqual({ ok: false, error: { code: 'protocol_version', message: 'this module speaks protocol 2', retryable: false } });

    const bad = await post({ method: 'manifest' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'bad_request' });
  });

  it('is refused without a key, with an unknown key, and with a key that does not hold the system scope', async () => {
    expect((await post({ protocolVersion: '2', method: 'manifest' }, null)).status).toBe(403);
    expect((await post({ protocolVersion: '2', method: 'manifest' }, `${systemKey.slice(0, -4)}0000`)).status).toBe(401);
    const scoped = await post({ protocolVersion: '2', method: 'manifest' }, knowledgeKey);
    expect(scoped.status).toBe(403);
    expect(await scoped.json()).toEqual({ error: 'API key missing required scope: system' });
  });

  it("acts in the tenant of the key's owner, and only once that team is lf-engined", async () => {
    const unmarked = await call('movements.list');
    expect(await unmarked.json()).toEqual({
      ok: false,
      error: {
        code: 'settings',
        message: platformEngineRefusal(owner.teamId),
        retryable: false,
      },
    });

    for (const { teamId } of [owner, other]) await switchTeamEngine(teamId, { engine: 'lf', changedBy: null });
    const listed = await call('movements.list');
    expect(await listed.json()).toEqual({ ok: true, result: [{ path: 'mine.mvt', version: movementSourceHash('function mine() {}\n') }] });
    expect(await (await call('movements.read', { path: 'theirs.mvt' })).json()).toEqual({ ok: true, result: null });
    const elsewhere = await call('movements.list', {}, { tenant: other.teamId });
    expect(await elsewhere.json()).toMatchObject({ ok: false, error: { code: 'settings', retryable: false } });
  });
});
