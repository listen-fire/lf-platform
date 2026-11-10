// Giving what exists before statements the reach it has always had. A thing
// with no statement admits nobody, so every automation and connection saved
// before statements, and every team imported from a bundle cut before them,
// is stated once with the lists a creation with no person gets
// (`no_person.ts`). Written over a bare client so it runs inside an import's
// transaction as well as in the deploy step that states the rest.

import type { Client } from 'pg';

import type { StatedList } from './decide';
import type { Thing } from './statement';

import {
  automationLists,
  automationWithNoPerson,
  connectionWithNoPerson,
  type ListenReach,
} from './no_person';
import { storedRowOf } from './statement';

type Unstated = { automations: string[]; connections: string[] };

/** What a run stated: automations and connections that had no statement at all. */
type StatedCounts = { automations: number; connections: number };

// A thing with any statement was stated by a person, or by its creation since
// statements existed: it is never touched here.
const UNSTATED = (table: 'movement' | 'external_service_credentials', thing: Thing) =>
  `SELECT t.id::text AS id FROM automations.${table} t
    WHERE t.team_id = $1::uuid
      AND NOT EXISTS (SELECT 1 FROM automations.access_statement s WHERE s.thing = '${thing}' AND s.thing_id = t.id)`;

/** The automations and connections of one team that have no statement. */
async function unstatedIn(client: Client, teamId: string): Promise<Unstated> {
  const automations = await client.query<{ id: string }>(UNSTATED('movement', 'automation'), [
    teamId,
  ]);
  const connections = await client.query<{ id: string }>(
    UNSTATED('external_service_credentials', 'connection'),
    [teamId],
  );
  return {
    automations: automations.rows.map((r) => r.id),
    connections: connections.rows.map((r) => r.id),
  };
}

/** Every team that has an automation or a connection with no statement. */
async function teamsWithUnstated(client: Client): Promise<string[]> {
  const rows = await client.query<{ team_id: string }>(
    `SELECT DISTINCT t.team_id::text AS team_id FROM (
       SELECT team_id, id, 'automation' AS thing FROM automations.movement
       UNION ALL
       SELECT team_id, id, 'connection' AS thing FROM automations.external_service_credentials
     ) t
     WHERE NOT EXISTS (SELECT 1 FROM automations.access_statement s WHERE s.thing = t.thing AND s.thing_id = t.id)
     ORDER BY 1`,
  );
  return rows.rows.map((r) => r.team_id);
}

/** Whether the team's automations run on lf, whose door the platform does not judge. */
async function teamRunsOnLf(client: Client, teamId: string): Promise<boolean> {
  const engine = await client.query<{ engine: string }>(
    `SELECT engine FROM automations.team_engine WHERE team_id = $1::uuid`,
    [teamId],
  );
  return engine.rows.some((r) => r.engine === 'lf');
}

/** The listens of these automations, each by its module and whether it hears through a connection of the team's own. */
async function listensOf(
  client: Client,
  teamId: string,
  movementIds: readonly string[],
): Promise<Map<string, ListenReach[]>> {
  const listens = await client.query<{
    movement_id: string;
    kind: string;
    via_connection: boolean;
  }>(
    `SELECT movement_id::text AS movement_id, kind, credentials_id IS NOT NULL AS via_connection
       FROM automations.trigger WHERE team_id = $1::uuid AND movement_id = ANY($2::uuid[])`,
    [teamId, movementIds],
  );
  const byMovement = new Map<string, ListenReach[]>();
  for (const listen of listens.rows) {
    byMovement.set(listen.movement_id, [
      ...(byMovement.get(listen.movement_id) ?? []),
      { module: listen.kind, viaConnection: listen.via_connection },
    ]);
  }
  return byMovement;
}

/**
 * State one thing's lists, unless something has been stated about it since it
 * was read as unstated. One statement checks and writes, so a thing is either
 * given all its lists or left as it is.
 */
async function stateIfStillUnstated<T extends Thing>(
  client: Client,
  stated: { teamId: string; thing: T; id: string; lists: readonly StatedList<T>[] },
): Promise<boolean> {
  const { teamId, thing, id, lists } = stated;
  const rows = lists.flatMap((list) =>
    list.grantees.map((grantee) => ({ verb: list.verb, ...storedRowOf(grantee) })),
  );
  const written = await client.query(
    `INSERT INTO automations.access_statement (team_id, thing, thing_id, verb, grantee, value)
     SELECT $1::uuid, $2, $3::uuid, v.verb, v.grantee, v.value
       FROM unnest($4::text[], $5::text[], $6::text[]) AS v(verb, grantee, value)
      WHERE NOT EXISTS (SELECT 1 FROM automations.access_statement s WHERE s.thing = $2 AND s.thing_id = $3::uuid)`,
    [
      teamId,
      thing,
      id,
      rows.map((r) => r.verb),
      rows.map((r) => r.grantee),
      rows.map((r) => r.value),
    ],
  );
  return (written.rowCount ?? 0) > 0;
}

/**
 * Give everything of one team that has no statement at all the reach a
 * creation with no person gets. Nobody is choosing: this keeps what the team
 * has today. A thing with a statement keeps it, so a second run changes nothing.
 */
async function stateWhatIsUnstated(client: Client, teamId: string): Promise<StatedCounts> {
  const unstated = await unstatedIn(client, teamId);
  const runsOnLf = await teamRunsOnLf(client, teamId);
  const listensByAutomation = await listensOf(client, teamId, unstated.automations);

  const counts: StatedCounts = { automations: 0, connections: 0 };
  for (const id of unstated.automations) {
    const lists = automationLists(
      automationWithNoPerson({ listens: listensByAutomation.get(id) ?? [], runsOnLf }),
    );
    if (await stateIfStillUnstated(client, { teamId, thing: 'automation', id, lists }))
      counts.automations += 1;
  }
  for (const id of unstated.connections) {
    const lists: StatedList<'connection'>[] = [
      { verb: 'use', grantees: connectionWithNoPerson().use },
    ];
    if (await stateIfStillUnstated(client, { teamId, thing: 'connection', id, lists }))
      counts.connections += 1;
  }
  return counts;
}

export {
  stateWhatIsUnstated,
  unstatedIn,
  teamsWithUnstated,
  teamRunsOnLf,
  listensOf,
  type StatedCounts,
};
