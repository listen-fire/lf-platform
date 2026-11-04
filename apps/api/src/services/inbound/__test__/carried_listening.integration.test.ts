// 0.12 listens kept hearing beside the current version (real Postgres, the real
// drain, 0.12's real modules and judging; the firing itself is stubbed: the dev
// loop runs it whole). Webhooks, schedules and polls under 0.12, and an upgrade
// with events on both sides of it.

import { carriedVersions } from '@listen-fire/language-versions';
import { createHmac, randomUUID } from 'node:crypto';

jest.mock('../../translation_graph/movement/execute', () => {
  const actual = jest.requireActual('../../translation_graph/movement/execute');
  return { ...actual, runMovementFiring: jest.fn(async () => ({ result: { movementName: 'fired', writes: [], extractionSites: {}, trace: [] } })) };
});
// The current version's module is not what is under test where a door reads:
// its read answers nothing, or fails, as a test says.
jest.mock('../../translation_graph/adapters/resolve', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/resolve');
  return { ...actual, resolveAdapter: jest.fn(actual.resolveAdapter) };
});

const mockBetween: { pull?: () => Promise<void> } = {};
jest.mock('../../translation_graph/adapters/system/carried_records', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/system/carried_records');
  return {
    ...actual,
    carriedSystemRecords: {
      ...actual.carriedSystemRecords,
      failedRuns: async (input: unknown) => {
        const hook = mockBetween.pull;
        mockBetween.pull = undefined;
        await hook?.();
        return actual.carriedSystemRecords.failedRuns(input);
      },
    },
  };
});

import { sql } from 'kysely';
import { LANGUAGE_VERSION } from 'movement-lang';
import { answerDelivery } from 'movement-engine/public/inbound';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { encryptToken } from '../../../lib/credentials';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { testWorkContext } from '../../../test/harness/work';
import { refreshDueAirtableWebhooks } from '../../airtable_webhook_refresh/worker';
import { cronReconcileHandler, fireCronHandler } from '../../movement_scheduler/worker';
import { pollSourceHandler, reconcileCarriedPolls } from '../../poll_source/carried_worker';
import { pollShared, sharedPolls } from '../../poll_source/worker';
import { resolveAdapter } from '../../translation_graph/adapters/resolve';
import { runMovementFiring } from '../../translation_graph/movement/execute';
import { upgradeMovement } from '../../translation_graph/movement/language_upgrade';
import { retryListenSubscriptions, syncListenSubscriptions } from '../../translation_graph/movement/listen_subscriptions';
import { saveMovement } from '../../translation_graph/movement/provision';
import { getMovementRow } from '../../translation_graph/movement/store';
import { mintMovementVersionIfChanged } from '../../translation_graph/movement/version_store';
import { platformInboundStoreFor } from '../../webhook_sync/handler';
import { holdDoorsAlone } from '../../movement_engine/run_host_deliveries';
import { inOneTransaction } from '../../translation_graph/movement/language_upgrade';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { enqueueWork, removeWork } from '../../work/store';
import { registerCoreWork } from '../../work/register';

const firing = runMovementFiring as jest.Mock;
const currentRead = resolveAdapter as jest.Mock;
const PIN = '0.12.13';

