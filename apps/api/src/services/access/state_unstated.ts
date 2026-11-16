// Giving what exists before statements the reach it has always had. A thing
// with no statement admits nobody, so every automation and connection saved
// before statements, and every team imported from a bundle cut before them,
// is stated once with the lists a creation with no person gets
// (`no_person.ts`). Written over a bare client so it runs inside an import's
// transaction as well as in the deploy step that states the rest.

import type { Client } from 'pg';

import type { StatedList } from './decide';
import type { Thing } from './statement';

import { automationLists, automationWithNoPerson, connectionWithNoPerson } from './no_person';
import { storedRowOf } from './statement';
import { movementFileFacets } from '../translation_graph/movement/files';

type Unstated = { automations: string[]; connections: string[] };

/**
 * What a run stated: the automations and connections that had no statement at
 * all, and the libraries (files that export) given a use list.
 */
type StatedThings = Unstated & { libraries: string[] };

// A cheap cut before the parser looks: a line that starts with `export`.
const MAY_EXPORT = String.raw`t.source ~ '(^|\n)[ \t]*export[ \t]'`;

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
     UNION
     SELECT t.team_id::text FROM automations.movement t
      WHERE ${MAY_EXPORT}
        AND NOT EXISTS (SELECT 1 FROM automations.access_statement s WHERE s.thing = 'automation' AND s.thing_id = t.id AND s.verb = 'use')
     ORDER BY 1`,
  );
  return rows.rows.map((r) => r.team_id);
}

/** Whether anything of this team has been stated: on a later run, an unstated thing is a creation that forgot to say. */
async function teamHasStatements(client: Client, teamId: string): Promise<boolean> {
  const found = await client.query(
    `SELECT 1 FROM automations.access_statement WHERE team_id = $1::uuid LIMIT 1`,
    [teamId],
  );
  return (found.rowCount ?? 0) > 0;
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
 * Returns the ids of the things it stated.
 */
async function stateWhatIsUnstated(client: Client, teamId: string): Promise<StatedThings> {
  const unstated = await unstatedIn(client, teamId);

  const stated: StatedThings = { automations: [], connections: [], libraries: [] };
  for (const id of unstated.automations) {
    const lists = automationLists(automationWithNoPerson());
    if (await stateIfStillUnstated(client, { teamId, thing: 'automation', id, lists }))
      stated.automations.push(id);
  }
  for (const id of unstated.connections) {
    const lists: StatedList<'connection'>[] = [
      { verb: 'use', grantees: connectionWithNoPerson().use },
    ];
    if (await stateIfStillUnstated(client, { teamId, thing: 'connection', id, lists }))
      stated.connections.push(id);
  }
  stated.libraries = await stateLibraryUse(client, teamId);
  return stated;
}

/**
 * Give every file of one team that exports and has no use list a use list
 * equal to who may read it today (the read list and the write list, since
 * whoever may write may read), so the importers it has keep importing.
 * Returns the ids it stated; a file with a use list is never touched.
 */
async function stateLibraryUse(client: Client, teamId: string): Promise<string[]> {
  const candidates = await client.query<{ id: string; source: string; language_version: string }>(
    `SELECT t.id::text AS id, t.source, t.language_version FROM automations.movement t
      WHERE t.team_id = $1::uuid AND ${MAY_EXPORT}
        AND NOT EXISTS (SELECT 1 FROM automations.access_statement s WHERE s.thing = 'automation' AND s.thing_id = t.id AND s.verb = 'use')`,
    [teamId],
  );
  const stated: string[] = [];
  for (const { id, source, language_version } of candidates.rows) {
    if (!movementFileFacets(source, language_version).isLibrary) continue;
    const written = await client.query(
      `INSERT INTO automations.access_statement (team_id, thing, thing_id, verb, grantee, value)
       SELECT DISTINCT s.team_id, s.thing, s.thing_id, 'use', s.grantee, s.value
         FROM automations.access_statement s
        WHERE s.thing = 'automation' AND s.thing_id = $1::uuid AND s.verb IN ('read', 'write')
          AND NOT EXISTS (SELECT 1 FROM automations.access_statement u WHERE u.thing = 'automation' AND u.thing_id = $1::uuid AND u.verb = 'use')`,
      [id],
    );
    if ((written.rowCount ?? 0) > 0) stated.push(id);
  }
  return stated;
}

export {
  stateWhatIsUnstated,
  stateLibraryUse,
  unstatedIn,
  teamsWithUnstated,
  teamHasStatements,
  type StatedThings,
};
