// One door, two versions (real Postgres, the real drain, 0.12's real modules
// and judging; the firing itself is stubbed: the dev loop runs it whole). A
// delivery is kept once before any version reads it, without its signature, and
// a carried version reads what was kept, judging only the automations pinned to
// it. A `dispatch_event` row a 0.12.13 door queued runs. Replies wake.

import { createHmac, randomUUID } from 'node:crypto';

jest.mock('../../translation_graph/movement/execute', () => {
  const actual = jest.requireActual('../../translation_graph/movement/execute');
  return { ...actual, runMovementFiring: jest.fn(async () => ({ result: { movementName: 'fired', writes: [], extractionSites: {}, trace: [] } })) };
});
// The current version's module is not what is under test: its read answers nothing.
jest.mock('../../translation_graph/adapters/resolve', () => ({
  ...jest.requireActual('../../translation_graph/adapters/resolve'),
  resolveAdapter: jest.fn(async () => ({ adapterType: 'attio', preprocessInbound: async () => ({ events: [], arrivals: [] }) })),
}));
jest.mock('../../loop_guard', () => {
  const actual = jest.requireActual('../../loop_guard');
  return { ...actual, evaluate: jest.fn(actual.evaluate), loadGuardPausedState: jest.fn(actual.loadGuardPausedState) };
});

import { sql } from 'kysely';
import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../generated/kysely/automations/Movement';

import { encryptToken } from '../../../lib/credentials';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import * as loopGuard from '../../loop_guard';
import { platformInboundStoreFor } from '../../webhook_sync/handler';
import { registerCoreWork } from '../../work/register';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { answerDelivery } from 'movement-engine/public/inbound';
import { runMovementFiring } from '../../translation_graph/movement/execute';
import { mintMovementVersionIfChanged } from '../../translation_graph/movement/version_store';
import { findTriggerByInboundKey } from '../../translation_graph/storage/tg_table';
import { readDeliveryHandler } from '../carried_delivery';
import { testWorkContext } from '../../../test/harness/work';
import { WorkDeferred } from '../../work/drain';
import { carriedRunHandler } from '../../translation_graph/movement/carried_run_now';
import { liveDeployCheckDeps, runDeployCheck, thisDeployCheckRelease } from '../../translation_graph/movement/language_upgrade';
import { saveMovement } from '../../translation_graph/movement/provision';
import { runMovementAsync } from '../../translation_graph/movement/run_now';
import { getMovementRow } from '../../translation_graph/movement/store';
import { answerAskByToken, createAsk } from '../../asks/doors';
import { getAsk } from '../../asks/store';

const firing = runMovementFiring as jest.Mock;
const guardEvaluate = loopGuard.evaluate as jest.Mock;

const ATTIO_012 = 'attio = Attio(credential: attio_conn)\nfunction onChange(e: <attio>) {\n  return 1\n}\nlisten to attio fire onChange\n';

