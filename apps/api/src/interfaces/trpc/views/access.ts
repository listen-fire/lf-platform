// Who may reach one automation or one connection, as the web reads and
// changes it: an automation's read, write and fire lists, a connection's use
// list. The same decisions as REST `setAccess`: reading the lists needs read
// on the automation (use on the connection), changing one needs write (use).
// What the caller may not see is answered as what is not there.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { currentPrincipal } from 'principal';
import { neverAsAny } from 'movement-engine/public/types';

import type { UserId } from '../../../generated/kysely/core/User';
import type { Grantee, StatedVerb, Target, Thing, Verb } from '../../../services/access/statement';

import { getCoreQb } from '../../../lib/kysely';
import { StatementStore } from '../../../services/access/statement';
import { StatementRefusedError, accessTo, mayChangeStatement, seenOnlyBy, setStatement, type StatementRefusal } from '../../../services/access/decide';
import { GranteesInput } from '../../../services/access/stated_input';
import { CHANGE_STATEMENT, decidesEach, type Decision } from '../../access_route';
import { cannotChange } from '../access';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { trpc } from '../trpc';

/** One entry on a list as the page shows it: a named user with who they are. */
type ShownGrantee =
  | Exclude<Grantee, { kind: 'user' }>
  | { kind: 'user'; userId: string; name: string | null; email: string | null; onTeam: boolean };

type Person = { name: string | null; email: string | null; onTeam: boolean };

type Shown<T extends Thing> = {
  thing: T;
  id: string;
  lists: Record<StatedVerb<T>, ShownGrantee[]>;
  /** Whether the caller may change these lists; otherwise the page shows them read-only. */
  mayChange: boolean;
  /** Whether the lists that let someone see it admit the caller alone. */
  onlyYou: boolean;
  /** The caller's own user id as the lists store it, so the page can say "you". */
  viewerUserId: string | null;
};

export type AccessView = Shown<'automation'> | Shown<'connection'>;

/**
 * A change of a list: the thing as it now stands, or why the list was refused.
 * The page says each reason in its own words, never the decision's text,
 * which is written for agents.
 */
export type SetResult = { ok: true; view: AccessView } | { ok: false; refusal: StatementRefusal };

const AUTOMATION_VERBS = ['read', 'write', 'fire'] as const satisfies readonly StatedVerb<'automation'>[];

const NOT_FOUND: Record<Thing, string> = {
  automation: 'That automation was not found.',
  connection: 'That connection was not found.',
};

const READ_ONLY_CONNECTION_MESSAGE = 'You may use this connection but not change who may.';

function notFound(thing: Thing): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message: NOT_FOUND[thing] });
}

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

async function automationView(id: string): Promise<Shown<'automation'>> {
  const target: Target<'automation'> = { thing: 'automation', id };
  const teamId = await StatementStore.teamOf(target);
  if (teamId === undefined) throw notFound('automation');
  const lists = await listsOf(target, { teamId, verbs: AUTOMATION_VERBS });
  return {
    thing: 'automation',
    id,
    lists: { read: lists.get('read') ?? [], write: lists.get('write') ?? [], fire: lists.get('fire') ?? [] },
    ...(await standingOn(target, teamId)),
  };
}

async function connectionView(id: string): Promise<Shown<'connection'>> {
  const target: Target<'connection'> = { thing: 'connection', id };
  const teamId = await StatementStore.teamOf(target);
  if (teamId === undefined) throw notFound('connection');
  const lists = await listsOf(target, { teamId, verbs: ['use'] });
  return { thing: 'connection', id, lists: { use: lists.get('use') ?? [] }, ...(await standingOn(target, teamId)) };
}

/** A list the decision refused, as the page is told it. */
function refusedList(error: unknown): SetResult {
  if (error instanceof StatementRefusedError) return { ok: false, refusal: error.refusal };
  throw error;
}

const ThingInput = z.object({ thing: z.enum(['automation', 'connection']), id: z.string() });

const SetInput = z.discriminatedUnion('thing', [
  z.object({ thing: z.literal('automation'), id: z.string(), verb: z.enum(AUTOMATION_VERBS), grantees: GranteesInput }),
  z.object({ thing: z.literal('connection'), id: z.string(), verb: z.literal('use'), grantees: GranteesInput }),
]);

const accessRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /** Who may reach the thing, and whether the caller may change that. */
    get: userProcedure.input(ThingInput).query(async ({ input }): Promise<AccessView> => {
      const principal = currentPrincipal();
      switch (input.thing) {
        case 'automation':
          if (!(await accessTo(principal, { target: { thing: 'automation', id: input.id }, verb: 'read' }))) throw notFound('automation');
          return automationView(input.id);
        case 'connection':
          if (!(await accessTo(principal, { target: { thing: 'connection', id: input.id }, verb: 'use' }))) throw notFound('connection');
          return connectionView(input.id);
        default:
          return neverAsAny(input.thing);
      }
    }),

    /** Replace one of the thing's lists, as the caller chose it. Answers with the thing as it now stands. */
    set: userProcedure.input(SetInput).mutation(async ({ input }): Promise<SetResult> => {
      const principal = currentPrincipal();
      switch (input.thing) {
        case 'automation': {
          if (await cannotChange(input.id)) throw notFound('automation');
          const target: Target<'automation'> = { thing: 'automation', id: input.id };
          try {
            await setStatement(principal, { target, verb: input.verb, grantees: input.grantees });
          } catch (error) {
            return refusedList(error);
          }
          return { ok: true, view: await automationView(input.id) };
        }
        case 'connection': {
          const target: Target<'connection'> = { thing: 'connection', id: input.id };
          if (!(await accessTo(principal, { target, verb: 'use' }))) throw notFound('connection');
          try {
            await setStatement(principal, { target, verb: input.verb, grantees: input.grantees });
          } catch (error) {
            // The caller may use it, so the one way this refuses them is that they only read on its team.
            if (error instanceof StatementRefusedError && error.refusal === 'not_allowed') {
              throw new TRPCError({ code: 'FORBIDDEN', message: READ_ONLY_CONNECTION_MESSAGE });
            }
            return refusedList(error);
          }
          return { ok: true, view: await connectionView(input.id) };
        }
        default:
          return neverAsAny(input);
      }
    }),
  });
};

const READS_THE_THING = { byTarget: { automation: 'read', connection: 'use' } } satisfies Decision;

decidesEach('access', {
  get: READS_THE_THING,
  set: CHANGE_STATEMENT,
});

export { accessRouter };
