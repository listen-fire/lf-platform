// Who may reach one automation or one connection, as it is read to a person or
// an agent: an automation's read and write lists, a connection's use
// list, each entry a grantee as `setAccess` takes it, with who a named user is
// beside it. The callers decide whether the thing may be seen at all; this
// reads what is stated about a thing that exists.

import { currentPrincipal } from 'principal';
import { neverAsAny } from 'movement-engine/public/types';
import { z } from 'zod';

import type { UserId } from '../../generated/kysely/core/User';
import type { Grantee, StatedVerb, Target, Thing, Verb } from './statement';

import { getCoreQb } from '../../lib/kysely';
import { StatementStore } from './statement';
import { mayChangeStatement, seenOnlyBy } from './decide';

/** One entry on a list: a named user with who they are, anything else as stored. */
type ShownGrantee =
  | Exclude<Grantee, { kind: 'user' }>
  | { kind: 'user'; userId: string; name: string | null; email: string | null; onTeam: boolean };

/** The verbs a view lists: a fire list is no longer read or shown. */
type ListedVerb<T extends Thing> = Exclude<StatedVerb<T>, 'fire'>;

type Person = { name: string | null; email: string | null; onTeam: boolean };

type Shown<T extends Thing> = {
  thing: T;
  id: string;
  lists: Record<ListedVerb<T>, ShownGrantee[]>;
  /** Whether the caller may change these lists; otherwise they are read-only. */
  mayChange: boolean;
  /** Whether the lists that let someone see it admit the caller alone. */
  onlyYou: boolean;
  /** The caller's own user id as the lists store it, so a page can say "you". */
  viewerUserId: string | null;
};

type AccessView = Shown<'automation'> | Shown<'connection'>;

const AUTOMATION_VERBS = ['read', 'write'] as const satisfies readonly ListedVerb<'automation'>[];

const uuid = z.string().uuid();

function isUserId(id: string): id is UserId {
  return uuid.safeParse(id).success;
}

/**
 * Each user's name and primary address, for the ones that exist, and whether
 * they are on the team now: a list can still name someone who left it.
 */
async function peopleNamed(teamId: string, userIds: readonly string[]): Promise<Map<string, Person>> {
  const ids = [...new Set(userIds)].filter(isUserId);
  if (ids.length === 0) return new Map();
  const [users, emails, members] = await Promise.all([
    getCoreQb(['user']).selectFrom('user').select(['id', 'username']).where('id', 'in', ids).execute(),
    getCoreQb(['user_email'])
      .selectFrom('user_email')
      .select(['user_id', 'email'])
      .where('user_id', 'in', ids)
      .orderBy('is_primary', 'desc')
      .orderBy('created_at', 'asc')
      .execute(),
    StatementStore.membershipsAmong(teamId, ids),
  ]);
  return new Map(
    users.map((user) => {
      const email = emails.find((row) => row.user_id === user.id)?.email;
      return [String(user.id), { name: user.username, email: email === undefined ? null : String(email), onTeam: members.has(String(user.id)) }];
    }),
  );
}

function shown(grantee: Grantee, people: ReadonlyMap<string, Person>): ShownGrantee {
  switch (grantee.kind) {
    case 'user':
      return { ...grantee, ...(people.get(grantee.userId) ?? { name: null, email: null, onTeam: false }) };
    case 'team':
    case 'anyone':
    case 'domain':
    case 'email':
    case 'phone':
      return grantee;
    default:
      return neverAsAny(grantee);
  }
}

/** The thing's lists for these verbs as stored, with who each named user is. */
async function listsOf(target: Target, asked: { teamId: string; verbs: readonly Verb[] }): Promise<Map<Verb, ShownGrantee[]>> {
  const { teamId } = asked;
  const stored = await Promise.all(asked.verbs.map(async (verb) => [verb, await StatementStore.grantsOf(target, { teamId, verb })] as const));
  const people = await peopleNamed(teamId, stored.flatMap(([, list]) => list.flatMap((g) => (g.kind === 'user' ? [g.userId] : []))));
  return new Map(stored.map(([verb, list]) => [verb, list.map((g) => shown(g, people))]));
}

/** What every view says beside its lists, about a thing that exists on this team. */
async function standingOn(target: Target, teamId: string): Promise<Pick<AccessView, 'mayChange' | 'onlyYou' | 'viewerUserId'>> {
  const principal = currentPrincipal();
  const [mayChange, only] = await Promise.all([
    mayChangeStatement(principal, target),
    seenOnlyBy(principal, { thing: target.thing, teamId, ids: [target.id] }),
  ]);
  return { mayChange, onlyYou: only.has(target.id), viewerUserId: principal.userId?.toLowerCase() ?? null };
}

/** The automation's lists, or undefined when there is no such automation. */
async function automationView(id: string): Promise<Shown<'automation'> | undefined> {
  const target: Target<'automation'> = { thing: 'automation', id };
  const teamId = await StatementStore.teamOf(target);
  if (teamId === undefined) return undefined;
  const lists = await listsOf(target, { teamId, verbs: AUTOMATION_VERBS });
  return {
    thing: 'automation',
    id,
    lists: { read: lists.get('read') ?? [], write: lists.get('write') ?? [] },
    ...(await standingOn(target, teamId)),
  };
}

/** The connection's list, or undefined when there is no such connection. */
async function connectionView(id: string): Promise<Shown<'connection'> | undefined> {
  const target: Target<'connection'> = { thing: 'connection', id };
  const teamId = await StatementStore.teamOf(target);
  if (teamId === undefined) return undefined;
  const lists = await listsOf(target, { teamId, verbs: ['use'] });
  return { thing: 'connection', id, lists: { use: lists.get('use') ?? [] }, ...(await standingOn(target, teamId)) };
}

/** An automation's lists as an agent reads them: each list in the shape `setAccess` takes back. */
type AutomationAccess = Record<ListedVerb<'automation'>, ShownGrantee[]> & { mayChange: boolean; onlyYou: boolean };

/** A connection's list as an agent reads it. */
type ConnectionAccess = Record<ListedVerb<'connection'>, ShownGrantee[]> & { mayChange: boolean; onlyYou: boolean };

async function automationAccess(id: string): Promise<AutomationAccess | undefined> {
  const view = await automationView(id);
  return view === undefined
    ? undefined
    : { ...view.lists, mayChange: view.mayChange, onlyYou: view.onlyYou };
}

async function connectionAccess(id: string): Promise<ConnectionAccess | undefined> {
  const view = await connectionView(id);
  return view === undefined ? undefined : { ...view.lists, mayChange: view.mayChange, onlyYou: view.onlyYou };
}

export {
  automationView,
  connectionView,
  automationAccess,
  connectionAccess,
  type AccessView,
  type AutomationAccess,
  type ConnectionAccess,
  type Shown,
  type ShownGrantee,
};
