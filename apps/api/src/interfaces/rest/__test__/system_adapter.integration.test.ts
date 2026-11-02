// The `system` adapter's route, as a cloud lf reaches it (real DB): adapter
// protocol 2's envelope at `POST /api/v1/system/adapters/system`, behind the
// host's own authentication and the system caller gate, acting in the tenant
// of the key's owner. The poll is asked as 0.13 asks it: one listenable edge
// (`Events`), the listen's taken filter on `Kind`, and the cursor the last
// poll answered. The facts are written where their writers leave them: lf's
// runs as the store slot writes them, the platform's runs and triggers, the
// `system_event` rows, stranded waits and the listen door's unjudged facts.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import express from 'express';
import { sql } from 'kysely';

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
import { noteUnjudged } from '../../../services/lf_store/records_door';
import { DEPRECATED_VERSION, RELEASE_APPLIED, RUN_PAUSED, VALIDATION_ISSUE } from '@listen-fire/system';
import { automationUrl, automationsUrl, recordSystemEvent, webBaseUrl } from '../../../services/translation_graph/adapters/system/events';
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

/** One lf run of `file`'s `movement`, as the store slot records it: started
 *  by the listen `listen`, then settled `status` at `at`. */
async function lfRun(
  teamId: string,
  input: { file: string; movement: string; status: 'failed' | 'completed'; at: string; error?: string; listen?: string },
): Promise<string> {
  const id = randomUUID();
  const scope = { tenant: teamId };
  const facts = input.listen === undefined ? {} : { event: { pipelineInputId: input.listen } };
  await startRun(scope, { id, file: input.file, movement: input.movement, startedAt: input.at, input: JSON.stringify(facts), deliveryId: null, teamId: null });
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
    await getAutomationsQb(['system_event']).deleteFrom('system_event').where('team_id', '=', teamId).execute();
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
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

interface Arrival {
  identity: string;
  landing: { recordId: string; recordType: string; fields: Record<string, unknown> };
  notFor?: string;
  about?: { recordType: string; externalId: string };
}

interface PollAnswer {
  arrivals: Arrival[];
  cursor: Record<string, { at: string } & Record<string, unknown>>;
}

const kindIs = (kind: string) => ({ type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'Kind' }, right: { type: 'static', value: kind } });

async function poll(owner: Owner, input: { kind: string; cursor?: unknown }): Promise<PollAnswer> {
  const answered = await call(owner, 'poll', { edge: 'Events', filter: kindIs(input.kind), ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) });
  expect(answered).toMatchObject({ ok: true });
  return answered.result;
}

const fieldsOf = (answer: PollAnswer) => answer.arrivals.map((a) => a.landing.fields);