const ATTIO_012 = 'import { attio } from adapters\nimport { attio_conn } from credentials\ncrm = connect attio using attio_conn\nfunction onChange(e: <crm>) {\n  return 1\n}\nlisten to crm fire onChange\n';
const CRON_012 = 'import { `@lf/cron` as cron } from adapters\ntimer = connect cron\nfunction digest(t: <timer-[:Tick]->>) {\n  return t.`Fired at`\n}\n';
const DAILY_012 = `${CRON_012}listen to timer { schedule: "0 9 * * *" } fire digest\n`;
const EVERY_MINUTE_012 = `${CRON_012}listen to timer { schedule: "* * * * *" } fire digest\n`;
const SYSTEM_012 = 'import { `@lf/system` as system } from adapters\nsys = connect system\nfunction onFailed(failed: <sys-[:`Run Failed`]->>) {\n  return failed.Reason\n}\nlisten to sys { events: ["Run Failed"] } fire onFailed\n';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('0.12 listens beside the current version (real Postgres)', () => {
  let teamId: TeamId;
  let calls: Array<{ method: string; url: string; body?: unknown }>;
  const prior = process.env.LF_CARRIED_LISTENS;
  const realResolve = jest.requireActual('../../translation_graph/adapters/resolve').resolveAdapter;

  async function draft(source: string, pin = PIN): Promise<string> {
    const id = randomUUID() as MovementId;
    await getAutomationsQb(['movement']).insertInto('movement').values({ id, team_id: teamId, name: `m-${id}`, source, language_version: pin }).execute();
    return id;
  }

  /** An automation shipped under `pin`, its listens provisioned by a real save. */
  async function shipped(source: string, pin = PIN): Promise<string> {
    const id = await draft(source, pin);
    const saved = await saveMovement({ teamId, id, source, acknowledgeErrors: true });
    if (!saved.ok) throw new Error(`the save did not ship: ${JSON.stringify(saved)}`);
    return id;
  }

  /** A row as production's save left it, with no save: for a pin no save starts. */
  async function kept(input: { source: string; pin: string; kind: string; config?: unknown; firedMovementName: string; credentialsId?: string | null }): Promise<{ movementId: string; triggerId: string }> {
    const movementId = await draft(input.source, input.pin);
    await mintMovementVersionIfChanged({ teamId, movementId, source: input.source, languageVersion: input.pin });
    const triggerId = randomUUID();
    await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({
        id: triggerId as TriggerId,
        team_id: teamId,
        kind: input.kind,
        name: 'listen',
        config: JSON.stringify(input.config ?? {}) as never,
        movement_id: movementId as MovementId,
        fired_movement_name: input.firedMovementName,
        run_mode: 'live',
        credentials_id: (input.credentialsId ?? null) as never,
      })
      .execute();
    return { movementId, triggerId };
  }

  async function attioCredential(): Promise<string> {
    const id = randomUUID();
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({ id: id as never, team_id: teamId, type: ExternalServiceType.ATTIO, name: 'attio_conn', identifier: id, credentials: await encryptToken(JSON.stringify({ accessToken: 'k', access_token: 'k' }), id) } as never)
      .execute();
    return id;
  }

  async function webhookRow(input: { credentialsId: string; secret: string; cell?: unknown }): Promise<string> {
    const id = randomUUID();
    await getAutomationsQb(['webhook_subscription'])
      .insertInto('webhook_subscription')
      .values({
        id: id as never,
        team_id: teamId,
        provider: 'ATTIO',
        credentials_id: input.credentialsId as never,
        webhook_secret: input.secret,
        external_webhook_id: `ext-${id}`,
        status: 'active',
        provisioned_by: 'movement-listen',
        subscriptions: JSON.stringify(input.cell ?? [{ event_type: 'record.updated' }]),
      } as never)
      .execute();
    return id;
  }

  const attioBody = (recordId: string) =>
    Buffer.from(
      JSON.stringify({
        webhook_id: 'w',
        events: [{ event_type: 'record.updated', id: { workspace_id: 'ws', object_id: 'companies', record_id: recordId, attribute_id: 'a' }, parent_object_id: 'companies', parent_record_id: recordId, actor: { type: 'system', id: null } }],
      }),
    );

  async function deliver(subscriptionId: string, rawBody: Buffer, secret: string) {
    const headers = { 'content-type': 'application/json', 'attio-signature': createHmac('sha256', secret).update(rawBody).digest('hex') };
    const received = { rawBody, headers, method: 'POST', path: `/x/${subscriptionId}`, query: '' };
    return answerDelivery(platformInboundStoreFor(received), { notify: () => {} }, { provider: 'ATTIO', subscriptionId, ...received });
  }

  const receipts = () => getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('team_id', '=', teamId).select(['id', 'trigger_id', 'status', 'failure_reason', 'external_event_id', 'payload']).execute();
  const triggersOf = (movementId: string) => getAutomationsQb(['trigger']).selectFrom('trigger').where('movement_id', '=', movementId as MovementId).select(['id', 'kind', 'config', 'run_mode', 'resolved_address', 'poll_checkpoint', 'poll_last_at', 'cron_last_fired_at']).execute();
  const workOf = (kind: string) => getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('kind', '=', kind).select(['key', 'payload', 'due_at']).execute();
  const webhooks = () =>
    getAutomationsQb(['webhook_subscription']).selectFrom('webhook_subscription').where('team_id', '=', teamId).select(['id', 'provider', 'status', 'subscriptions', 'external_webhook_id', 'webhook_secret', 'deleted_at', 'scope']).execute();
  async function drain(): Promise<void> {
    for (let pass = 0; pass < 4; pass++) await drainUntilIdle({ teamId });
  }
  const ctx = (now: Date) => testWorkContext(now);
  const setRow = (id: string, set: Record<string, unknown>) => getAutomationsQb(['trigger']).updateTable('trigger').set(set as never).where('id', '=', id as TriggerId).execute();
  const issues = (movementId: string) => getAutomationsQb(['movement_issue']).selectFrom('movement_issue').where('movement_id', '=', movementId as MovementId).select(['count', 'message', 'failure_class']).execute();

  beforeAll(() => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
      if (method === 'PATCH' && url.includes('/v2/webhooks/')) {
        return json({ data: { id: { workspace_id: 'ws', webhook_id: 'patched' }, target_url: 'x', subscriptions: [], status: 'active', created_at: new Date().toISOString() } });
      }
      if (method === 'POST' && url.endsWith('/v2/webhooks')) {
        return json({ data: { id: { workspace_id: 'ws', webhook_id: `issued-${calls.length}` }, target_url: 'x', subscriptions: [], status: 'active', created_at: new Date().toISOString(), secret: 'issued-secret' } });
      }
      return json({ data: [] });
    });
    resetWorkHandlersForTests();
    registerCoreWork();
    setWorkNotifier(inProcessNotifier);
  });

  beforeEach(async () => {
    process.env.LF_CARRIED_LISTENS = 'on';
    firing.mockClear();
    calls = [];
    currentRead.mockImplementation(realResolve);
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `listening-${teamId}` }).execute();
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  afterAll(() => {
    if (prior === undefined) delete process.env.LF_CARRIED_LISTENS;
    else process.env.LF_CARRIED_LISTENS = prior;
  });

  describe('webhooks a 0.12 listen wants', () => {
    it('a save reaches the source through 0.12\'s own module, in production\'s row', async () => {
      await attioCredential();
      await shipped(ATTIO_012);
      const [row] = await webhooks();
      expect(row).toMatchObject({ provider: 'ATTIO', status: 'active', webhook_secret: 'issued-secret' });
      expect(row!.external_webhook_id).toMatch(/^issued-/);
      expect(JSON.stringify(row!.subscriptions)).toContain('event_type');
      const created = calls.find((call) => call.method === 'POST' && call.url.endsWith('/v2/webhooks'));
      // 0.12's shape of the request, naming the row's own URL.
      expect(created?.body).toMatchObject({ data: { target_url: expect.stringContaining(`/attio/${row!.id}`), subscriptions: expect.arrayContaining([expect.objectContaining({ filter: null })]) } });
    });

    it('a sync and the periodic retry never withdraw a webhook a 0.12 listen needs', async () => {
      await attioCredential();
      await shipped(ATTIO_012);
      calls = [];
      await syncListenSubscriptions({ teamId });
      await retryListenSubscriptions();
      expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
      expect(await webhooks()).toEqual([expect.objectContaining({ status: 'active', deleted_at: null })]);
    });

    it('a webhook a listen on a legacy version holds is kept too, so its refusal can be said', async () => {
      const credentialsId = await attioCredential();
      await webhookRow({ credentialsId, secret: 's' });
      await kept({ source: ATTIO_012, pin: '4', kind: 'attio', firedMovementName: 'onChange', credentialsId });
      await syncListenSubscriptions({ teamId });
      expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
      expect(await webhooks()).toEqual([expect.objectContaining({ status: 'active', deleted_at: null })]);
    });

    it('a webhook no 0.12 listen wants any more is removed', async () => {
      const credentialsId = await attioCredential();
      await webhookRow({ credentialsId, secret: 's' });
      await syncListenSubscriptions({ teamId });
      expect(await webhooks()).toEqual([expect.objectContaining({ status: 'disabled' })]);
    });

    it('a current listen\'s subscription and a 0.12 listen\'s webhook stand side by side, and one event does not fire 0.12 twice', async () => {
      const credentialsId = await attioCredential();
      const own = await webhookRow({ credentialsId, secret: 'own-secret' });
      const edge = await webhookRow({ credentialsId, secret: 'edge-secret', cell: { digest: 'd', edge: 'Companies' } });
      const { triggerId } = await kept({ source: ATTIO_012, pin: PIN, kind: 'attio', firedMovementName: 'onChange', credentialsId });
      currentRead.mockImplementation(async () => ({ adapterType: 'attio', preprocessInbound: async () => ({ events: [], arrivals: [] }) }));
      const body = attioBody(randomUUID());
      await deliver(edge, body, 'edge-secret');
      await deliver(own, body, 'own-secret');
      await drain();
      expect((await receipts()).map((receipt) => receipt.trigger_id)).toEqual([triggerId]);
      expect(firing).toHaveBeenCalledTimes(1);
    });

    it('a quiet Airtable webhook a 0.12 listen holds is refreshed by 0.12\'s own module', async () => {
      const id = randomUUID();
      const credentialsId = randomUUID();
      await getAutomationsQb(['external_service_credentials'])
        .insertInto('external_service_credentials')
        .values({ id: credentialsId as never, team_id: teamId, type: ExternalServiceType.AIRTABLE, name: 'air', identifier: id, credentials: await encryptToken(JSON.stringify({ accessToken: 'k', access_token: 'k' }), credentialsId) } as never)
        .execute();
      await getAutomationsQb(['webhook_subscription'])
        .insertInto('webhook_subscription')
        .values({
          id: id as never,
          team_id: teamId,
          provider: 'AIRTABLE',
          credentials_id: credentialsId as never,
          webhook_secret: 's',
          external_webhook_id: 'ach1',
          status: 'active',
          provisioned_by: 'movement-listen',
          subscriptions: JSON.stringify([{ event_type: 'record.updated' }]),
          scope: JSON.stringify({ base: 'app1', table: 'tbl1' }),
          updated_at: new Date(Date.now() - 8 * 24 * 3600 * 1000),
        } as never)
        .execute();
      await refreshDueAirtableWebhooks();
      expect(calls.some((call) => call.method === 'POST' && call.url.includes('/bases/app1/webhooks/ach1/refresh'))).toBe(true);
    });
  });

  describe('a save under 0.12', () => {
    it('reads the text\'s dry run axis', async () => {
      await attioCredential();
      const dry = 'crm = attio(credentials: attio_conn, dry_run: true)\nfunction onChange(e: <crm>) {\n  write crm-[:Companies]-> {\n    unique by (Name)\n    Name: "x"\n  }\n}\nlisten to crm fire onChange\n';
      const id = await draft(dry);
      const saved = await saveMovement({ teamId, id, source: dry, acknowledgeErrors: true });
      expect(saved.ok).toBe(true);
      expect((await triggersOf(id)).map((row) => row.run_mode)).toEqual(['dry_run']);
    });

    it('arms a schedule\'s reconcile, and a live listen stays live', async () => {
      const id = await shipped(DAILY_012);
      expect((await triggersOf(id)).map((row) => row.run_mode)).toEqual(['live']);
      const { rows } = await sql<{ key: string }>`select key from automations.work where kind = 'cron_reconcile'`.execute(getAutomationsQb(['work']));
      expect(rows.map((row) => row.key)).toContain('cron_reconcile:shipped');
    });
  });

  describe('a retried delivery, when the current version\'s read failed', () => {
    it('runs a 0.12 event once though it has no idempotency key', async () => {
      const credentialsId = await attioCredential();
      const sub = await webhookRow({ credentialsId, secret: 's3' });
      const { triggerId } = await kept({ source: ATTIO_012, pin: PIN, kind: 'attio', firedMovementName: 'onChange', credentialsId });
      const body = attioBody(randomUUID());
      currentRead.mockImplementationOnce(async () => ({
        adapterType: 'attio',
        preprocessInbound: async () => {
          throw new Error('the current read failed');
        },
      }));
      const first = await deliver(sub, body, 's3');
      expect(first.status).toBe(500);
      currentRead.mockImplementation(async () => ({ adapterType: 'attio', preprocessInbound: async () => ({ events: [], arrivals: [] }) }));
      await drain();
      const second = await deliver(sub, body, 's3');
      expect(second.status).toBe(200);
      await drain();
      const stored = await receipts();
      expect(stored.map((receipt) => receipt.trigger_id)).toEqual([triggerId]);
      expect(firing).toHaveBeenCalledTimes(1);
      const { rows } = await sql<{ count: string }>`select count(*)::text as count from automations.delivery where subscription_id = ${sub}::text`.execute(getAutomationsQb(['delivery']));
      expect(rows[0]?.count).toBe('1');
    });

    it('an identical delivery after it was judged is a new one', async () => {
      const credentialsId = await attioCredential();
      const sub = await webhookRow({ credentialsId, secret: 's4' });
      await kept({ source: ATTIO_012, pin: PIN, kind: 'attio', firedMovementName: 'onChange', credentialsId });
      currentRead.mockImplementation(async () => ({ adapterType: 'attio', preprocessInbound: async () => ({ events: [], arrivals: [] }) }));
      const body = attioBody(randomUUID());
      await deliver(sub, body, 's4');
      await deliver(sub, body, 's4');
      const { rows } = await sql<{ count: string; waiting: string }>`
        select count(*)::text as count, count(external_id)::text as waiting from automations.delivery where subscription_id = ${sub}::text`.execute(getAutomationsQb(['delivery']));
      expect(rows[0]).toEqual({ count: '2', waiting: '0' });
    });

    it('a reading taken again keeps one receipt for an event with no id', async () => {
      const { receiveJudgedEvent } = jest.requireActual('../carried_delivery');
      const { triggerId } = await kept({ source: DAILY_012, pin: PIN, kind: 'cron', config: { schedule: '0 9 * * *' }, firedMovementName: 'digest' });
      const event = { pipelineInputId: `trigger:${triggerId}`, adapterType: 'cron', triggerType: 'webhook', payload: { firedAt: new Date().toISOString(), schedule: '0 9 * * *' } };
      const lane = await carriedVersions().find((version) => version.key === '0.12')!.listenRows!();
      for (let attempt = 0; attempt < 2; attempt++) await receiveJudgedEvent({ teamId, triggerId, event, lane, stableKey: 'delivery:d:0' });
      expect(await receipts()).toHaveLength(1);
    });
  });

  describe('a listen on versions 1 to 4', () => {
    it('a matching delivery says why on one issue, with no run, however many arrive', async () => {
      const credentialsId = await attioCredential();
      const sub = await webhookRow({ credentialsId, secret: 's5' });
      const { movementId } = await kept({ source: ATTIO_012, pin: '4', kind: 'attio', firedMovementName: 'onChange', credentialsId });
      currentRead.mockImplementation(async () => ({ adapterType: 'attio', preprocessInbound: async () => ({ events: [], arrivals: [] }) }));
      await deliver(sub, attioBody(randomUUID()), 's5');
      await drain();
      await deliver(sub, attioBody(randomUUID()), 's5');
      await drain();
      expect(firing).not.toHaveBeenCalled();
      const found = await issues(movementId);
      expect(found).toHaveLength(1);
      expect(found[0]!.message).toMatch(/starts no new run on versions 1 to 4: upgrade it to/);
      expect(Number(found[0]!.count)).toBe(2);
      const { rows } = await sql<{ count: string }>`select count(*)::text as count from automations.trigger_run where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['trigger_run']));
      expect(rows[0]?.count).toBe('0');
    });

    it('a schedule says the same', async () => {
      const { movementId, triggerId } = await kept({ source: EVERY_MINUTE_012, pin: '4', kind: 'cron', config: { schedule: '* * * * *' }, firedMovementName: 'digest' });
      await setRow(triggerId, { cron_last_fired_at: new Date(Date.now() - 5 * 60_000) });
      await fireCronHandler.run({ triggerId }, ctx(new Date()));
      await drain();
      expect(firing).not.toHaveBeenCalled();
      expect((await issues(movementId))[0]?.message).toMatch(/starts no new run on versions 1 to 4/);
    });
  });

  describe('schedules under 0.12', () => {
    it('first sight sets the mark and fires nothing, then each occurrence fires once, and missed ones collapse', async () => {
      const id = await shipped(EVERY_MINUTE_012);
      const [row] = await triggersOf(id);
      const now = new Date();
      await cronReconcileHandler.run({}, ctx(now));
      expect((await workOf('fire_cron')).map((work) => work.key)).toEqual([`fire_cron:${row!.id}`]);
      expect((await triggersOf(id))[0]!.cron_last_fired_at).not.toBeNull();
      expect(await receipts()).toEqual([]);

      const later = new Date(now.getTime() + 5 * 60_000);
      await fireCronHandler.run({ triggerId: row!.id }, ctx(later));
      await fireCronHandler.run({ triggerId: row!.id }, ctx(later));
      const stored = await receipts();
      expect(stored).toHaveLength(1);
      expect(stored[0]!.payload).toMatchObject({ pipelineInputId: `trigger:${row!.id}`, adapterType: 'cron', triggerType: 'webhook', payload: { schedule: '* * * * *' } });
      await drain();
      expect(firing).toHaveBeenCalledTimes(1);
      expect(firing.mock.calls[0]![0]).toMatchObject({ triggerId: row!.id, door: { kind: 'judged' } });
    });

    it('a row paused or gone is not armed, and its work row goes', async () => {
      const id = await shipped(EVERY_MINUTE_012);
      const [row] = await triggersOf(id);
      await cronReconcileHandler.run({}, ctx(new Date()));
      await setRow(row!.id, { run_mode: 'off' });
      await cronReconcileHandler.run({}, ctx(new Date()));
      expect(await workOf('fire_cron')).toEqual([]);
    });

    it('a current version\'s schedule is not this scheduler\'s', async () => {
      await shipped('function tock(t: <cron-[:Ticks]->>) {\n}\n\nlisten to cron-[t:Ticks WHERE t.Schedule == "* * * * *"]-> fire tock\n', LANGUAGE_VERSION);
      await cronReconcileHandler.run({}, ctx(new Date()));
      expect(await workOf('fire_cron')).toEqual([]);
    });
  });

  /** A failed run of another automation, as the system module reads it. */
  async function failedRun(at: Date): Promise<string> {
    const id = randomUUID();
    const { triggerId } = await kept({ source: EVERY_MINUTE_012, pin: PIN, kind: 'manual', firedMovementName: 'digest' });
    await sql`
      insert into automations.trigger_run (id, team_id, trigger_id, trigger_type, status, started_at, failed_at, failure_reason, dry_run)
      values (${id}::uuid, ${teamId}::uuid, ${triggerId}::text, 'webhook', 'failed', ${at}::timestamptz, ${at}::timestamptz, 'it failed', false)`.execute(getAutomationsQb(['trigger_run']));
    return id;
  }

  describe('polls under 0.12', () => {
    it('one pull keeps its events and its cursor together, from the row\'s own cursor, and arms the next', async () => {
      const id = await shipped(SYSTEM_012);
      const [row] = await triggersOf(id);
      const base = Date.now() - 10 * 60_000;
      await setRow(row!.id, { poll_checkpoint: JSON.stringify({ runFailed: { failedAt: new Date(base).toISOString(), runId: '00000000-0000-0000-0000-000000000000' } }) });
      await failedRun(new Date(base + 60_000));
      await reconcileCarriedPolls(new Date());
      expect((await workOf('poll_source')).map((work) => work.key)).toEqual([`poll_source:${row!.id}`]);
      await pollSourceHandler.run({ triggerId: row!.id }, ctx(new Date()));
      const stored = await receipts();
      expect(stored).toHaveLength(1);
      expect(stored[0]!.payload).toMatchObject({ pipelineInputId: `trigger:${row!.id}`, adapterType: 'system', triggerType: 'poll' });
      const after = (await triggersOf(id))[0]!;
      expect(after.poll_last_at).not.toBeNull();
      expect((after.poll_checkpoint as { runFailed: { failedAt: string } }).runFailed.failedAt).toBe(new Date(base + 60_000).toISOString());
      await drain();
      expect(firing).toHaveBeenCalledTimes(1);
      // Inside its interval a turn pulls nothing.
      await pollSourceHandler.run({ triggerId: row!.id }, ctx(new Date()));
      expect(await receipts()).toHaveLength(1);
    });

    it('a pull that finds the row\'s cursor moved under it keeps nothing', async () => {
      const id = await shipped(SYSTEM_012);
      const [row] = await triggersOf(id);
      const base = Date.now() - 10 * 60_000;
      const start = { runFailed: { failedAt: new Date(base).toISOString(), runId: '00000000-0000-0000-0000-000000000000' } };
      await setRow(row!.id, { poll_checkpoint: JSON.stringify(start) });
      await failedRun(new Date(base + 60_000));
      // Another drain's turn commits while this pull is out.
      mockBetween.pull = async () => {
        await setRow(row!.id, { poll_checkpoint: JSON.stringify({ runFailed: { failedAt: new Date(base + 1000).toISOString(), runId: '00000000-0000-0000-0000-000000000000' } }) });
      };
      await pollSourceHandler.run({ triggerId: row!.id }, ctx(new Date()));
      expect(await receipts()).toEqual([]);
    });
  });

  describe('an upgrade carries how far a listen heard', () => {
    async function upgraded(id: string, more: Partial<Parameters<typeof upgradeMovement>[0]> = {}) {
      const answer = await upgradeMovement({ teamId, id, acknowledge: true, ...more });
      if (answer.status !== 'upgraded') throw new Error(`the upgrade did not move it: ${JSON.stringify(answer)}`);
    }
    const fireRows = () => workOf('fire_event');
    const firesOf = async () => (await fireRows()).map((row) => (row.payload as { arrival: { identity: string } }).arrival.identity);
    const pollsOf = async (triggerId: string) => (await sharedPolls({ teamId })).filter((poll) => poll.listens.some((listen) => listen.triggerId === triggerId));

    it('a schedule: the tick due during it fires once, as the current version, and 0.12 fires nothing after', async () => {
      const id = await shipped(EVERY_MINUTE_012);
      const [row] = await triggersOf(id);
      // Fired at T0, and an occurrence came due since that 0.12 has not taken.
      const t0 = new Date(Date.now() - 90_000);
      await setRow(row!.id, { cron_last_fired_at: t0 });
      await upgraded(id);
      const [moved] = await triggersOf(id);
      expect(moved!.config).toMatchObject({ listen: { carriedFrom: { pollsAlone: true } } });

      // The 0.12 turn that was due finds the row moved, and fires nothing.
      await fireCronHandler.run({ triggerId: moved!.id }, ctx(new Date()));
      expect(await receipts()).toEqual([]);

      const [poll] = await pollsOf(moved!.id);
      const first = await pollShared(poll!);
      expect(first.armed).toBe(false);
      expect(first.arrivals).toBeGreaterThanOrEqual(1);
      const ticks = await firesOf();
      expect(new Set(ticks).size).toBe(ticks.length);
      // Every tick after T0, and none at or before it.
      for (const tick of ticks) expect(Date.parse(tick.split(':').slice(-3).join(':'))).toBeGreaterThan(t0.getTime() - 60_000);
    });

    it('a schedule that had not fired yet arms, as under 0.12', async () => {
      const id = await shipped(EVERY_MINUTE_012);
      await upgraded(id);
      const [moved] = await triggersOf(id);
      expect(moved!.config).not.toMatchObject({ listen: { carriedFrom: { pollsAlone: true } } });
      const [poll] = await pollsOf(moved!.id);
      expect((await pollShared(poll!)).armed).toBe(true);
    });

    it('two schedules of one movement each take their own place', async () => {
      const source = `${CRON_012}listen to timer { schedule: "0 9 * * *" } fire digest\nlisten to timer { schedule: "0 10 * * *" } fire digest\n`;
      const id = await shipped(source);
      const rows = await triggersOf(id);
      expect(rows).toHaveLength(2);
      const nine = rows.find((row) => (row.config as { schedule: string }).schedule === '0 9 * * *')!;
      const ten = rows.find((row) => (row.config as { schedule: string }).schedule === '0 10 * * *')!;
      const at9 = new Date(Date.now() - 3 * 3600_000);
      const at10 = new Date(Date.now() - 4 * 3600_000);
      await setRow(nine.id, { cron_last_fired_at: at9 });
      await setRow(ten.id, { cron_last_fired_at: at10 });
      await upgraded(id);
      const { rows: cursors } = await sql<{ checkpoint: string }>`
        select checkpoint from automations.inbound_checkpoint where team_id = ${teamId}::uuid and subscription_id like 'edge-poll:%' order by checkpoint`.execute(getAutomationsQb(['inbound_checkpoint']));
      expect(cursors.map((row) => row.checkpoint).sort()).toEqual([at10.toISOString(), at9.toISOString()].sort());
      // Each schedule's own cursor names its own schedule's poll.
      for (const moved of await triggersOf(id)) {
        const [poll] = await pollsOf(moved.id);
        expect(JSON.stringify(poll!.key.taken)).toContain((moved.config as { listen: { plan: { hops: Array<{ taken: unknown }> } } }).listen ? '0 ' : '');
      }
    });

    it('a poll: events on both sides of the move each fire once, and the moved listen polls on what it brought though another listen shares the key', async () => {
      // A current listen already polling the same key stands further on.
      const other = await shipped(SYSTEM_012);
      await upgraded(other);
      const [otherRow] = await triggersOf(other);
      const [otherPoll] = await pollsOf(otherRow!.id);
      await pollShared(otherPoll!);

      const id = await shipped(SYSTEM_012);
      const [row] = await triggersOf(id);
      const base = Date.now() - 20 * 60_000;
      await setRow(row!.id, { poll_checkpoint: JSON.stringify({ runFailed: { failedAt: new Date(base).toISOString(), runId: '00000000-0000-0000-0000-000000000000' } }) });

      const heardBy012 = await failedRun(new Date(base + 60_000));
      await pollSourceHandler.run({ triggerId: row!.id }, ctx(new Date()));
      await drain();
      expect(firing).toHaveBeenCalledTimes(1);
      firing.mockClear();

      // Arrived, not polled yet: the move must not lose it.
      const during = await failedRun(new Date(base + 120_000));
      await upgraded(id);
      const [moved] = await triggersOf(id);
      const [poll] = await pollsOf(moved!.id);
      expect(poll!.listens.map((listen) => listen.triggerId)).toEqual([moved!.id]);

      // 0.12's turn finds it moved.
      await pollSourceHandler.run({ triggerId: moved!.id }, ctx(new Date()));
      expect(firing).not.toHaveBeenCalled();
      expect(await receipts()).toHaveLength(1);

      const before = await fireRows();
      await pollShared(poll!);
      const afterFirst = (await fireRows()).filter((row) => !before.some((earlier) => earlier.key === row.key));
      const identities = afterFirst.map((row) => JSON.stringify((row.payload as { arrival: unknown }).arrival));
      expect(identities.some((arrival) => arrival.includes(during))).toBe(true);
      expect(identities.some((arrival) => arrival.includes(heardBy012))).toBe(false);

      const after = await failedRun(new Date(base + 180_000));
      const [again] = await pollsOf(moved!.id);
      await pollShared(again!);
      const all = JSON.stringify((await fireRows()).map((row) => (row.payload as { arrival: unknown }).arrival));
      expect(all).toContain(after);
      expect(all).not.toContain(heardBy012);
    });

    it('a re-save of a moved listen keeps its poll', async () => {
      const id = await shipped(EVERY_MINUTE_012);
      const [row] = await triggersOf(id);
      await setRow(row!.id, { cron_last_fired_at: new Date(Date.now() - 60_000) });
      await upgraded(id);
      const [moved] = await triggersOf(id);
      const [poll] = await pollsOf(moved!.id);
      const movement = await getMovementRow({ teamId, id });
      const again = await saveMovement({ teamId, id, source: movement!.source, acknowledgeErrors: true });
      expect(again.ok).toBe(true);
      const [after] = await pollsOf(moved!.id);
      expect(after!.digest).toBe(poll!.digest);
    });

    it('holds for what is on its way: a delivery not yet read, then an event not yet started, each finishing under 0.12; then it moves', async () => {
      const id = await shipped(EVERY_MINUTE_012);
      const [row] = await triggersOf(id);

      const reading = `read_delivery:0.12:${randomUUID()}`;
      await enqueueWork({ kind: 'read_delivery', key: reading, teamId, payload: { adapterType: 'cron' } });
      expect(await upgradeMovement({ teamId, id, acknowledge: true, inFlightWaitMs: 0 })).toMatchObject({ status: 'blocked', detail: expect.stringMatching(/still being read.*nothing is lost/) });
      await removeWork({ key: reading });
      // Another module's reading is no reason to wait.
      await enqueueWork({ kind: 'read_delivery', key: reading, teamId, payload: { adapterType: 'attio' } });

      await setRow(row!.id, { cron_last_fired_at: new Date(Date.now() - 5 * 60_000) });
      await fireCronHandler.run({ triggerId: row!.id }, ctx(new Date()));
      expect(await workOf('dispatch_event')).toHaveLength(1);
      expect(await upgradeMovement({ teamId, id, acknowledge: true, inFlightWaitMs: 0 })).toMatchObject({ status: 'blocked', detail: expect.stringMatching(/waiting to start/) });
      expect((await getMovementRow({ teamId, id }))!.languageVersion).toBe(PIN);

      await removeWork({ key: reading });
      await drain();
      expect(firing).toHaveBeenCalledTimes(1);
      await upgraded(id);
      expect((await getMovementRow({ teamId, id }))!.languageVersion).toBe(LANGUAGE_VERSION);
    });

    it('a door keeping a delivery waits while a move holds the team\'s doors, and then sees the move', async () => {
      const credentialsId = await attioCredential();
      const sub = await webhookRow({ credentialsId, secret: 's7' });
      const { movementId } = await kept({ source: ATTIO_012, pin: PIN, kind: 'attio', firedMovementName: 'onChange', credentialsId });
      currentRead.mockImplementation(async () => ({ adapterType: 'attio', preprocessInbound: async () => ({ events: [], arrivals: [] }) }));
      let settled = false;
      let letItIn = (): void => {};
      // Started from here: the door is not part of the transaction below.
      const keeping = new Promise<void>((resolve) => {
        letItIn = resolve;
      })
        .then(() => deliver(sub, attioBody(randomUUID()), 's7'))
        .then(() => {
          settled = true;
        });
      await inOneTransaction(teamId, async () => {
        await holdDoorsAlone(getAutomationsQb(['work']), teamId);
        // Moved inside the hold: the keep cannot read the old pin once it is let in.
        await getAutomationsQb(['movement']).updateTable('movement').set({ language_version: LANGUAGE_VERSION }).where('id', '=', movementId as MovementId).execute();
        letItIn();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toBe(false);
      });
      await keeping;
      expect(settled).toBe(true);
      expect(await workOf('read_delivery')).toEqual([]);
    });

    it('a delivery kept before the move is not judged by the moved listen, though the door reads it after', async () => {
      const { deliverArrivals, savedListens } = jest.requireActual('../listen_door');
      const id = await shipped(EVERY_MINUTE_012);
      await upgraded(id);
      const [row] = await triggersOf(id);
      const at = new Date();
      const config = row!.config as { listen: Record<string, unknown> };
      await setRow(row!.id, { config: JSON.stringify({ ...config, listen: { ...config.listen, carriedFrom: { at: at.toISOString() } } }) });
      const listens = await savedListens({ teamId, adapterType: 'cron' });
      const arrival = { edge: 'Ticks', identity: 'x', landing: { recordType: 'Tick', fields: { firedAt: at.toISOString(), schedule: '* * * * *', zone: 'UTC' } }, occurredAt: at.toISOString(), takenApplied: true };
      const delivery = { teamId, delivered: { adapterType: 'cron', credentialsId: null }, externalId: null, source: 'webhook', arrivals: [arrival], listens };
      const before = await deliverArrivals({ ...delivery, subscriptionId: 's', keptAt: new Date(at.getTime() - 1) });
      expect(before.fires).toEqual([]);
      const afterwards = await deliverArrivals({ ...delivery, subscriptionId: 's2', keptAt: new Date(at.getTime() + 1) });
      expect(afterwards.fires).toHaveLength(1);
    });
  });
});
