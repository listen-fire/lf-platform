// The `system` adapter's route, as a cloud lf reaches it (real DB): adapter
// protocol 2's envelope at `POST /api/v1/system/adapters/system`, behind the
// host's own authentication and the system caller gate, acting in the tenant
// of the key's owner. lf's runs are written as the store slot writes them
// (lf_store/runs.ts), and the poll is asked as lf asks it: the listen's
// config, its checkpoint, and the movement the listen fires as `movementId`.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import express from 'express';

import type { AddressInfo } from 'node:net';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { MovementId } from '../../../generated/kysely/automations/Movement';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { ApiKeyService } from '../../../services/api_key';
import { jsonBodyParser } from '../../../lib/middleware/body_parser';
import { contextInjector } from '../../../lib/middleware/context';
import { createAuthenticationHandler } from '../../../lib/middleware/authentication';
import { authorisationHandler } from '../../../lib/middleware/authorisation';
import { defersToSystemCaller } from '../../../services/system_auth';
import { upsertMovementRow } from '../../../services/translation_graph/movement/store';
import { settleRun, startRun } from '../../../services/lf_store/runs';
import { failedRunsUrl } from '@listen-fire/system';
import { automationUrl, automationsUrl, webBaseUrl } from '../../../services/translation_graph/adapters/system/events';
import { systemRouter } from '../v1/system';

interface Owner {
  teamId: TeamId;
  userId: UserId;
  key: string;
}

let server: Server;
let url: string;
let teamA: Owner;
let teamB: Owner;
let knowledgeKey: string;
let syncMovementId: string;

const NIL = '00000000-0000-0000-0000-000000000000';
const HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function makeOwner(): Promise<Owner> {
  const teamId = randomUUID() as TeamId;
  const userId = randomUUID() as UserId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `sys-${teamId.slice(0, 8)}` }).execute();
  await getCoreQb(['user'])
    .insertInto('user')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: userId, default_team_id: teamId, username: `sys-${userId.slice(0, 8)}`, granted_access_at: new Date() } as any)
    .execute();
  await getCoreQb(['team_membership']).insertInto('team_membership').values({ user_id: userId, team_id: teamId, access: 'write' }).execute();
  const key = (await ApiKeyService.createForOwner({ name: 'lf system', scopes: ['system'], teamId, createdBy: userId })).key;
  return { teamId, userId, key };
}

/** One lf run of `file`'s listen firing `movement`, as the store slot records
 *  it: started, then settled `status` at `at`. */
async function lfRun(teamId: string, input: { file: string; movement: string; status: 'failed' | 'completed'; at: string; error?: string }): Promise<string> {
  const id = randomUUID();
  const scope = { tenant: teamId };
  await startRun(scope, { id, file: input.file, movement: input.movement, startedAt: input.at, input: '{}', deliveryId: null });
  await settleRun(scope, { runId: id, status: input.status, outcome: { writes: 0, ...(input.error !== undefined ? { error: input.error } : {}) }, at: input.at });
  return id;
}

