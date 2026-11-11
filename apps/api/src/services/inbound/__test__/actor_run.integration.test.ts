// A run reading `Actor`, through the real firing against a real database: the
// trigger's dispatch, the firing, the engine, the host and the run recorder.
// Only the two network seams are faked: the team catalog's live introspection,
// built here by the static catalog (which offers `Actor` the way a team's does),
// and the module's I/O. The chat module resolves field names as a module does,
// so a field it never described is refused as drift: the failure a run reading
// `Actor` met before the host answered it.

import { randomUUID } from 'node:crypto';

jest.mock('../../translation_graph/movement/catalog', () => {
  const actual = jest.requireActual('../../translation_graph/movement/catalog');
  return { ...actual, runCatalogSnapshotForTeam: jest.fn() };
});
jest.mock('../../translation_graph/adapters/resolve', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/resolve');
  return { ...actual, resolveAdapter: jest.fn() };
});

import { LANGUAGE_VERSION } from 'movement-lang';
import { positionData } from 'movement-engine/public/catalog';
import { arrivalTriggerOf } from 'movement-engine/public/inbound';

import type { InstanceSchema } from 'movement-lang';
import type { Adapter } from 'movement-engine/public/adapter';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { teamIdSchema } from '../../../lib/team_id';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { seedTeamCredential } from '../../../test/harness/credentials';
import { resolveAdapter } from '../../translation_graph/adapters/resolve';
import { runCatalogSnapshotForTeam, snapshotOverManifests, staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { mintMovementVersionIfChanged } from '../../translation_graph/movement/version_store';
import { dispatchTriggerByIdEvent } from '../../translation_graph/triggers/router';

const replies = { Replies: { target: 'Message', writable: true } };

/** Slack's messages as the module describes them: they land on `Messages`. */
const SLACK_SCHEMA: InstanceSchema = {
  positions: { Message: { properties: { Text: 'text' }, edges: replies } },
  collections: { Messages: { target: 'Message', listenable: true } },
  writableRoots: { Message: { fields: { Text: 'text' }, resultShape: { externalId: 'text', Text: 'text' } } },
};

/** The same, where the module declares an `Actor` of its own. */
const OWN_ACTOR_SCHEMA: InstanceSchema = { ...SLACK_SCHEMA, positions: { Message: { properties: { Text: 'text', Actor: 'text' }, edges: replies } } };

/** A module that knows `fields` and refuses any other name as drift, the
 *  writes it was asked for and the fields it was asked to read. */
function chat(fields: readonly string[]): { adapter: Adapter; writes: Record<string, unknown>[]; reads: string[] } {
  const writes: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const adapter: Adapter = {
    adapterType: 'slack',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => ({ traversal: { incoming: true, edgeProperties: true }, resources: true }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => {
      reads.push(fieldId);
      if (!fields.includes(fieldId)) {
        throw new Error(`'${fieldId}' is not a known field of '${position.recordType}' in this connection — its schema has changed (drift).`);
      }
      const data = positionData(position);
      return typeof data === 'object' && data !== null ? (Reflect.get(data, fieldId) ?? null) : null;
    },
    getRelated: async () => [],
    createRecord: async (input) => {
      writes.push(input.fields);
      return { adapterType: 'slack', externalId: `reply-${writes.length}`, data: {} };
    },
    updateRecord: async () => {
      throw new Error('test: nothing is updated');
    },
    deleteRecord: async () => ({}),
  };
  return { adapter, writes, reads };
}

const said = (reply: string) =>
  ['chat = connect `@lf/slack` using acme_slack', '', 'function said(m: <chat-[:Messages]->>) {', `  write m-[:Replies]-> { Text: "${reply}" }`, '}', '', 'listen to chat-[:Messages]-> fire said'].join('\n');

const READS_ACTOR = said('member=${m.Actor?.Member} email=${m.Actor?.Email}');

/** What the door writes for a member's message. */
const PRIYA = { Id: 'U003', Email: 'priya@listen-fire.local', Domain: 'listen-fire.local', Member: true, Proven: true, User: 'user-1' };

let teamId: TeamId;
let credentialId: string;

beforeEach(async () => {
  teamId = teamIdSchema.parse(randomUUID());
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `actor-run-${teamId.slice(0, 8)}` }).execute();
  credentialId = await seedTeamCredential(teamId);
});

