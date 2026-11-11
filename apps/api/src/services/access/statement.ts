// Access statements: who may read, write or fire one automation, and who may use
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

type Verb = 'read' | 'write' | 'fire' | 'use';

/** The verbs each thing's statement has: firing is an automation's, using is a connection's. */
type StatedVerb<T extends Thing> = T extends 'automation' ? 'read' | 'write' | 'fire' : 'use';

/** What a decision may be asked about. Firing is judged at the door, never here. */
type AskedVerb<T extends Thing> = Exclude<StatedVerb<T>, 'fire'>;

type Target<T extends Thing = Thing> = { thing: T; id: string };

/**
 * One entry on a verb's list. Reading, writing and using go to the team or to
 * named users; firing also admits outsiders, by domain, address or phone.
 */
type Grantee =
  | { kind: 'team' }
  | { kind: 'user'; userId: string }
  | { kind: 'anyone' }
  | { kind: 'domain'; domain: string }
  | { kind: 'email'; address: string }
  | { kind: 'phone'; digits: string };

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
    case 'anyone':
      return { grantee: grantee.kind, value: null };
    case 'user':
      return { grantee: 'user', value: grantee.userId };
    case 'domain':
      return { grantee: 'domain', value: grantee.domain };
    case 'email':
      return { grantee: 'email', value: grantee.address };
    case 'phone':
      return { grantee: 'phone', value: grantee.digits };
    default:
      return neverAsAny(grantee);
  }
}

function granteeOf(row: { grantee: string; value: string | null }): Grantee {
  const { grantee, value } = row;
  if (grantee === 'team' || grantee === 'anyone') return { kind: grantee };
  if (value === null) throw new Error(`An access statement's ${grantee} grant names nobody.`);
  if (grantee === 'user') return { kind: 'user', userId: value };
  if (grantee === 'domain') return { kind: 'domain', domain: value };
  if (grantee === 'email') return { kind: 'email', address: value };
  if (grantee === 'phone') return { kind: 'phone', digits: value };
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
  if (value === 'read' || value === 'write' || value === 'fire' || value === 'use') return value;
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
};

export {
  rowOf as storedRowOf,
  type Thing,
  type Verb,
  type StatedVerb,
  type AskedVerb,
  type Target,
  type Grantee,
  type GranteeKind,
  StatementStore,
};