describe('one door, two versions (real Postgres)', () => {
  let teamId: TeamId;

  async function movementOn(pin: string, source: string): Promise<string> {
    const id = randomUUID() as MovementId;
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id, team_id: teamId, name: `m-${id}`, source, language_version: pin })
      .execute();
    await mintMovementVersionIfChanged({ teamId, movementId: id, source, languageVersion: pin });
    return id;
  }

  async function listenRow(input: { movementId: string; kind?: string; config?: unknown; firedMovementName?: string; runMode?: string; credentialsId?: string | null }): Promise<string> {
    const id = randomUUID();
    await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({
        id: id as TriggerId,
        team_id: teamId,
        kind: input.kind ?? 'attio',
        name: 'listen',
        config: JSON.stringify(input.config ?? {}) as never,
        movement_id: input.movementId as MovementId,
        fired_movement_name: input.firedMovementName ?? 'onChange',
        run_mode: input.runMode ?? 'live',
        credentials_id: (input.credentialsId ?? null) as never,
      })
      .execute();
    return id;
  }

  async function subscription(secret: string): Promise<string> {
    const id = randomUUID();
    const credentialsId = randomUUID();
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({ id: credentialsId as never, team_id: teamId, type: ExternalServiceType.ATTIO, name: 'attio_conn', identifier: id, credentials: await encryptToken(JSON.stringify({ accessToken: 'k', access_token: 'k' }), credentialsId) })
      .execute();
    await getAutomationsQb(['webhook_subscription'])
      .insertInto('webhook_subscription')
      .values({ id: id as never, team_id: teamId, provider: 'ATTIO', credentials_id: credentialsId as never, webhook_secret: secret, external_webhook_id: id, status: 'active', subscriptions: '[]' as never })
      .execute();
    return id;
  }

  const attioBody = (eventId: string) =>
    Buffer.from(
      JSON.stringify({
        webhook_id: 'w',
        events: [{ event_type: 'record.updated', id: { workspace_id: 'ws', object_id: 'companies', record_id: eventId, attribute_id: 'a' }, parent_object_id: 'companies', actor: { type: 'workspace-member', id: 'u' } }],
      }),
    );

  async function deliver(subscriptionId: string, rawBody: Buffer, secret: string) {
    const headers = { 'content-type': 'application/json', 'attio-signature': createHmac('sha256', secret).update(rawBody).digest('hex'), authorization: 'Bearer leak' };
    const received = { rawBody, headers, method: 'POST', path: `/x/${subscriptionId}`, query: '' };
    return answerDelivery(platformInboundStoreFor(received), { notify: () => {} }, { provider: 'ATTIO', subscriptionId, ...received });
  }

  const deliveries = (subscriptionId: string) =>
    sql<{ id: string; judged_at: Date | null; request: { headers: Record<string, string>; body: string } }>`
      select id::text as id, judged_at, request from automations.delivery where subscription_id = ${subscriptionId}::text`.execute(getAutomationsQb(['delivery']));
  const workOf = (kind: string) => getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('kind', '=', kind).select(['key', 'payload', 'dead_at']).execute();
  const receipts = () => getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('team_id', '=', teamId).select(['id', 'trigger_id', 'status', 'failure_reason']).execute();

  beforeAll(async () => {
    // 0.12's Attio reads its workspace's catalogs for the event's type names.
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    resetWorkHandlersForTests();
    registerCoreWork();
    setWorkNotifier(inProcessNotifier);
  });

  beforeEach(async () => {
    firing.mockClear();
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `carried-${teamId}` }).execute();
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
  });


  it('keeps one delivery, without its signature or credentials, before the versions read it, and 0.12 judges only its own', async () => {
    const secret = 'sekrit-secret-sekrit';
    const sub = await subscription(secret);
    const carried = await movementOn('0.12.13', ATTIO_012);
    const row012 = await listenRow({ movementId: carried });
    // A row pinned to the current version is not 0.12's to read.
    const current = await movementOn(LANGUAGE_VERSION, ATTIO_012);
    const row015 = await listenRow({ movementId: current });

    const answer = await deliver(sub, attioBody(randomUUID()), secret);
    expect(answer.status).toBe(200);

    const { rows } = await deliveries(sub);
    expect(rows).toHaveLength(1);
    const kept = rows[0]!;
    expect(JSON.stringify(kept.request.headers)).not.toMatch(/signature|authorization|leak/i);
    expect((await workOf('read_delivery')).map((row) => row.key)).toEqual([`read_delivery:0.12:${kept.id}`]);

    await drainUntilIdle({ teamId });
    // The reading queued the receipt's row; the next pass takes it.
    await drainUntilIdle({ teamId });
    const stored = await receipts();
    expect(stored.map((receipt) => receipt.trigger_id)).toEqual([row012]);
    expect(stored[0]!.trigger_id).not.toBe(row015);
    expect(stored[0]!.status).toBe('dispatched');
    expect(firing).toHaveBeenCalledTimes(1);
    expect(firing.mock.calls[0]![0]).toMatchObject({ triggerId: row012, door: { kind: 'judged' }, triggerEventId: stored[0]!.id });
  });

  it('a row kept only for a run, whose listen left the text, is not judged', async () => {
    const secret = 'sekrit-secret-sekrit';
    const sub = await subscription(secret);
    const movement = await movementOn('0.12.13', ATTIO_012);
    await listenRow({ movementId: movement, firedMovementName: 'gone' });
    expect((await deliver(sub, attioBody(randomUUID()), secret)).status).toBe(200);
    expect(await workOf('read_delivery')).toHaveLength(1);
    await drainUntilIdle({ teamId });
    expect(await receipts()).toEqual([]);
    expect(firing).not.toHaveBeenCalled();
  });

  describe('a dispatch_event row', () => {
    const event = (triggerId: string) => ({ pipelineInputId: `trigger:${triggerId}`, adapterType: 'attio', triggerType: 'webhook', payload: { a: 1 }, occurredAt: new Date().toISOString() });

    async function queueOldRow(triggerId: string) {
      const stored = await getAutomationsQb(['trigger_event'])
        .insertInto('trigger_event')
        .values({ team_id: teamId, trigger_id: triggerId, adapter_type: 'attio', trigger_type: 'webhook', payload: JSON.stringify(event(triggerId)) as never })
        .returning('id')
        .executeTakeFirstOrThrow();
      await getAutomationsQb(['work'])
        .insertInto('work')
        .values({ team_id: teamId, kind: 'dispatch_event', key: `dispatch_event:${stored.id}`, host: 'platform', due_at: new Date(), payload: JSON.stringify({ triggerId, teamId, triggerEvent: event(triggerId), storedEventId: stored.id, duplicate: false }) as never })
        .execute();
      return stored.id;
    }

    const receiptOf = (id: string) => getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('id', '=', id as never).select(['status', 'failure_reason']).executeTakeFirstOrThrow();

    it('a 0.12.13 door queued runs, with the listen switch off too', async () => {
        const triggerId = await listenRow({ movementId: await movementOn('0.12.13', ATTIO_012) });
      const receipt = await queueOldRow(triggerId);
      await drainUntilIdle({ teamId });
      expect(firing).toHaveBeenCalledTimes(1);
      expect((await receiptOf(receipt)).status).toBe('dispatched');
      expect(await workOf('dispatch_event')).toEqual([]);
    });

    it('run mode off keeps the receipt, suppressed, and fires nothing', async () => {
      const triggerId = await listenRow({ movementId: await movementOn('0.12.13', ATTIO_012), runMode: 'off' });
      const receipt = await queueOldRow(triggerId);
      await drainUntilIdle({ teamId });
      expect(firing).not.toHaveBeenCalled();
      expect((await receiptOf(receipt)).status).toBe('suppressed');
    });

    it('a loop guard pause stops it; a throttle holds the row and it fires later', async () => {
      const triggerId = await listenRow({ movementId: await movementOn('0.12.13', ATTIO_012) });
      guardEvaluate.mockResolvedValueOnce({ kind: 'throttle', enforced: true, reason: 'rate', retryAfterMs: 1 });
      const receipt = await queueOldRow(triggerId);
      await drainUntilIdle({ teamId });
      expect(firing).not.toHaveBeenCalled();
      expect((await receiptOf(receipt)).status).toBe('received');
      expect(await workOf('dispatch_event')).toHaveLength(1);
    });

    it('on a legacy id is refused by the firing, which says why and gives the remedy', async () => {
      const triggerId = await listenRow({ movementId: await movementOn('4', 'function a() {\n  return 1\n}\n') });
      const actual = jest.requireActual('../../translation_graph/movement/execute');
      firing.mockImplementationOnce(actual.runMovementFiring);
      const receipt = await queueOldRow(triggerId);
      await drainUntilIdle({ teamId });
      const { status, failure_reason } = await receiptOf(receipt);
      expect(status).toBe('failed');
      expect(failure_reason).toMatch(/starts no new run on versions 1 to 4: upgrade it to/);
    });
  });

  describe('0.12 listen rows', () => {
    const ECHO = 'function echo(run: <manual-[:Invocation]->>) {\n  t = run.Text\n  return t\n}\nlisten to manual fire echo\n';

    it('a save under 0.12 keeps one row per listen in production\'s shape, and the deploy check keeps them', async () => {
      const id = await movementOn('0.12.13', ECHO);
      const saved = await saveMovement({ teamId, id, source: ECHO });
      expect(saved.ok).toBe(true);
      const rows = await getAutomationsQb(['trigger']).selectFrom('trigger').where('movement_id', '=', id as MovementId).select(['id', 'kind', 'config', 'fired_movement_name']).execute();
      expect(rows.map((row) => [row.kind, row.fired_movement_name])).toEqual([['manual', 'echo']]);
      expect(rows[0]!.config).not.toHaveProperty('listen');

        const row = await getMovementRow({ teamId, id });
      await liveDeployCheckDeps(thisDeployCheckRelease('test')).unprovision(row!);
      expect(await getAutomationsQb(['trigger']).selectFrom('trigger').where('id', '=', rows[0]!.id).select('id').executeTakeFirst()).toBeDefined();
    });

    it('a Run now passes the manual listen\'s run mode and the loop guard', async () => {
      const id = await movementOn('0.12.13', ECHO);
      const row = (runId: string) => ({ teamId, movementId: id, movementName: 'echo', pin: '0.12.13', event: { pipelineInputId: 'trigger:x', adapterType: 'manual', triggerType: 'webhook', payload: {} }, runId });
      const status = (runId: string) => getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', runId as never).select(['status', 'failure_reason']).executeTakeFirst();

      // Throttled: held, the row retries; nothing is written.
      guardEvaluate.mockResolvedValueOnce({ kind: 'throttle', enforced: true, reason: 'rate', retryAfterMs: 1 });
      const held = randomUUID();
      await expect(carriedRunHandler.run(row(held), testWorkContext())).rejects.toThrow(WorkDeferred);
      expect(firing).not.toHaveBeenCalled();
      expect(await status(held)).toBeUndefined();

      // Paused by the guard: failed, naming why.
      guardEvaluate.mockResolvedValueOnce({ kind: 'pause', enforced: true, reason: 'budget', signal: 'team_runs' });
      const paused = randomUUID();
      await carriedRunHandler.run(row(paused), testWorkContext());
      expect(firing).not.toHaveBeenCalled();
      expect((await status(paused))?.status).toBe('failed');

      // Its row's run mode off: failed, naming why.
      await listenRow({ movementId: id, kind: 'manual', firedMovementName: 'echo', runMode: 'off' });
      const off = randomUUID();
      await carriedRunHandler.run(row(off), testWorkContext());
      expect(firing).not.toHaveBeenCalled();
      expect((await status(off))?.status).toBe('failed');
    });

    it('a Run now of a legacy id is refused, with the remedy', async () => {
      const id = await movementOn('4', 'function a() {\n  return 1\n}\n');
      const answer = await runMovementAsync({ teamId, movementId: id });
      expect(answer).toMatchObject({ ok: false, errors: [expect.stringMatching(/starts no new run on versions 1 to 4: upgrade it to/)] });
    });

    it('the deploy check names every automation on versions 1 to 4, and the runs paused on a key', async () => {
      const id = await movementOn('4', 'function a() {\n  return 1\n}\n');
      const version = await getAutomationsQb(['movement']).selectFrom('movement').where('id', '=', id as MovementId).select('current_version_id').executeTakeFirstOrThrow();
      const runId = randomUUID();
      await getAutomationsQb(['trigger_run'])
        .insertInto('trigger_run')
        .values({ id: runId as never, team_id: teamId, trigger_id: id, trigger_type: 'webhook', status: 'parked', movement_version_id: version.current_version_id as never })
        .execute();
      await getAutomationsQb(['adapter_await']).insertInto('adapter_await').values({ adapter_type: 'ask', correlation_key: randomUUID(), run_id: runId as never, team_id: teamId, address: 'a' }).execute();
      const row = await getMovementRow({ teamId, id });
      const deps = liveDeployCheckDeps(thisDeployCheckRelease(`k6a-${randomUUID()}`));
      const summary = await runDeployCheck({ ...deps, listMovements: async () => [row!], alreadyRan: async () => false, recordRun: async () => {}, emit: async () => {} });
      expect(summary?.legacyStopped).toEqual([expect.objectContaining({ movementId: id, pin: '4', waitingRuns: [runId], remedy: expect.stringMatching(/upgrade it to/) })]);
    });
  });

  it('a Slack reply wakes the 0.12 run parked on its thread, with the listen switch off', async () => {
    const key = 'C1:1700000000.000100';
    const runId = randomUUID();
    const movement = await movementOn('0.12.13', ATTIO_012);
    const version = await getAutomationsQb(['movement']).selectFrom('movement').where('id', '=', movement as MovementId).select('current_version_id').executeTakeFirstOrThrow();
    await getAutomationsQb(['trigger_run'])
      .insertInto('trigger_run')
      .values({ id: runId as never, team_id: teamId, trigger_id: movement, trigger_type: 'webhook', status: 'parked', movement_version_id: version.current_version_id as never })
      .execute();
    await getAutomationsQb(['adapter_await']).insertInto('adapter_await').values({ adapter_type: 'slack', correlation_key: key, run_id: runId as never, team_id: teamId, address: 'a' }).execute();
    const reply = { type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1700000001.000100', thread_ts: '1700000000.000100' } };
    const deliveryId = randomUUID();
    await sql`insert into automations.delivery (id, team_id, subscription_id, received_at, source, inline, events, event_count, request)
      values (${deliveryId}::uuid, ${teamId}::uuid, 'SLACK', now(), 'webhook', false, '[]'::jsonb, 0,
              ${JSON.stringify({ method: 'POST', path: '', query: '', headers: {}, body: Buffer.from(JSON.stringify(reply)).toString('base64') })}::text::jsonb)`.execute(getAutomationsQb(['delivery']));
    await readDeliveryHandler.run({ teamId, version: '0.12', adapterType: 'slack', credentialsId: null, deliveryId }, testWorkContext());
    const wakes = await workOf('wake_await');
    expect(wakes.map((wake) => wake.payload)).toEqual([{ adapterType: 'slack', teamId, correlationKey: expect.stringContaining('1700000000.000100') }]);
  });

  it('a public inbox key under 0.12 finds its claimant from the config', async () => {
    const movement = await movementOn('0.12.13', 'email = Email()\nfunction f(e: <email>) {\n  return 1\n}\nlisten to email { key: "Inbox" } fire f\n');
    const id = await listenRow({ movementId: movement, kind: 'email', config: { key: 'Inbox' }, firedMovementName: 'f' });
    expect((await findTriggerByInboundKey({ teamId, kinds: ['email'], key: 'inbox' }))?.id).toBe(id);
    // As the email door asks: by the kinds it dispatches, and the key as it was sent.
    expect((await findTriggerByInboundKey({ teamId, kinds: ['CUSTOM_EMAIL', 'MAILGUN', 'INBOUND_EMAIL'], key: 'Inbox' }))?.id).toBe(id);
  });

  it('an answer to a question a legacy run waits on is refused at the door, recording nothing', async () => {
    const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
    const askId = ask.id as unknown as string;
    const movement = await movementOn('4', 'function a() {\n  return 1\n}\n');
    const version = await getAutomationsQb(['movement']).selectFrom('movement').where('id', '=', movement as MovementId).select('current_version_id').executeTakeFirstOrThrow();
    const runId = randomUUID();
    await getAutomationsQb(['trigger_run'])
      .insertInto('trigger_run')
      .values({ id: runId as never, team_id: teamId, trigger_id: movement, trigger_type: 'webhook', status: 'parked', movement_version_id: version.current_version_id as never })
      .execute();
    await getAutomationsQb(['adapter_await']).insertInto('adapter_await').values({ adapter_type: 'ask', correlation_key: askId, run_id: runId as never, team_id: teamId, address: 'a' }).execute();
    const outcome = await answerAskByToken(ask.token, true);
    expect(outcome.kind).toBe('held');
    expect(outcome).toMatchObject({ message: expect.stringMatching(/cannot continue on this release/) });
    expect((await getAsk(ask.id))?.state).toBe('open');
  });
});