afterEach(async () => {
  await cleanupTeam(teamId);
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['movement_version']).deleteFrom('movement_version').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId).execute();
  jest.clearAllMocks();
});

/** The catalog the run is checked against: the module's schema, offered
 *  `Actor` as a team's catalog offers it. */
function catalogOver(schema: InstanceSchema): void {
  const snapshot = snapshotOverManifests(staticCatalogFromManifests({ credentials: { acme_slack: { adapters: ['slack'] } }, instanceSchemas: { slack: schema } }));
  jest.mocked(runCatalogSnapshotForTeam).mockResolvedValue({ snapshot, credentialIds: { acme_slack: credentialId }, notes: [] });
}

/** `source` saved and shipped on the current pin, fired by a Slack listen. */
async function shipped(source: string): Promise<TriggerId> {
  const movement = await getAutomationsQb(['movement'])
    .insertInto('movement')
    .values({ team_id: teamId, name: 'said', source, language_version: LANGUAGE_VERSION })
    .returning('id')
    .executeTakeFirstOrThrow();
  await mintMovementVersionIfChanged({ teamId, movementId: movement.id, source, languageVersion: LANGUAGE_VERSION });
  const trigger = await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    .values({ team_id: teamId, name: 'chat messages', kind: 'slack', movement_id: movement.id, fired_movement_name: 'said' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return trigger.id;
}

/** A Slack message as the door hands it to the run, its landing's fields as the door wrote them. */
function message(fields: Record<string, unknown>) {
  return arrivalTriggerOf({
    pipelineInputId: 'trigger:test',
    adapterType: 'slack',
    arrival: { edge: 'Messages', identity: 'C1:1.0', landing: { recordId: 'C1:1.0', recordType: 'Message', fields } },
    now: new Date(),
  });
}

async function ran(input: { schema: InstanceSchema; knows: readonly string[]; source: string; fields: Record<string, unknown> }) {
  catalogOver(input.schema);
  const module = chat(input.knows);
  jest.mocked(resolveAdapter).mockResolvedValue(module.adapter);
  const triggerId = await shipped(input.source);
  const result = await dispatchTriggerByIdEvent({ triggerId, teamId, event: message(input.fields) });
  return { errors: result.errors ?? [], writes: module.writes, reads: module.reads };
}

it('a handler on the current pin reads the Actor the door wrote, and the module is never asked for it', async () => {
  const run = await ran({ schema: SLACK_SCHEMA, knows: ['Text'], source: READS_ACTOR, fields: { Text: 'hi', Actor: PRIYA } });

  expect(run.errors).toEqual([]);
  expect(run.writes).toEqual([{ Text: 'member=true email=priya@listen-fire.local' }]);
  expect(run.reads).not.toContain('Actor');
});

it('reads no one on an arrival that named no one', async () => {
  const run = await ran({ schema: SLACK_SCHEMA, knows: ['Text'], source: READS_ACTOR, fields: { Text: 'hi' } });

  expect(run.errors).toEqual([]);
  expect(run.writes).toEqual([{ Text: 'member= email=' }]);
});

it('a module with an Actor of its own is still asked for it, and its answer is what the run reads', async () => {
  const run = await ran({ schema: OWN_ACTOR_SCHEMA, knows: ['Text', 'Actor'], source: said('actor=${m.Actor}'), fields: { Text: 'hi', Actor: 'bot-7' } });

  expect(run.errors).toEqual([]);
  expect(run.writes).toEqual([{ Text: 'actor=bot-7' }]);
  expect(run.reads).toContain('Actor');
});
