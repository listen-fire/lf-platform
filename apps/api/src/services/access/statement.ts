// Access statements: who may read or write one automation, and who may use
// one connection (`automations.access_statement`). This file is the table and
// the memberships a decision reads beside it; what they mean is `decide.ts`'s.
//
// Statements live in `automations` and memberships in `core`, and the carve
// forbids one query across both, so the two are read separately.

import { sql } from 'kysely';
import { z } from 'zod';
import { isAccess, type Access } from 'principal';
import { neverAsAny } from 'movement-engine/public/types';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';
import type { MovementId } from '../../generated/kysely/automations/Movement';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb, getCoreQb } from '../../lib/kysely';

type Thing = 'automation' | 'connection';

type Verb = 'read' | 'write' | 'use';

/**
 * The verbs each thing's statement has: reading and writing are an automation's,
 * using is a connection's, and a file that exports (a library) has it too: use
 * lets someone import and call what it exports without reading its source.
 */
type StatedVerb<T extends Thing> = T extends 'automation' ? 'read' | 'write' | 'use' : 'use';

/** What someone may do with an automation's file itself: see it, or change it. Using it, as a library, is `use`. */
type FileVerb = 'read' | 'write';

type Target<T extends Thing = Thing> = { thing: T; id: string };

/** One entry on a verb's list: the team, or one person on it. */
type Grantee = { kind: 'team' } | { kind: 'user'; userId: string };

type GranteeKind = Grantee['kind'];

type StatementRow = { grantee: GranteeKind; value: string | null };

const uuid = z.string().uuid();

/** Postgres refuses a malformed uuid with an error; a decision about one is simply "no such thing". */
function isUuid(id: string): boolean {
  return uuid.safeParse(id).success;
}

function rowOf(grantee: Grantee): StatementRow {
  switch (grantee.kind) {
    case 'team':
      return { grantee: 'team', value: null };
    case 'user':
      return { grantee: 'user', value: grantee.userId };
    default:
      return neverAsAny(grantee);
  }
}

function granteeOf(row: { grantee: string; value: string | null }): Grantee {
  const { grantee, value } = row;
  if (grantee === 'team') return { kind: 'team' };
  if (grantee === 'user') {
    if (value === null) throw new Error("An access statement's user grant names nobody.");
    return { kind: 'user', userId: value };
  }
  throw new Error(`An access statement names an unknown kind of grantee: ${grantee}.`);
}

/** The team a thing belongs to, or undefined when there is no such thing. */
async function teamOf(target: Target): Promise<string | undefined> {
  if (!isUuid(target.id)) return undefined;
  switch (target.thing) {
    case 'automation': {
      const row = await getAutomationsQb(['movement'])
        .selectFrom('movement')
        .select('team_id')
        .where('id', '=', target.id as MovementId)
        .executeTakeFirst();
      return row?.team_id;
    }
    case 'connection': {
      const row = await getAutomationsQb(['external_service_credentials'])
        .selectFrom('external_service_credentials')
        .select('team_id')
        .where('id', '=', target.id as ExternalServiceCredentialsId)
        .executeTakeFirst();
      return row?.team_id;
    }
    default:
      return neverAsAny(target.thing);
  }
}

/** One verb's whole list on one thing, in no meaningful order. Empty when nothing has been stated. */
async function grantsOf(target: Target, options: { teamId: string; verb: Verb }): Promise<Grantee[]> {
  const rows = await getAutomationsQb(['access_statement'])
    .selectFrom('access_statement')
    .select(['grantee', 'value'])
    .where('team_id', '=', options.teamId)
    .where('thing', '=', target.thing)
    .where('thing_id', '=', target.id)
    .where('verb', '=', options.verb)
    .orderBy('grantee')
    .orderBy('value')
    .execute();
  return rows.map(granteeOf);
}

/** These verbs' lists on these things of one kind and team, by thing id. A thing with nothing stated is left out. */
async function grantsAmong(options: {
  thing: Thing;
  teamId: string;
  ids: readonly string[];
  verbs: readonly Verb[];
}): Promise<Map<string, { verb: Verb; grantee: Grantee }[]>> {
  const ids = options.ids.filter(isUuid);
  if (ids.length === 0 || options.verbs.length === 0) return new Map();
  const rows = await getAutomationsQb(['access_statement'])
    .selectFrom('access_statement')
    .select(['thing_id', 'verb', 'grantee', 'value'])
    .where('team_id', '=', options.teamId)
    .where('thing', '=', options.thing)
    .where('thing_id', 'in', ids)
    .where('verb', 'in', [...options.verbs])
    .execute();
  const lists = new Map<string, { verb: Verb; grantee: Grantee }[]>();
  for (const row of rows) {
    const list = lists.get(row.thing_id) ?? [];
    list.push({ verb: verbOf(row.verb), grantee: granteeOf(row) });
    lists.set(row.thing_id, list);
  }
  return lists;
}

/**
 * Replace one verb's whole list on one thing. Its delete and insert commit
 * together, and two replacements of the same list take turns rather than
 * merging into a list nobody stated.
 */
