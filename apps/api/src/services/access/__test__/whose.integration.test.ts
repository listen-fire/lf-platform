// Which automation owns a run, a listen or a question, against a REAL
// database: each answer comes from the rows the engine writes, and nothing
// outside the asked teams is found.

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION } from 'movement-lang';
import { ASK_ADAPTER_TYPE, RESPONSE_EDGE_NAME } from '@listen-fire/ask';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { AskId } from '../../../generated/kysely/asks/Ask';

import { getAsksQb, getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { mintMovementVersionIfChanged } from '../../translation_graph/movement/version_store';
import { Whose } from '../whose';

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

async function makeRun(teamId: TeamId, run: { triggerId: string; versionId?: string }): Promise<string> {
  const id = randomUUID() as TriggerRunId;
  await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id, team_id: teamId, trigger_id: run.triggerId, trigger_type: 'webhook', status: 'running', movement_version_id: run.versionId ?? null } as any)
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

  it('finds a firing’s automation by the trigger id its run records, before the run row exists', async () => {
    const listen = await makeListen(teamId, deals);
    expect(await Whose.automationOfTriggerId({ triggerId: listen, teamIds: [teamId] })).toEqual({ teamId, automationId: deals });
    expect(await Whose.automationOfTriggerId({ triggerId: notes, teamIds: [teamId] })).toEqual({ teamId, automationId: notes });
    expect(await Whose.automationOfTriggerId({ triggerId: 'listen:Deals:deals', teamIds: [teamId] })).toEqual({ teamId, automationId: deals });
  });

  it('finds a question’s automation by the run waiting on it, else by what the engine recorded', async () => {
    const run = await makeRun(teamId, { triggerId: await makeListen(teamId, notes) });
    const waited = await makeAsk(teamId, {});
    await getAutomationsQb(['wait_row'])
      .insertInto('wait_row')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ run_id: run, team_id: teamId, adapter_type: ASK_ADAPTER_TYPE, edge: RESPONSE_EDGE_NAME, key: waited, since: 0 } as any)
      .execute();
    const recorded = await makeAsk(teamId, { movementId: deals });
    const nobodys = await makeAsk(teamId, {});
    const elsewhere = await makeAsk(teamId, { movementId: randomUUID() });

    const owners = await Whose.automationsOfAsks({ askIds: [waited, recorded, nobodys, elsewhere], teamIds: [teamId] });
    expect(owners.get(waited)).toEqual({ teamId, automationId: notes });
    expect(owners.get(recorded)).toEqual({ teamId, automationId: deals });
    expect(owners.get(nobodys)).toEqual({ teamId, automationId: null });
    expect(owners.get(elsewhere)).toEqual({ teamId, automationId: null });
    expect(await Whose.automationOfAsk({ askId: waited, teamIds: [otherTeam] })).toBeUndefined();
  });
});