describe('the system adapter route', () => {
  it('answers its manifest: a polled adapter on protocol 2.6', async () => {
    const answered = await call(teamA, 'manifest');

    expect(answered.ok).toBe(true);
    expect(answered.result).toMatchObject({ protocolVersion: 2, protocolMinor: 6, adapterType: 'system', supportedTriggers: ['poll'] });
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

  it('arms on the first poll and emits nothing', async () => {
    await lfRun(teamA.teamId, { file: 'Nightly Sync', movement: 'sync', status: 'failed', at: minutesAgo(30), error: 'before anyone listened' });
    const first = await poll(teamA, { kind: 'Run Failed' });
    expect(first.arrivals).toEqual([]);
    expect(first.cursor.failed).toMatchObject({ runId: NIL });
  });

  it("reports the tenant's lf failures, marks each not for the listen that started it, never reads another tenant's, and advances the mark", async () => {
    const cursor = { failed: { at: minutesAgo(20), runId: NIL } };
    const syncFailedAt = minutesAgo(15);
    const sync = await lfRun(teamA.teamId, { file: 'Nightly Sync', movement: 'sync', status: 'failed', at: syncFailedAt, error: 'Attio refused the write: 403' });
    const loose = await lfRun(teamA.teamId, { file: 'scratch/probe', movement: 'probe', status: 'failed', at: minutesAgo(14), error: 'probe fails by design' });
    await lfRun(teamA.teamId, { file: 'Nightly Sync', movement: 'sync', status: 'completed', at: minutesAgo(13) });
    const alerts = 'listen:Automation Alerts:alert:0a1b2c3d';
    const own = await lfRun(teamA.teamId, { file: 'Automation Alerts', movement: 'alert', status: 'failed', at: minutesAgo(12), error: 'Slack channel not found', listen: alerts });
    const theirs = await lfRun(teamB.teamId, { file: 'Nightly Sync', movement: 'sync', status: 'failed', at: minutesAgo(11), error: 'team B only' });

    const polled = await poll(teamA, { kind: 'Run Failed', cursor });

    expect(fieldsOf(polled).map((f) => f['Run Id'])).toEqual([sync, loose, own]);
    expect(polled.arrivals[0]).toMatchObject({
      about: { recordType: 'Run', externalId: sync },
      landing: {
        fields: {
          Kind: 'Run Failed',
          Automation: 'sync',
          'Automation Id': 'Nightly Sync:sync',
          Reason: 'Attio refused the write: 403',
          Url: automationUrl(syncMovementId),
          At: syncFailedAt,
        },
      },
    });
    expect(polled.arrivals[0]?.notFor).toBeUndefined();
    // No movement here is named by the file: the link is the automations list.
    expect(polled.arrivals[1]?.landing.fields).toMatchObject({ Automation: 'probe', Url: automationsUrl() });
    // A failure is never told to the listen whose arrival started the run.
    expect(polled.arrivals[2]?.notFor).toBe(alerts);
    expect(polled.cursor.failed).toMatchObject({ runId: own });

    const again = await poll(teamA, { kind: 'Run Failed', cursor: polled.cursor });
    expect(again.arrivals).toEqual([]);
    expect(again.cursor).toEqual(polled.cursor);

    const asB = await poll(teamB, { kind: 'Run Failed', cursor });
    expect(fieldsOf(asB).map((f) => f['Run Id'])).toEqual([theirs]);
  });

  it("reports the platform's own failed runs by their movement, passes a rehearsal, and reads a failure kept finer than a millisecond once", async () => {
    const trigger = await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({ team_id: teamA.teamId, name: 'movement/Nightly Sync/sync', kind: 'cron', movement_id: syncMovementId as MovementId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const listen = 'listen:Nightly Sync:sync:9f8e7d6c';
    const insertRun = (input: { dryRun: boolean; reason: string }) =>
      getAutomationsQb(['trigger_run'])
        .insertInto('trigger_run')
        .values({
          team_id: teamA.teamId,
          trigger_id: trigger.id,
          trigger_type: 'cron',
          status: 'failed',
          // now(): microseconds, finer than the mark's ISO text carries.
          failed_at: sql<Date>`now() - interval '5 minutes'`,
          failure_reason: input.reason,
          dry_run: input.dryRun,
          trigger_payload: { pipelineInputId: listen },
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    const run = await insertRun({ dryRun: false, reason: 'the platform run failed' });
    await insertRun({ dryRun: true, reason: 'a rehearsal' });

    const polled = await poll(teamA, { kind: 'Run Failed', cursor: { failed: { at: minutesAgo(6), runId: NIL } } });

    expect(polled.arrivals).toHaveLength(1);
    expect(polled.arrivals[0]).toMatchObject({
      notFor: listen,
      landing: {
        fields: {
          Automation: 'Nightly Sync',
          'Automation Id': syncMovementId,
          'Run Id': run.id,
          Reason: 'the platform run failed',
          Url: `${webBaseUrl()}/movements/${syncMovementId}?view=activity&status=failed`,
        },
      },
    });
    const again = await poll(teamA, { kind: 'Run Failed', cursor: polled.cursor });
    expect(again.arrivals).toEqual([]);
  });

  it('reports a run paused at its cost limit and a release, from the rows kept for them', async () => {
    const paused = await lfRun(teamA.teamId, { file: 'Nightly Sync', movement: 'sync', status: 'completed', at: minutesAgo(9), listen: 'listen:Nightly Sync:sync:1' });
    const pausedAt = minutesAgo(8);
    await recordSystemEvent({
      teamId: teamA.teamId,
      kind: RUN_PAUSED,
      payload: { automation: 'Nightly Sync', automationId: syncMovementId, runId: paused, version: '', reason: 'spent $5.00 of a $5.00 limit', url: `${automationUrl(syncMovementId)}?view=activity`, at: pausedAt },
    });
    await recordSystemEvent({
      teamId: teamA.teamId,
      kind: RELEASE_APPLIED,
      payload: { automation: '', automationId: '', runId: '', version: '0.13.0', reason: 'release 0.13.0', url: automationsUrl(), at: minutesAgo(7) },
    });

    const pausedPoll = await poll(teamA, { kind: 'Run Paused', cursor: { paused: { at: minutesAgo(10), runId: NIL } } });
    expect(pausedPoll.arrivals).toHaveLength(1);
    expect(pausedPoll.arrivals[0]).toMatchObject({
      notFor: 'listen:Nightly Sync:sync:1',
      landing: { fields: { Kind: 'Run Paused', 'Run Id': paused, 'Automation Id': syncMovementId, Reason: 'spent $5.00 of a $5.00 limit', At: pausedAt } },
    });
    expect(pausedPoll.cursor.paused).toEqual({ at: pausedAt, runId: paused });

    const releasePoll = await poll(teamA, { kind: 'Release Applied', cursor: { releases: { at: minutesAgo(10), version: '' } } });
    expect(fieldsOf(releasePoll)).toEqual([expect.objectContaining({ Kind: 'Release Applied', Version: '0.13.0' })]);
    expect((await poll(teamB, { kind: 'Release Applied', cursor: { releases: { at: minutesAgo(10), version: '' } } })).arrivals).toEqual([]);
  });

  it('reports what the deploy check found of a saved program: a Validation Issue and a Deprecated Version, each once', async () => {
    const issueAt = minutesAgo(6);
    await recordSystemEvent({
      teamId: teamA.teamId,
      kind: VALIDATION_ISSUE,
      payload: { automation: 'Nightly Sync', automationId: syncMovementId, runId: '', version: '0.13.1', reason: 'Owner is not a field of Task', url: automationUrl(syncMovementId), at: issueAt },
    });
    await recordSystemEvent({
      teamId: teamA.teamId,
      kind: DEPRECATED_VERSION,
      payload: { automation: 'Nightly Sync', automationId: syncMovementId, runId: '', version: '3', reason: 'legacy 3 is deprecated', url: automationUrl(syncMovementId), at: minutesAgo(5) },
    });

    const issues = await poll(teamA, { kind: 'Validation Issue', cursor: { validation: { at: minutesAgo(10), automationId: '' } } });
    expect(issues.arrivals).toHaveLength(1);
    expect(issues.arrivals[0]).toMatchObject({
      identity: `validation_issue:${syncMovementId}:0.13.1:${issueAt}`,
      landing: { fields: { Kind: 'Validation Issue', Automation: 'Nightly Sync', 'Automation Id': syncMovementId, Version: '0.13.1', Reason: 'Owner is not a field of Task', Url: automationUrl(syncMovementId), 'Run Id': '' } },
    });
    expect(issues.arrivals[0]).not.toHaveProperty('about');
    expect(issues.cursor.validation).toEqual({ at: issueAt, automationId: syncMovementId });
    expect((await poll(teamA, { kind: 'Validation Issue', cursor: issues.cursor })).arrivals).toEqual([]);

    const deprecated = await poll(teamA, { kind: 'Deprecated Version', cursor: { deprecated: { at: minutesAgo(10), automationId: '' } } });
    expect(fieldsOf(deprecated)).toEqual([expect.objectContaining({ Kind: 'Deprecated Version', Version: '3', Reason: 'legacy 3 is deprecated' })]);
    expect((await poll(teamB, { kind: 'Validation Issue', cursor: { validation: { at: minutesAgo(10), automationId: '' } } })).arrivals).toEqual([]);
  });

  it('reports a wait whose record was deleted, by its module, edge and record', async () => {
    const run = await lfRun(teamA.teamId, { file: 'Nightly Sync', movement: 'sync', status: 'completed', at: minutesAgo(9), listen: 'listen:Nightly Sync:sync:2' });
    const wait = await getAutomationsQb(['wait_row'])
      .insertInto('wait_row')
      .values({ run_id: run, team_id: teamA.teamId, adapter_type: 'attio', edge: 'Changes', key: 'rec-1', since: '0', record_id: 'rec-1', stranded_at: sql<Date>`now() - interval '3 minutes'` })
      .returning('id')
      .executeTakeFirstOrThrow();

    const polled = await poll(teamA, { kind: 'Wait Lost Its Record', cursor: { stranded: { at: minutesAgo(5), waitId: NIL } } });

    expect(polled.arrivals).toHaveLength(1);
    expect(polled.arrivals[0]).toMatchObject({
      notFor: 'listen:Nightly Sync:sync:2',
      landing: { fields: { Kind: 'Wait Lost Its Record', 'Run Id': run, Adapter: 'attio', Edge: 'Changes', 'Record Id': 'rec-1', Automation: 'sync' } },
    });
    expect(polled.cursor.stranded).toMatchObject({ waitId: wait.id });
    expect((await poll(teamA, { kind: 'Wait Lost Its Record', cursor: polled.cursor })).arrivals).toEqual([]);
    expect((await poll(teamB, { kind: 'Wait Lost Its Record', cursor: { stranded: { at: minutesAgo(5), waitId: NIL } } })).arrivals).toEqual([]);
  });

  it("reports an arrival a listen could not judge, with the listen's movement, and never its own reports of one", async () => {
    const at = minutesAgo(4);
    const fact = {
      pipeline: 'listen:Nightly Sync:sync:3',
      arrival: 'Messages:C1:C1:1700.1:',
      file: 'Nightly Sync',
      movement: 'sync',
      deliveryId: null,
      edge: 'Messages',
      adapter: 'slack',
      recordId: 'C1:1700.1',
      landing: { recordType: 'Message', fields: {} },
      reason: 'slack could not read Name of the Channels record',
      cause: null,
      at,
      attempt: 0,
    };
    await noteUnjudged({ tenant: teamA.teamId }, { ...fact, forgetBefore: minutesAgo(600) });
    // A listen on `Events` that could not judge one of this module's own reports.
    await noteUnjudged(
      { tenant: teamA.teamId },
      { ...fact, at: minutesAgo(3), pipeline: 'listen:Alerts:alert:4', edge: 'Events', adapter: 'system', arrival: 'Events:x', landing: { recordType: 'Event', fields: { Kind: 'Arrival Not Judged' } }, forgetBefore: minutesAgo(600) },
    );

    const polled = await poll(teamA, { kind: 'Arrival Not Judged', cursor: { unjudged: { at: minutesAgo(5), listen: '', arrival: '', attempt: 0 } } });

    expect(polled.arrivals).toHaveLength(1);
    expect(polled.arrivals[0]).toMatchObject({
      notFor: fact.pipeline,
      landing: {
        fields: {
          Kind: 'Arrival Not Judged',
          Automation: 'Nightly Sync',
          'Automation Id': syncMovementId,
          Listen: fact.pipeline,
          'Arrival Id': fact.arrival,
          Edge: 'Messages',
          'Record Id': 'C1:1700.1',
          Attempt: 0,
        },
      },
    });
    // The mark passes the report it did not deliver.
    expect(polled.cursor.unjudged).toMatchObject({ listen: 'listen:Alerts:alert:4' });
  });
});
