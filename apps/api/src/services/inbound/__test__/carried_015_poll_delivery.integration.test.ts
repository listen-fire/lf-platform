// A carried poll keeps its page as a delivery (real Postgres, the real poll
// worker, judging and drains), as the current version's poll keeps its own:
// Project A's 0.15 automations on v0.16.1 ran from their 06:00 cron tick and
// from a `Release Applied`, yet their arrivals listed neither, since nothing
// named a delivery for those runs.
//
//   - a cron tick and a `Release Applied` polled under 0.15's own keys are each
//     kept as a delivery of their poll, and listed among their automation's
//     arrivals with it and the event's index, on its page and in REST;
//   - a replay of one reruns it through 0.15's own reading, once, and run with
//     this event runs it on its pin;
//   - a poll that fails after its page was kept keeps none of it, and a page
//     polled again fires nothing twice: its receipts are kept once, each
//     named by the cursor polled from and the arrival's own key;
//   - a page polled again from the same cursor, with an item the first
//     lacked, fires that item once (a current poll names its page by no
//     external id either, so nothing drops the page whole);
//   - two carried listens sharing one poll each fire once from its one
//     delivery, both listed with it, and why-didn't-this-fire judges it for
//     each by 0.15's own judge;
//   - a carried page is kept as this release reads arrivals, keeping what
//     0.15 adds to them, and one in another shape is refused.

import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import express from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { runWithPrincipal } from 'principal';
import { RELEASE_APPLIED } from '@listen-fire/system';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { teamIdSchema } from '../../../lib/team_id';
import { triggerIdSchema } from '../../../lib/trigger_id';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { listArrivalsHandler } from '../../../interfaces/rest/v1/knowledge_agent_tools';
import { setStatement } from '../../access/decide';
import { userPrincipal } from '../../principal';
import { ProvisioningService } from '../../provisioning';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { listWorkByKind, removeWork } from '../../work/store';
import { registerCarriedRunWork } from '../../translation_graph/movement/carried_run_now';
import { saveMovement } from '../../translation_graph/movement/provision';
import { runWithEvent } from '../../translation_graph/movement/run_now';
import { registerDispatchWork } from '../../translation_graph/triggers/dispatch_event';
import { automationsUrl, recordSystemEvent } from '../../translation_graph/adapters/system/events';
import { pollEdgeHandler, pollSubscriptionId, sharedPolls, type SharedPoll } from '../../poll_source/worker';
import * as carriedDelivery from '../carried_delivery';
import { movementEventsImpl } from '../arrival_ledger';
import { explainDeliveryArrival } from '../explain_arrival';
import { replayThroughListen } from '../listen_replay';

/** Project A's schedule: one tick a day, so a cursor a day old misses one. */
const CRON_015 =
  'import { cron } from adapters\nclock = connect cron\n' +
  'function tick(t: <clock-[:Tick]->>) {\n  at = t.`Fired at`\n  return at\n}\n' +
  'listen to clock-[t:Ticks WHERE t.Schedule == "0 6 * * *"]-> fire tick\n';

const SYSTEM_015 =
  'import { system } from adapters\nsys = connect system\n' +
  'function released(e: <sys-[:Events]->>) {\n  said = e.Reason\n  return said\n}\n' +
  'listen to sys-[e:Events WHERE e.Kind == "Release Applied"]-> fire released\n';

const movementIdOf = z.custom<MovementId>((value) => z.guid().safeParse(value).success);
const arrivalsSchema = z.object({ arrivals: z.array(z.record(z.string(), z.unknown())) });

let rest: Server;
let restUrl = '';
let teamId: TeamId;
let admin: UserId;

const asAdmin = () => userPrincipal({ userId: admin, teamId, access: 'admin' });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function drainAll(): Promise<void> {
  for (let pass = 0; pass < 5; pass++) {
    const drained = await drainUntilIdle({ owner: 'carried-poll-delivery', teamId });
    if (drained.claimed === 0) return;
  }
}

