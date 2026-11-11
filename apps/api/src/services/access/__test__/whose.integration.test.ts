// Which automation owns a run, a listen, a question or what a delivery
// reached, against a REAL database: each answer comes from the rows the engine
// and its host write, nothing outside the asked teams is found, and what
// cannot be traced is left out.

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION } from 'movement-lang';
import { ASK_ADAPTER_TYPE, RESPONSE_EDGE_NAME, responseTypeId } from '@listen-fire/ask';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { AskId } from '../../../generated/kysely/asks/Ask';

import { getAsksQb, getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { mintMovementVersionIfChanged } from '../../translation_graph/movement/version_store';
import { runWriteKeeper } from '../../movement_engine/run_writes';
import { recordAsker } from '../../asks/store';
import { Whose } from '../whose';

/** What the ask module records of a question a run raised: the engine's write names only the adapter the run fired on. */
const ENGINE_ASKED = { adapterType: 'manual' };

async function makeTeam(): Promise<TeamId> {
  const teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    .values({ id: teamId, name: `whose-${teamId.slice(0, 8)}` })
    .execute();
  return teamId;
}

async function makeMovement(teamId: TeamId, name: string): Promise<MovementId> {
  const id = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id, team_id: teamId, name, source: 'x', language_version: LANGUAGE_VERSION } as any)
    .execute();
  return id;
}

async function makeListen(teamId: TeamId, movementId: MovementId | null): Promise<TriggerId> {
  const id = randomUUID() as TriggerId;
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id, team_id: teamId, name: 'listen', kind: 'manual', movement_id: movementId } as any)
    .execute();
  return id;
}