async function replaceGrants(
  target: Target,
  options: { teamId: string; verb: Verb; grantees: readonly Grantee[] },
): Promise<void> {
  const db = getAutomationsQb(['access_statement']);
  const replace = async (trx: typeof db) => {
    const list = [target.thing, target.id, options.verb].join(String.fromCharCode(31));
    await sql`select pg_advisory_xact_lock(hashtextextended(${list}::text, 0))`.execute(trx);
    await trx
      .deleteFrom('access_statement')
      .where('thing', '=', target.thing)
      .where('thing_id', '=', target.id)
      .where('verb', '=', options.verb)
      .execute();
    await trx
      .insertInto('access_statement')
      .values(
        options.grantees.map((grantee) => ({
          team_id: options.teamId,
          thing: target.thing,
          thing_id: target.id,
          verb: options.verb,
          ...rowOf(grantee),
        })),
      )
      .execute();
  };
  await (db.isTransaction ? replace(db) : db.transaction().execute(replace));
}

/** The things of one kind, in these teams, whose list for `verb` names the team or this user. */
async function grantedIds(options: {
  thing: Thing;
  verb: Verb;
  teamIds: readonly string[];
  userId: string | undefined;
}): Promise<Set<string>> {
  if (options.teamIds.length === 0) return new Set();
  const { userId } = options;
  const rows = await getAutomationsQb(['access_statement'])
    .selectFrom('access_statement')
    .select('thing_id')
    .distinct()
    .where('team_id', 'in', options.teamIds)
    .where('thing', '=', options.thing)
    .where('verb', '=', options.verb)
    .where((eb) =>
      userId === undefined
        ? eb('grantee', '=', 'team')
        : eb.or([eb('grantee', '=', 'team'), eb.and([eb('grantee', '=', 'user'), eb('value', '=', userId)])]),
    )
    .execute();
  return new Set(rows.map((r) => r.thing_id));
}

/** Every list in a team that names this user. */
async function listsNaming(options: {
  teamId: string;
  userId: string;
}): Promise<{ target: Target; verb: Verb }[]> {
  const rows = await getAutomationsQb(['access_statement'])
    .selectFrom('access_statement')
    .select(['thing', 'thing_id', 'verb'])
    .where('team_id', '=', options.teamId)
    .where('grantee', '=', 'user')
    .where('value', '=', options.userId)
    .execute();
  return rows.map((row) => ({ target: { thing: thingOf(row.thing), id: row.thing_id }, verb: verbOf(row.verb) }));
}

function thingOf(value: string): Thing {
  if (value === 'automation' || value === 'connection') return value;
  throw new Error(`An access statement names an unknown thing: ${value}.`);
}

function verbOf(value: string): Verb {
  if (value === 'read' || value === 'write' || value === 'use') return value;
  throw new Error(`An access statement names an unknown verb: ${value}.`);
}

function accessOf(value: string): Access {
  if (isAccess(value)) return value;
  throw new Error(`A team membership has an unknown access level: ${value}.`);
}

/** This user's access on each of these teams they are a member of. */
async function membershipsOf(userId: string, teamIds: readonly string[]): Promise<Map<string, Access>> {
  if (teamIds.length === 0 || !isUuid(userId)) return new Map();
  const rows = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select(['team_id', 'access'])
    .where('user_id', '=', userId as UserId)
    .where('team_id', 'in', teamIds.filter(isUuid).map((id) => id as TeamId))
    .execute();
  return new Map(rows.map((r) => [String(r.team_id), accessOf(r.access)]));
}

/** The access each of these users has on the team, for those who are members. */
async function membershipsAmong(teamId: string, userIds: readonly string[]): Promise<Map<string, Access>> {
  const candidates = userIds.filter(isUuid);
  if (candidates.length === 0) return new Map();
  const rows = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select(['user_id', 'access'])
    .where('team_id', '=', teamId as TeamId)
    .where('user_id', 'in', candidates.map((id) => id as UserId))
    .execute();
  return new Map(rows.map((r) => [String(r.user_id), accessOf(r.access)]));
}

/** Every member of the team, with their access there. */
async function membersOf(teamId: string): Promise<Map<string, Access>> {
  if (!isUuid(teamId)) return new Map();
  const rows = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select(['user_id', 'access'])
    .where('team_id', '=', teamId as TeamId)
    .execute();
  return new Map(rows.map((r) => [String(r.user_id), accessOf(r.access)]));
}