/** A 0.15.3 automation of `source`, saved under 0.15, readable and writable by the team. */
async function automation015(name: string, source: string): Promise<{ movementId: MovementId; triggerId: TriggerId; poll: SharedPoll }> {
  const movementId = movementIdOf.parse(randomUUID());
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name, source, description: '', language_version: '0.15.3' }).execute();
  const saved = await saveMovement({ audience: { for: 'run' }, teamId, id: movementId, source });
  if (!saved.ok) throw new Error(`test: the 0.15 automation did not save: ${JSON.stringify(saved)}`);
  const triggerId = triggerIdSchema.parse(saved.listeners[0]?.triggerId);
  await runWithPrincipal(asAdmin(), async () => {
    await setStatement(asAdmin(), { target: { thing: 'automation', id: movementId }, verb: 'read', grantees: [{ kind: 'team' }] });
    await setStatement(asAdmin(), { target: { thing: 'automation', id: movementId }, verb: 'write', grantees: [{ kind: 'team' }] });
  });
  const poll = (await sharedPolls({ teamId })).find((shared) => shared.carried.some((listen) => listen.triggerId === triggerId));
  if (poll === undefined) throw new Error('test: the 0.15 listen shares no poll');
  expect(poll.key.version).toBe('0.15');
  return { movementId, triggerId, poll };
}

async function keepCursor(poll: SharedPoll, checkpoint: unknown): Promise<void> {
  await sql`insert into automations.inbound_checkpoint (team_id, subscription_id, checkpoint)
    values (${teamId}::uuid, ${pollSubscriptionId(poll.digest)}::text, ${JSON.stringify(checkpoint)}::text::jsonb)
    on conflict (team_id, subscription_id) do update set checkpoint = excluded.checkpoint`.execute(getAutomationsQb(['inbound_checkpoint']));
}

async function cursorOf(poll: SharedPoll): Promise<unknown> {
  const { rows } = await sql<{ checkpoint: unknown }>`
    select checkpoint from automations.inbound_checkpoint
    where team_id = ${teamId}::uuid and subscription_id = ${pollSubscriptionId(poll.digest)}::text`.execute(getAutomationsQb(['inbound_checkpoint']));
  return rows[0]?.checkpoint;
}

/** One run of the poll worker's handler for the key, as the drain runs it. */
async function pollOnce(poll: SharedPoll): Promise<void> {
  await pollEdgeHandler.run({ teamId, digest: poll.digest }, { now: new Date(), owner: 'carried-poll-delivery', attempts: 1, heartbeat: async () => {} });
}

/** The deliveries a poll kept, oldest first. */
const deliveriesOf = (poll: SharedPoll) =>
  getAutomationsQb(['delivery'])
    .selectFrom('delivery')
    .where('team_id', '=', teamId)
    .where('subscription_id', '=', pollSubscriptionId(poll.digest))
    .select(['id', 'source', 'replay_of as replayOf'])
    .orderBy('received_at')
    .execute();

/** Whether a receipt is of the `Release Applied` of `version`: a carried poll's
 *  receipt is named by the cursor its page was polled from and the arrival's
 *  own key (its edge, record, identity and version). */
const ofRelease = (version: string) => (receipt: { eventId: string | null }) => receipt.eventId?.endsWith(`:Events::release_applied:${version}:`) === true;

const receiptsOf = (triggerId: TriggerId) =>
  getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('trigger_id', '=', triggerId)
    .select(['status', 'delivery_id as deliveryId', 'external_event_id as eventId'])
    .orderBy('created_at')
    .execute();

const runsOf = (triggerId: TriggerId) =>
  getAutomationsQb(['trigger_run', 'movement_version'])
    .selectFrom('trigger_run')
    .innerJoin('movement_version', 'movement_version.id', 'trigger_run.movement_version_id')
    .where('trigger_run.trigger_id', '=', triggerId)
    .select(['trigger_run.id as id', 'trigger_run.status as status', 'trigger_run.delivery_id as deliveryId', 'movement_version.language_version as pin'])
    .orderBy('trigger_run.started_at')
    .execute();

/** REST `arrivals` for an automation, as its route answers it over HTTP. */
async function restArrivals(movementId: MovementId): Promise<Array<Record<string, unknown>>> {
  const answered = await fetch(`${restUrl}/automations/${movementId}/arrivals`);
  expect(answered.status).toBe(200);
  return arrivalsSchema.parse(await answered.json()).arrivals;
}

async function released(version: string, at: string): Promise<void> {
  await recordSystemEvent({ teamId, kind: RELEASE_APPLIED, payload: { automation: '', automationId: '', runId: '', version, reason: `Release v${version} applied.`, url: automationsUrl(), at } });
}