async function makeRun(teamId: TeamId, run: { triggerId: string; versionId?: string; deliveryId?: string }): Promise<string> {
  const id = randomUUID() as TriggerRunId;
  await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    .values({
      id,
      team_id: teamId,
      trigger_id: run.triggerId,
      trigger_type: 'webhook',
      status: 'running',
      movement_version_id: run.versionId ?? null,
      delivery_id: run.deliveryId ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .execute();
  return id;
}

async function makeDelivery(teamId: TeamId, options: { replayOf?: string } = {}): Promise<string> {
  const id = randomUUID();
  await getAutomationsQb(['delivery'])
    .insertInto('delivery')
    .values({
      id,
      team_id: teamId,
      subscription_id: 'sub',
      received_at: new Date(),
      source: 'webhook',
      inline: false,
      replay_of: options.replayOf ?? null,
      events: JSON.stringify([]),
      event_count: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .execute();
  return id;
}

async function makeAsk(teamId: TeamId, provenance: Record<string, string>): Promise<string> {
  const id = randomUUID() as AskId;
  await getAsksQb(['ask'])
    .insertInto('ask')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id, team_id: teamId, family: 'Check', prompt: 'ok?', token: `ask_${id}`, token_expires_at: new Date(Date.now() + 60_000), provenance: JSON.stringify(provenance) } as any)
    .execute();
  return id;
}

describe('whose — the automation behind a run, a listen or a question', () => {
  let teamId: TeamId;
  let otherTeam: TeamId;
  let deals: MovementId;
  let notes: MovementId;

  beforeEach(async () => {
    teamId = await makeTeam();
    otherTeam = await makeTeam();
    deals = await makeMovement(teamId, 'Deals');
    notes = await makeMovement(teamId, 'Notes');
  });

  afterEach(async () => {
    await getAutomationsQb(['adapter_await']).deleteFrom('adapter_await').where('team_id', 'in', [teamId, otherTeam]).execute();
    await cleanupTeam(teamId);
    await cleanupTeam(otherTeam);
  });

  it('finds a listen’s automation, a listen of none, and nothing outside the teams asked', async () => {
    const listen = await makeListen(teamId, deals);
    const orphan = await makeListen(teamId, null);
    const owners = await Whose.automationsOfListens({ triggerIds: [listen, orphan, 'not-a-uuid'], teamIds: [teamId] });
    expect(owners.get(listen)).toEqual({ teamId, automationId: deals });
    expect(owners.get(orphan)).toEqual({ teamId, automationId: null });
    expect(owners.has('not-a-uuid')).toBe(false);
    expect(await Whose.automationOfListen({ triggerId: listen, teamIds: [otherTeam] })).toBeUndefined();
  });

  it('finds a run’s automation by its version, its listen, its own id, or its queued row', async () => {
    const version = await mintMovementVersionIfChanged({ teamId, movementId: deals, source: 'x', languageVersion: LANGUAGE_VERSION });
    const byVersion = await makeRun(teamId, { triggerId: 'gone', versionId: version.versionId });
    const byListen = await makeRun(teamId, { triggerId: await makeListen(teamId, notes) });
    const byOwnId = await makeRun(teamId, { triggerId: deals });
    const queued = randomUUID();
    await getAutomationsQb(['work'])
      .insertInto('work')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ team_id: teamId, kind: 'run_carried', key: `run_carried:${queued}`, payload: JSON.stringify({ runId: queued, movementId: notes }) } as any)
      .execute();

    const owners = await Whose.automationsOfRuns({ runIds: [byVersion, byListen, byOwnId, queued], teamIds: [teamId] });
    expect(owners.get(byVersion)).toEqual({ teamId, automationId: deals });
    expect(owners.get(byListen)).toEqual({ teamId, automationId: notes });
    expect(owners.get(byOwnId)).toEqual({ teamId, automationId: deals });
    expect(owners.get(queued)).toEqual({ teamId, automationId: notes });
    expect(await Whose.automationOfRun({ runId: byListen, teamIds: [otherTeam] })).toBeUndefined();
  });

  it('leaves out a run whose automation cannot be traced, as one that is not there', async () => {
    const gone = await makeRun(teamId, { triggerId: randomUUID() });
    const owners = await Whose.automationsOfRuns({ runIds: [gone], teamIds: [teamId] });
    expect(owners.has(gone)).toBe(false);
    expect(await Whose.automationOfTriggerId({ triggerId: randomUUID(), teamIds: [teamId] })).toBeUndefined();
  });

  // Ruling 54: the listen is the team's, so what it starts is too.
  it('gives a run of a listen with no automation, and the question it asks, to the team', async () => {
    const orphanListen = await makeListen(teamId, null);
    const run = await makeRun(teamId, { triggerId: orphanListen });
    expect(await Whose.automationOfRun({ runId: run, teamIds: [teamId] })).toEqual({ teamId, automationId: null });
    expect(await Whose.automationOfTriggerId({ triggerId: orphanListen, teamIds: [teamId] })).toEqual({ teamId, automationId: null });

    const asked = await makeAsk(teamId, ENGINE_ASKED);
    await runWriteKeeper({ teamId, runId: run })({ adapterType: ASK_ADAPTER_TYPE, recordType: 'Check', externalId: asked, at: new Date().toISOString() });
    expect(await Whose.automationOfAsk({ askId: asked, teamIds: [teamId] })).toEqual({ teamId, automationId: null });
  });

  it('finds a firing’s automation by the trigger id its run records, before the run row exists', async () => {
    const listen = await makeListen(teamId, deals);
    expect(await Whose.automationOfTriggerId({ triggerId: listen, teamIds: [teamId] })).toEqual({ teamId, automationId: deals });
    expect(await Whose.automationOfTriggerId({ triggerId: notes, teamIds: [teamId] })).toEqual({ teamId, automationId: notes });
    expect(await Whose.automationOfTriggerId({ triggerId: 'listen:Deals:deals', teamIds: [teamId] })).toEqual({ teamId, automationId: deals });
  });

  it('finds a question’s automation by the run parked on it, under this release or a carried one', async () => {
    const run = await makeRun(teamId, { triggerId: await makeListen(teamId, notes) });
    const waited = await makeAsk(teamId, ENGINE_ASKED);
    await getAutomationsQb(['wait_row'])
      .insertInto('wait_row')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ run_id: run, team_id: teamId, adapter_type: ASK_ADAPTER_TYPE, edge: RESPONSE_EDGE_NAME, key: waited, since: 0 } as any)
      .execute();
    const carried = await makeAsk(teamId, ENGINE_ASKED);
    await getAutomationsQb(['adapter_await'])
      .insertInto('adapter_await')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ adapter_type: ASK_ADAPTER_TYPE, correlation_key: carried, run_id: run, team_id: teamId, address: 'a' } as any)
      .execute();

    const owners = await Whose.automationsOfAsks({ askIds: [waited, carried], teamIds: [teamId] });
    expect(owners.get(waited)).toEqual({ teamId, automationId: notes });
    expect(owners.get(carried)).toEqual({ teamId, automationId: notes });
    expect(await Whose.automationOfAsk({ askId: waited, teamIds: [otherTeam] })).toBeUndefined();
  });

  it('finds a settled question’s automation by the run its engine host recorded as it was asked', async () => {
    const run = await makeRun(teamId, { triggerId: await makeListen(teamId, notes) });
    const asked = await makeAsk(teamId, ENGINE_ASKED);
    // The write the run's module answered, as both engine hosts keep it.
    await runWriteKeeper({ teamId, runId: run })({ adapterType: ASK_ADAPTER_TYPE, recordType: 'Check', externalId: asked, at: new Date().toISOString() });

    const row = await getAsksQb(['ask']).selectFrom('ask').where('id', '=', asked as AskId).select('provenance').executeTakeFirstOrThrow();
    expect(row.provenance).toEqual({ ...ENGINE_ASKED, runId: run, movementId: notes });
    // No wait stands once the run is done: the record alone says whose it is.
    expect(await Whose.automationOfAsk({ askId: asked, teamIds: [teamId] })).toEqual({ teamId, automationId: notes });

    // Its automation is still known with the run's listen and version gone.
    await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('id', '=', run as TriggerRunId).execute();
    expect(await Whose.automationOfAsk({ askId: asked, teamIds: [teamId] })).toEqual({ teamId, automationId: notes });
  });

  it('keeps the asker a question already names, and records nothing of an answer', async () => {
    const first = await makeRun(teamId, { triggerId: await makeListen(teamId, notes) });
    const second = await makeRun(teamId, { triggerId: await makeListen(teamId, deals) });
    const asked = await makeAsk(teamId, ENGINE_ASKED);
    await recordAsker({ teamId, askId: asked, runId: first, automationId: notes });
    await recordAsker({ teamId, askId: asked, runId: second, automationId: deals });
    const answered = await makeAsk(teamId, ENGINE_ASKED);
    await runWriteKeeper({ teamId, runId: second })({ adapterType: ASK_ADAPTER_TYPE, recordType: responseTypeId('Check'), externalId: answered, at: new Date().toISOString() });

    const owners = await Whose.automationsOfAsks({ askIds: [asked, answered], teamIds: [teamId] });
    expect(owners.get(asked)).toEqual({ teamId, automationId: notes });
    expect(owners.has(answered)).toBe(false);
  });

  it('leaves out a settled question a run asked that names no owner, and keeps a REST caller’s for the team', async () => {
    const unowned = await makeAsk(teamId, ENGINE_ASKED);
    const elsewhere = await makeAsk(teamId, { ...ENGINE_ASKED, movementId: randomUUID() });
    const callers = await makeAsk(teamId, {});

    const owners = await Whose.automationsOfAsks({ askIds: [unowned, elsewhere, callers], teamIds: [teamId] });
    expect(owners.has(unowned)).toBe(false);
    expect(owners.has(elsewhere)).toBe(false);
    expect(owners.get(callers)).toEqual({ teamId, automationId: null });
  });

  it('finds every automation a delivery reached, its replays’ included, and says when one cannot be traced', async () => {
    const delivery = await makeDelivery(teamId);
    const replay = await makeDelivery(teamId, { replayOf: delivery });
    await makeRun(teamId, { triggerId: await makeListen(teamId, deals), deliveryId: delivery });
    await makeRun(teamId, { triggerId: await makeListen(teamId, notes), deliveryId: replay });
    expect(await Whose.automationsReachedBy({ deliveryId: delivery, teamIds: [teamId] })).toEqual({
      automationIds: new Set([deals, notes]),
      untraced: false,
    });
    expect(await Whose.automationsReachedBy({ deliveryId: delivery, teamIds: [otherTeam] })).toEqual({ automationIds: new Set(), untraced: false });

    const lost = await makeDelivery(teamId);
    await makeRun(teamId, { triggerId: randomUUID(), deliveryId: lost });
    expect((await Whose.automationsReachedBy({ deliveryId: lost, teamIds: [teamId] })).untraced).toBe(true);
  });
});