/** Whether anything at all is stated about a thing, for any verb. */
async function hasAnyStatement(target: Target): Promise<boolean> {
  const row = await getAutomationsQb(['access_statement'])
    .selectFrom('access_statement')
    .select('id')
    .where('thing', '=', target.thing)
    .where('thing_id', '=', target.id)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Delete everything stated about a thing that is itself deleted, in the
 * caller's transaction when it has one, so the two go together and the table
 * and a team's export never name a thing that is gone.
 */
async function deleteStatementsOf(target: Target, options: { teamId: string }): Promise<void> {
  await getAutomationsQb(['access_statement'])
    .deleteFrom('access_statement')
    .where('team_id', '=', options.teamId)
    .where('thing', '=', target.thing)
    .where('thing_id', '=', target.id)
    .execute();
}

/**
 * Move everything stated about one thing onto another that takes its place,
 * as it was stated: nothing is checked again, so a list naming someone who has
 * since left moves as it is. Whether anything moved.
 */
async function carryStatements(from: Target, to: Target, options: { teamId: string }): Promise<boolean> {
  const moved = await getAutomationsQb(['access_statement'])
    .updateTable('access_statement')
    .set({ thing_id: to.id })
    .where('team_id', '=', options.teamId)
    .where('thing', '=', from.thing)
    .where('thing_id', '=', from.id)
    .executeTakeFirst();
  return moved.numUpdatedRows > 0n;
}

/** What a thing is called, for a sentence that names it. */
async function nameOf(target: Target): Promise<string> {
  switch (target.thing) {
    case 'automation': {
      const row = await getAutomationsQb(['movement'])
        .selectFrom('movement')
        .select('name')
        .where('id', '=', target.id as MovementId)
        .executeTakeFirst();
      return row?.name ?? target.id;
    }
    case 'connection': {
      const row = await getAutomationsQb(['external_service_credentials'])
        .selectFrom('external_service_credentials')
        .select('name')
        .where('id', '=', target.id as ExternalServiceCredentialsId)
        .executeTakeFirst();
      return row?.name ?? target.id;
    }
    default:
      return neverAsAny(target.thing);
  }
}

/** The automations of a team that have a use list: the files that export. */
async function librariesOf(teamId: string): Promise<string[]> {
  const rows = await getAutomationsQb(['access_statement'])
    .selectFrom('access_statement')
    .select('thing_id')
    .distinct()
    .where('team_id', '=', teamId)
    .where('thing', '=', 'automation')
    .where('verb', '=', 'use')
    .execute();
  return rows.map((r) => r.thing_id);
}

/** What a file names directly: the connections its own `connect` statements name, and the libraries its own import lines name. Whatever does not resolve is left out. */
type DirectNames = { connections: Target<'connection'>[]; libraries: Target<'automation'>[] };

/**
 * The file's direct names, read from its stored text. The reading belongs to
 * the translation graph, which itself decides through this store, so it is
 * loaded when asked for rather than when this file is.
 */
async function namedBy(target: Target<'automation'>): Promise<DirectNames> {
  const { directNamesOf } = await import('../translation_graph/movement/save_access');
  return directNamesOf(target.id);
}

/** Whether the file's stored text exports anything: it is a library, and has a use list. */
async function exportsSomething(target: Target<'automation'>): Promise<boolean> {
  const { fileExportsSomething } = await import('../translation_graph/movement/save_access');
  return fileExportsSomething(target.id);
}

/** Where a library stands: undefined when it has not been worked out. `lostConnectionId` is null when it stands. */
async function standingsOf(ids: readonly string[]): Promise<Map<string, { lostConnectionId: string | null }>> {
  const wanted = ids.filter(isUuid);
  if (wanted.length === 0) return new Map();
  const rows = await getAutomationsQb(['library_standing'])
    .selectFrom('library_standing')
    .select(['movement_id', 'lost_connection_id'])
    .where('movement_id', 'in', wanted.map((id) => id as MovementId))
    .execute();
  return new Map(rows.map((r) => [r.movement_id, { lostConnectionId: r.lost_connection_id }]));
}

async function setStanding(
  target: Target<'automation'>,
  options: { teamId: string; lostConnectionId: string | null },
): Promise<void> {
  const lost = options.lostConnectionId === null ? null : (options.lostConnectionId as ExternalServiceCredentialsId);
  await getAutomationsQb(['library_standing'])
    .insertInto('library_standing')
    .values({ team_id: options.teamId, movement_id: target.id as MovementId, lost_connection_id: lost })
    .onConflict((oc) => oc.column('movement_id').doUpdateSet({ lost_connection_id: lost, checked_at: sql`now()` }))
    .execute();
}

/** The team's admins, oldest first. */
async function adminsOf(teamId: string): Promise<string[]> {
  const rows = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select('user_id')
    .where('team_id', '=', teamId as TeamId)
    .where('access', '=', 'admin')
    .orderBy('created_at')
    .execute();
  return rows.map((r) => String(r.user_id));
}

const StatementStore = {
  teamOf,
  grantsOf,
  grantsAmong,
  replaceGrants,
  grantedIds,
  listsNaming,
  hasAnyStatement,
  deleteStatementsOf,
  carryStatements,
  membershipsOf,
  membershipsAmong,
  membersOf,
  adminsOf,
  librariesOf,
  exportsSomething,
  nameOf,
  namedBy,
  standingsOf,
  setStanding,
};

export {
  rowOf as storedRowOf,
  type Thing,
  type Verb,
  type StatedVerb,
  type FileVerb,
  type Target,
  type Grantee,
  type GranteeKind,
  type DirectNames,
  StatementStore,
};