beforeAll(async () => {
  const app = express();
  app.get('/automations/:idOrName/arrivals', (req, res, next) =>
    runWithPrincipal(asAdmin(), async () => {
      await listArrivalsHandler(req, res, next);
    }),
  );
  rest = createServer(app);
  await new Promise<void>((resolve) => rest.listen(0, '127.0.0.1', resolve));
  const { port } = z.custom<AddressInfo>((value) => typeof value === 'object' && value !== null && 'port' in value).parse(rest.address());
  restUrl = `http://127.0.0.1:${port}`;

  resetWorkHandlersForTests();
  registerDispatchWork();
  registerCarriedRunWork();
  setWorkNotifier({ notify() {} });

  teamId = teamIdSchema.parse(randomUUID());
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `carried-poll-delivery-${teamId.slice(0, 8)}` }).execute();
  admin = (await ProvisioningService.provisionUser({ teamId, email: 'ada@example.com', access: 'admin' })).userId;
});

afterAll(async () => {
  setWorkNotifier(inProcessNotifier);
  resetWorkHandlersForTests();
  for (const row of await listWorkByKind('poll_edge')) if (row.teamId === teamId) await removeWork({ key: row.key });
  await new Promise<void>((resolve) => rest.close(() => resolve()));
  await cleanupTeam(teamId);
});