beforeAll(async () => {
  teamA = await makeOwner();
  teamB = await makeOwner();
  knowledgeKey = (await ApiKeyService.createForOwner({ name: 'reader', scopes: ['knowledge'], teamId: teamA.teamId, createdBy: teamA.userId })).key;
  syncMovementId = (await upsertMovementRow({ teamId: teamA.teamId, name: 'Nightly Sync', source: 'function sync() {}\n' })).id;
  const app = express();
  app.use(jsonBodyParser);
  app.use(contextInjector);
  app.use(createAuthenticationHandler({ doors: [], defer: defersToSystemCaller }));
  app.use(authorisationHandler);
  app.use('/api/v1/system', systemRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/system/adapters/system`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const { teamId } of [teamA, teamB]) {
    await getCoreQb(['api_key']).deleteFrom('api_key').where('team_id', '=', teamId).execute();
    await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId).execute();
    await cleanupTeam(teamId);
  }
});

function post(body: unknown, key: string | null) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // lf names its own team here; the route never reads it.
      'x-listen-fire-team': teamB.teamId,
      ...(key !== null ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function call(owner: Owner, method: string, params: Record<string, unknown> = {}) {
  const res = await post({ protocolVersion: '2', method, cacheScopeId: '<none>', params }, owner.key);
  expect(res.status).toBe(200);
  return res.json();
}

interface PollResult {
  events: { payload: Record<string, string>; externalId: string; tag: string; eventType?: string }[];
  checkpoint: { runFailed?: { failedAt: string; runId: string } };
}

async function poll(owner: Owner, params: Record<string, unknown>): Promise<PollResult> {
  const answered = await call(owner, 'poll', params);
  expect(answered.ok).toBe(true);
  return answered.result;
}

const RUN_FAILED_LISTEN = { config: { events: ['Run Failed'] }, movementId: 'Run Failed' };

describe('the system adapter route', () => {
  it('answers its manifest first, with no listen, checkpoint or setting before it: a polled adapter on protocol 2.0', async () => {
    const answered = await call(teamA, 'manifest');

    expect(answered.ok).toBe(true);
    expect(answered.result).toMatchObject({
      protocolVersion: 2,
      protocolMinor: 0,
      adapterType: 'system',
      supportedTriggers: ['poll'],
      poll: { intervalSeconds: 60 },
      subscribableEvents: ['Run Failed', 'Run Paused', 'Validation Issue', 'Deprecated Version', 'Release Applied'],
    });
    expect(answered.result.methods).toEqual(expect.arrayContaining(['manifest', 'describe', 'listEntryPoints']));
  });

  it('describes an event kind by its natural name', async () => {
    const answered = await call(teamA, 'describe', { typeId: 'Run Failed' });
    expect(answered.ok).toBe(true);
    expect(answered.result.fields.map((f: { displayName: string }) => f.displayName)).toEqual(['Automation', 'Automation Id', 'Run Id', 'Version', 'Reason', 'Url', 'At']);
  });

  it('is refused without a key, with an unknown key, and with a key that does not hold the system scope', async () => {
    const manifest = { protocolVersion: '2', method: 'manifest', cacheScopeId: '<none>', params: {} };
    expect((await post(manifest, null)).status).toBe(403);
    expect((await post(manifest, `${teamA.key.slice(0, -4)}0000`)).status).toBe(401);
    expect((await post(manifest, knowledgeKey)).status).toBe(403);
  });

  it('refuses a lost protocol version, an unknown method and a body that is not the envelope', async () => {
    const older = await post({ protocolVersion: '1', method: 'manifest', cacheScopeId: '<none>', params: {} }, teamA.key);
    expect(await older.json()).toMatchObject({ ok: false, error: { code: 'protocol_version', retryable: false } });
    const unknown = await post({ protocolVersion: '2', method: 'nothing', cacheScopeId: '<none>', params: {} }, teamA.key);
    expect(await unknown.json()).toMatchObject({ ok: false, error: { code: 'method_not_implemented' } });
    expect((await post({ method: 'manifest' }, teamA.key)).status).toBe(400);
  });

  it('sets the mark on the first poll and emits nothing', async () => {
    await lfRun(teamA.teamId, { file: 'Nightly Sync', movement: 'sync', status: 'failed', at: minutesAgo(30), error: 'before anyone listened' });
    const first = await poll(teamA, RUN_FAILED_LISTEN);
    expect(first.events).toEqual([]);
    expect(first.checkpoint.runFailed?.runId).toBe(NIL);
  });

  it("reports the tenant's lf failures by file, skips the listener's own, never reads another tenant's, and advances the mark", async () => {
    const after = { runFailed: { failedAt: minutesAgo(20), runId: NIL } };
    const syncFailedAt = minutesAgo(15);
    const sync = await lfRun(teamA.teamId, { file: 'Nightly Sync', movement: 'sync', status: 'failed', at: syncFailedAt, error: 'Attio refused the write: 403' });
    const loose = await lfRun(teamA.teamId, { file: 'scratch/probe', movement: 'probe', status: 'failed', at: minutesAgo(14), error: 'probe fails by design' });
    await lfRun(teamA.teamId, { file: 'Nightly Sync', movement: 'sync', status: 'completed', at: minutesAgo(13) });
    const own = await lfRun(teamA.teamId, { file: 'Automation Alerts', movement: 'Run Failed', status: 'failed', at: minutesAgo(12), error: 'Slack channel not found' });
    const theirs = await lfRun(teamB.teamId, { file: 'Nightly Sync', movement: 'sync', status: 'failed', at: minutesAgo(11), error: 'team B only' });

    const polled = await poll(teamA, { ...RUN_FAILED_LISTEN, checkpoint: after });

    expect(polled.events.map((e) => e.externalId)).toEqual([sync, loose]);
    expect(polled.events[0]).toMatchObject({
      tag: 'system:run_failed',
      // lf narrows a listen's events by it, so it carries the listen's name.
      eventType: 'Run Failed',
      payload: {
        automation: 'Nightly Sync',
        automationId: 'listen:Nightly Sync:sync',
        runId: sync,
        reason: 'Attio refused the write: 403',
        url: automationUrl(syncMovementId),
        at: syncFailedAt,
      },
    });
    // No movement here is named by the file: the link is the automations list.
    expect(polled.events[1]?.payload).toMatchObject({ automation: 'scratch/probe', url: automationsUrl() });
    // The listener's own failure is passed, not delivered.
    expect(polled.checkpoint.runFailed?.runId).toBe(own);

    const again = await poll(teamA, { ...RUN_FAILED_LISTEN, checkpoint: polled.checkpoint });
    expect(again.events).toEqual([]);
    expect(again.checkpoint).toEqual(polled.checkpoint);

    const asB = await poll(teamB, { ...RUN_FAILED_LISTEN, checkpoint: after });
    expect(asB.events.map((e) => e.externalId)).toEqual([theirs]);
  });

  it("reports the platform's own failed runs as before, beside lf's", async () => {
    const trigger = await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({ team_id: teamA.teamId, name: 'movement/Nightly Sync/sync', kind: 'cron', movement_id: syncMovementId as MovementId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const failedAt = new Date(Date.now() - 5 * 60_000);
    const run = await getAutomationsQb(['trigger_run'])
      .insertInto('trigger_run')
      .values({ team_id: teamA.teamId, trigger_id: trigger.id, trigger_type: 'cron', status: 'failed', failed_at: failedAt, failure_reason: 'the platform run failed' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const polled = await poll(teamA, { ...RUN_FAILED_LISTEN, checkpoint: { runFailed: { failedAt: minutesAgo(6), runId: NIL } } });

    expect(polled.events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ automation: 'Nightly Sync', automationId: syncMovementId, runId: run.id, url: failedRunsUrl(webBaseUrl(), syncMovementId) }),
    ]);
  });

  it("tells a listener in another file about a failure of a movement that is not the one it fires", async () => {
    const after = { runFailed: { failedAt: HOUR_AGO, runId: NIL } };
    const polled = await poll(teamA, { config: { events: ['Run Failed'] }, movementId: 'Report', checkpoint: after });
    expect(polled.events.map((e) => e.payload.automation)).toContain('Automation Alerts');
  });
});