describe('a carried poll keeps its page as a delivery, as a current one does (real Postgres)', () => {
  let cron: Awaited<ReturnType<typeof automation015>>;
  let system: Awaited<ReturnType<typeof automation015>>;
  let tickDelivery: string;
  let releaseDelivery: string;

  it("Project A's two: a 0.15 cron tick and a 0.15 `Release Applied` run, and their automations' arrivals list each run with the delivery its poll kept", async () => {
    cron = await automation015('ticker', CRON_015);
    system = await automation015('releases', SYSTEM_015);
    // A day unpolled: of what the schedule missed, only its latest tick fires.
    await keepCursor(cron.poll, minutesAgo(25 * 60));
    await keepCursor(system.poll, { releases: { at: minutesAgo(10), version: '' } });
    await released('0.16.1', minutesAgo(5));

    await pollOnce(cron.poll);
    await pollOnce(system.poll);
    await drainAll();

    for (const [{ movementId, triggerId, poll }, name] of [
      [cron, 'tick'],
      [system, 'release'],
    ] as const) {
      const deliveries = await deliveriesOf(poll);
      expect({ name, deliveries }).toEqual({ name, deliveries: [expect.objectContaining({ source: 'poll', replayOf: null })] });
      const deliveryId = deliveries[0]!.id;
      expect(await receiptsOf(triggerId)).toEqual([expect.objectContaining({ deliveryId })]);
      const runs = await runsOf(triggerId);
      expect(runs).toEqual([expect.objectContaining({ status: 'success', pin: '0.15.3', deliveryId })]);

      expect(await movementEventsImpl({ teamId, movementId })).toEqual([expect.objectContaining({ status: 'ran', triggerId, deliveryId, arrivalIndex: 0 })]);
      expect(await restArrivals(movementId)).toEqual([expect.objectContaining({ listen: triggerId, deliveryId, arrivalIndex: 0, status: 'ran', runId: runs[0]?.id })]);
      if (name === 'tick') tickDelivery = deliveryId;
      else releaseDelivery = deliveryId;
    }
  });

  it("a replay of the tick reruns it through 0.15's own reading, once; run with this event runs the release on its pin", async () => {
    const unforced = await replayThroughListen({ teamId, triggerId: cron.triggerId, deliveryId: tickDelivery });
    expect(unforced).toEqual(expect.objectContaining({ outcome: 'replayed', runIds: [], lines: [expect.stringContaining('before: nothing replayed')] }));

    const forced = await replayThroughListen({ teamId, triggerId: cron.triggerId, deliveryId: tickDelivery, force: true });
    if (forced.outcome !== 'replayed') throw new Error(forced.reason);
    expect(forced.runIds).toHaveLength(1);

    const run = await runWithPrincipal(asAdmin(), () => runWithEvent({ teamId, automationId: system.movementId, deliveryId: releaseDelivery, arrivalIndex: 0, by: { userId: admin } }));
    if (!run.ok) throw new Error(run.errors.join('; '));
    expect(run.runIds).toHaveLength(1);
    await drainAll();

    const ticks = await runsOf(cron.triggerId);
    expect(ticks).toHaveLength(2);
    expect(ticks.find((candidate) => candidate.id === forced.runIds[0])).toEqual(expect.objectContaining({ status: 'success', pin: '0.15.3', deliveryId: forced.replayDeliveryId }));
    const releases = await runsOf(system.triggerId);
    expect(releases).toHaveLength(2);
    expect(releases.find((candidate) => candidate.id === run.runIds[0])).toEqual(expect.objectContaining({ status: 'success', pin: '0.15.3' }));
    // The replay is listed as of the delivery it replays.
    expect((await movementEventsImpl({ teamId, movementId: cron.movementId })).map((event) => event.deliveryId)).toEqual([tickDelivery, tickDelivery]);
  });

  it('a poll that fails after its page was kept keeps none of it; the retry keeps the page once and fires once, and a page polled again from its cursor fires nothing twice', async () => {
    const from = await cursorOf(system.poll);
    await released('0.16.2', minutesAgo(4));
    const receiptsBefore = (await receiptsOf(system.triggerId)).length;
    const deliveriesBefore = (await deliveriesOf(system.poll)).length;

    const failing = jest.spyOn(carriedDelivery, 'judgeCarriedPage').mockRejectedValueOnce(new Error('the judge fell over'));
    try {
      await expect(pollOnce(system.poll)).rejects.toThrow('the judge fell over');
    } finally {
      failing.mockRestore();
    }
    expect(await deliveriesOf(system.poll)).toHaveLength(deliveriesBefore);
    expect(await receiptsOf(system.triggerId)).toHaveLength(receiptsBefore);
    expect(await cursorOf(system.poll)).toEqual(from);

    await pollOnce(system.poll);
    await drainAll();
    const kept = await deliveriesOf(system.poll);
    expect(kept).toHaveLength(deliveriesBefore + 1);
    const receipts = await receiptsOf(system.triggerId);
    expect(receipts).toHaveLength(receiptsBefore + 1);
    expect(receipts.filter(ofRelease('0.16.2'))).toEqual([expect.objectContaining({ deliveryId: kept.at(-1)?.id })]);
    const runs = (await runsOf(system.triggerId)).length;

    // Polled again from the cursor it was polled from: the same page, kept
    // again as a current poll keeps every page it judges, and judged again.
    // What fires once is the receipt, kept once under its name.
    await keepCursor(system.poll, from);
    await pollOnce(system.poll);
    await drainAll();
    expect(await deliveriesOf(system.poll)).toHaveLength(kept.length + 1);
    expect(await receiptsOf(system.triggerId)).toEqual(receipts);
    expect(await runsOf(system.triggerId)).toHaveLength(runs);
  });

  it('a page polled again from the cursor it was polled from fires the item the first page lacked, once', async () => {
    const from = await cursorOf(system.poll);
    const deliveriesBefore = (await deliveriesOf(system.poll)).length;
    await released('0.16.3', minutesAgo(3));
    await pollOnce(system.poll);
    await drainAll();
    // Back where it was polled from, as a module leaves it that answers the
    // cursor it was asked from, or none: its next page is polled from it again,
    // and holds what the first held and more.
    await keepCursor(system.poll, from);
    await released('0.16.4', minutesAgo(2));
    await pollOnce(system.poll);
    await drainAll();

    const receipts = await receiptsOf(system.triggerId);
    expect(receipts.filter(ofRelease('0.16.4'))).toHaveLength(1);
    const deliveries = (await deliveriesOf(system.poll)).slice(deliveriesBefore).map((delivery) => delivery.id);
    expect(deliveries).toHaveLength(2);
    const [third, fourth] = deliveries;
    expect(receipts.filter(ofRelease('0.16.3'))).toEqual([expect.objectContaining({ deliveryId: third })]);
    expect(receipts.filter(ofRelease('0.16.4'))).toEqual([expect.objectContaining({ deliveryId: fourth })]);
    const runs = await runsOf(system.triggerId);
    expect(runs.filter((run) => run.deliveryId === third || run.deliveryId === fourth)).toEqual([
      expect.objectContaining({ status: 'success', pin: '0.15.3', deliveryId: third }),
      expect.objectContaining({ status: 'success', pin: '0.15.3', deliveryId: fourth }),
    ]);
    expect(await cursorOf(system.poll)).not.toEqual(from);
  });

  it("two carried listens sharing one poll each fire once from its one delivery, both listed with it; why-didn't-this-fire judges it for each by 0.15's judge", async () => {
    const twin = await automation015('releases-too', SYSTEM_015);
    expect(twin.poll.digest).toBe(system.poll.digest);
    const from = await cursorOf(system.poll);
    const deliveriesBefore = (await deliveriesOf(system.poll)).length;
    await released('0.16.5', minutesAgo(1));

    await pollOnce(system.poll);
    await drainAll();
    const deliveries = await deliveriesOf(system.poll);
    expect(deliveries).toHaveLength(deliveriesBefore + 1);
    const deliveryId = deliveries.at(-1)!.id;
    for (const { movementId, triggerId } of [system, twin]) {
      expect((await receiptsOf(triggerId)).filter(ofRelease('0.16.5'))).toEqual([expect.objectContaining({ deliveryId })]);
      const runs = (await runsOf(triggerId)).filter((run) => run.deliveryId === deliveryId);
      expect(runs).toEqual([expect.objectContaining({ status: 'success', pin: '0.15.3' })]);
      expect((await movementEventsImpl({ teamId, movementId })).filter((event) => event.deliveryId === deliveryId)).toEqual([
        expect.objectContaining({ status: 'ran', triggerId, arrivalIndex: 0 }),
      ]);
      expect((await restArrivals(movementId)).filter((arrival) => arrival['deliveryId'] === deliveryId)).toEqual([
        expect.objectContaining({ listen: triggerId, runId: runs[0]?.id, arrivalIndex: 0 }),
      ]);
    }

    // Polled again from where it was polled: each listen's receipt is kept once.
    const receipts = [await receiptsOf(system.triggerId), await receiptsOf(twin.triggerId)];
    await keepCursor(system.poll, from);
    await pollOnce(system.poll);
    await drainAll();
    expect([await receiptsOf(system.triggerId), await receiptsOf(twin.triggerId)]).toEqual(receipts);

    const explained = await runWithPrincipal(asAdmin(), () => explainDeliveryArrival({ teamId, deliveryId, arrivalIndex: 0 }));
    if (!explained.ok) throw new Error(explained.errors.join('; '));
    expect(explained).toEqual(expect.objectContaining({ deliveryId, arrivalIndex: 0, edge: 'Events' }));
    expect([...explained.listens].sort((a, b) => a.listen.localeCompare(b.listen))).toEqual(
      [
        { automationId: system.movementId, automationName: 'releases', listen: system.triggerId, verdict: 'fires', hostAnswers: { used: false } },
        { automationId: twin.movementId, automationName: 'releases-too', listen: twin.triggerId, verdict: 'fires', hostAnswers: { used: false } },
      ].sort((a, b) => a.listen.localeCompare(b.listen)),
    );
  });

  it("a carried page is kept as this release reads arrivals, with the member 0.15 adds (who acted); one this release cannot read is refused, and nothing is kept", async () => {
    const [kept] = (await deliveriesOf(system.poll)).slice(-1);
    const { rows } = await sql<{ request: unknown }>`select request from automations.delivery where id = ${kept?.id}::uuid`.execute(getAutomationsQb(['delivery']));
    const page = z.object({ arrivals: z.array(z.record(z.string(), z.unknown())).min(1) }).parse(rows[0]?.request);
    const actor = { identifier: 'ada@example.com', scheme: 'email' };
    const subscriptionId = pollSubscriptionId(system.poll.digest);
    const deliveriesBefore = (await deliveriesOf(system.poll)).length;

    const id = await carriedDelivery.keepCarriedPage({ teamId, adapterType: 'system', credentialsId: null, subscriptionId, page: page.arrivals.map((arrival) => ({ ...arrival, actor })) });
    const { rows: keptRows } = await sql<{ request: unknown }>`select request from automations.delivery where id = ${id}::uuid`.execute(getAutomationsQb(['delivery']));
    expect(keptRows[0]?.request).toEqual({ adapter: 'system', arrivals: page.arrivals.map((arrival) => ({ ...arrival, actor })) });

    const unread = [{ edge: 'Events', identity: 'release_applied:0.16.7', landing: { fields: 'not a record' } }];
    await expect(carriedDelivery.keepCarriedPage({ teamId, adapterType: 'system', credentialsId: null, subscriptionId, page: unread })).rejects.toThrow(
      "system: a carried poll's page is not one this release reads as arrivals",
    );
    expect(await deliveriesOf(system.poll)).toHaveLength(deliveriesBefore + 1);
  });
});
