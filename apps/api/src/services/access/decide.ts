// The one decision about an automation or a connection: may this principal
// read it, write it, or use it. Firing is judged at the door instead, from the
// arrival's actor, so it is never asked here.
//
// A statement sits beside team membership, never in place of it. The database
// pool already holds a read member to reads, so membership caps every answer
// and a statement only ever narrows what membership allows.

import { logger } from 'movement-engine/public/log';
import { neverAsAny } from 'movement-engine/public/types';

import type { Access, Principal } from 'principal';

import { StatementStore, type AskedVerb, type Grantee, type StatedVerb, type Target, type Thing, type Verb } from './statement';

type StatementRefusal = 'empty' | 'not_found' | 'not_allowed' | 'outsider' | 'not_a_member' | 'malformed';

class StatementRefusedError extends Error {
  readonly refusal: StatementRefusal;

  constructor(refusal: StatementRefusal, message: string) {
    super(message);
    this.name = 'StatementRefusedError';
    this.refusal = refusal;
  }
}

/** Who the principal is on one team: its access there, and the user a grant may name. */
type Standing = { access: Access; userId: string | undefined };

function narrower(a: Access, b: Access): Access {
  return a === 'write' && b === 'write' ? 'write' : 'read';
}

/**
 * The principal's standing on each of these teams it may act in at all. A user
 * stands on a team by membership there; a principal with no user stands only
 * on its own team, as its own access. A credential pinned to one team stands
 * nowhere else.
 */
async function standingsIn(principal: Principal, teamIds: readonly string[]): Promise<Map<string, Standing>> {
  const reachable = [...new Set(teamIds)].filter(
    (teamId) => principal.pinnedTeamId === null || principal.pinnedTeamId === teamId,
  );
  const { userId } = principal;
  if (userId === undefined) {
    return new Map(
      reachable
        .filter((teamId) => teamId === principal.teamId)
        .map((teamId) => [teamId, { access: principal.access, userId: undefined }]),
    );
  }
  const memberships = await StatementStore.membershipsOf(userId, reachable);
  // On its own team a principal never exceeds the access it arrived with: the
  // request's database pool was chosen by that, and this must not disagree.
  return new Map(
    [...memberships].map(([teamId, access]) => [
      teamId,
      { access: teamId === principal.teamId ? narrower(access, principal.access) : access, userId },
    ]),
  );
}

/** The team access a verb needs before any statement is read. Undefined for firing, which this never answers. */
function floorOf(verb: Verb): Access | undefined {
  switch (verb) {
    case 'read':
    case 'use':
      return 'read';
    case 'write':
      return 'write';
    case 'fire':
      return undefined;
    default:
      return neverAsAny(verb);
  }
}

function admits(grantee: Grantee, standing: Standing): boolean {
  switch (grantee.kind) {
    case 'team':
      return true;
    case 'user':
      return standing.userId !== undefined && grantee.userId === standing.userId;
    // Outsiders are firing's, judged at the door from the arrival's actor.
    case 'anyone':
    case 'domain':
    case 'email':
    case 'phone':
      return false;
    default:
      return neverAsAny(grantee);
  }
}

async function accessTo<T extends Thing>(
  principal: Principal,
  target: Target<T>,
  verb: AskedVerb<T>,
): Promise<boolean> {
  const floor = floorOf(verb);
  if (floor === undefined) return false;
  const teamId = await StatementStore.teamOf(target);
  if (teamId === undefined) return false;
  const standing = (await standingsIn(principal, [teamId])).get(teamId);
  if (standing === undefined) return false;
  if (floor === 'write' && standing.access !== 'write') return false;
  const grantees = await StatementStore.grantsOf(target, { teamId, verb });
  return grantees.some((grantee) => admits(grantee, standing));
}

/** The verb that lets a thing be seen in a list. */
function seenBy(thing: Thing): Verb {
  switch (thing) {
    case 'automation':
      return 'read';
    case 'connection':
      return 'use';
    default:
      return neverAsAny(thing);
  }
}

/** The ids of the things of one kind, across these teams, that the principal may see. For lists. */
async function readableIds(principal: Principal, thing: Thing, teamIds: readonly string[]): Promise<Set<string>> {
  const standings = await standingsIn(principal, teamIds);
  return StatementStore.grantedIds({
    thing,
    verb: seenBy(thing),
    teamIds: [...standings.keys()],
    userId: principal.userId,
  });
}

/** The verb whose holders may change a thing's statement. */
function changedBy(thing: Thing): AskedVerb<Thing> {
  switch (thing) {
    case 'automation':
      return 'write';
    case 'connection':
      return 'use';
    default:
      return neverAsAny(thing);
  }
}

/**
 * Whether the principal may change this thing's statement: whoever may write
 * the automation or use the connection, and only while they may write on the
 * team, since changing a statement is a write. A thing with nothing stated yet
 * is being created, so any write member may state it.
 */
async function mayChange(principal: Principal, target: Target, teamId: string): Promise<boolean> {
  const standing = (await standingsIn(principal, [teamId])).get(teamId);
  if (standing?.access !== 'write') return false;
  const verb = changedBy(target.thing);
  const stated = await StatementStore.grantsOf(target, { teamId, verb });
  if (stated.length === 0) return true;
  return accessTo<Thing>(principal, target, verb);
}

/** Whether a verb's list may name people who are not on the team. */
function admitsOutsiders(verb: Verb): boolean {
  switch (verb) {
    case 'fire':
      return true;
    case 'read':
    case 'write':
    case 'use':
      return false;
    default:
      return neverAsAny(verb);
  }
}

/** A grantee as it is stored: domains and addresses lowercased, a phone as its digits. Undefined when it names nothing. */
function normalised(grantee: Grantee): Grantee | undefined {
  const present = <G extends Grantee>(g: G, value: string): G | undefined => (value === '' ? undefined : g);
  switch (grantee.kind) {
    case 'team':
    case 'anyone':
      return grantee;
    case 'user': {
      const userId = grantee.userId.trim();
      return present({ kind: 'user', userId }, userId);
    }
    case 'domain': {
      const domain = grantee.domain.trim().toLowerCase();
      return present({ kind: 'domain', domain }, domain);
    }
    case 'email': {
      const address = grantee.address.trim().toLowerCase();
      return present({ kind: 'email', address }, address);
    }
    case 'phone': {
      const digits = grantee.digits.replace(/\D/g, '');
      return present({ kind: 'phone', digits }, digits);
    }
    default:
      return neverAsAny(grantee);
  }
}

function keyOf(grantee: Grantee): string {
  switch (grantee.kind) {
    case 'team':
    case 'anyone':
      return grantee.kind;
    case 'user':
      return `user:${grantee.userId}`;
    case 'domain':
      return `domain:${grantee.domain}`;
    case 'email':
      return `email:${grantee.address}`;
    case 'phone':
      return `phone:${grantee.digits}`;
    default:
      return neverAsAny(grantee);
  }
}

function listFor(verb: Verb, grantees: readonly Grantee[]): Grantee[] {
  const list = new Map<string, Grantee>();
  for (const given of grantees) {
    const grantee = normalised(given);
    if (grantee === undefined) {
      throw new StatementRefusedError('malformed', `A ${given.kind} on the ${verb} list must say which.`);
    }
    if (!admitsOutsiders(verb) && grantee.kind !== 'team' && grantee.kind !== 'user') {
      throw new StatementRefusedError(
        'outsider',
        `Only the team or people on it can ${verb}; a ${grantee.kind} can be given firing only.`,
      );
    }
    list.set(keyOf(grantee), grantee);
  }
  return [...list.values()];
}

/**
 * Replace one verb's whole list on one thing. A list is never emptied, every
 * user it names must be on the thing's team, and only someone who may change
 * the statement may replace it.
 */
async function setStatement<T extends Thing>(
  principal: Principal,
  target: Target<T>,
  verb: StatedVerb<T>,
  grantees: readonly Grantee[],
): Promise<void> {
  if (grantees.length === 0) {
    throw new StatementRefusedError('empty', `The ${verb} list can't be emptied: name the team, or someone on it.`);
  }
  const teamId = await StatementStore.teamOf(target);
  if (teamId === undefined) {
    throw new StatementRefusedError('not_found', `There is no such ${target.thing}.`);
  }
  if (!(await mayChange(principal, target, teamId))) {
    throw new StatementRefusedError(
      'not_allowed',
      `Only someone who may ${changedBy(target.thing)} this ${target.thing} can change who may ${verb} it.`,
    );
  }
  const list = listFor(verb, grantees);
  const named = list.flatMap((grantee) => (grantee.kind === 'user' ? [grantee.userId] : []));
  const members = await StatementStore.membersAmong(teamId, named);
  const strangers = named.filter((userId) => !members.has(userId));
  if (strangers.length > 0) {
    throw new StatementRefusedError(
      'not_a_member',
      `Only people on the team can be named on the ${verb} list; not: ${strangers.join(', ')}.`,
    );
  }
  await StatementStore.replaceGrants(target, { teamId, verb, grantees: list });
}

/**
 * Whether a list still admits someone once `leaver` is off the team. A user
 * grant admits only while its user is on the team; anything else admits
 * regardless of who is.
 */
async function stillHeld(teamId: string, grantees: readonly Grantee[], leaver: string): Promise<boolean> {
  const named: string[] = [];
  for (const grantee of grantees) {
    switch (grantee.kind) {
      case 'team':
      case 'anyone':
      case 'domain':
      case 'email':
      case 'phone':
        return true;
      case 'user':
        if (grantee.userId !== leaver) named.push(grantee.userId);
        break;
      default:
        return neverAsAny(grantee);
    }
  }
  return (await StatementStore.membersAmong(teamId, named)).size > 0;
}

/**
 * Called once a member has left a team. Every list they were the last holder
 * of passes to the team's write members, by name, so nothing is left that
 * nobody on the team can reach; to the whole team when it has no write member
 * left. Each hand on is logged.
 */
async function passOnWhatTheyHeld(input: { teamId: string; userId: string }): Promise<void> {
  const { teamId, userId } = input;
  let writers: string[] | undefined;
  for (const { target, verb } of await StatementStore.listsNaming({ teamId, userId })) {
    const grantees = await StatementStore.grantsOf(target, { teamId, verb });
    if (await stillHeld(teamId, grantees, userId)) continue;
    writers ??= (await StatementStore.writeMembersOf(teamId)).filter((writer) => writer !== userId);
    const heirs: Grantee[] =
      writers.length > 0 ? writers.map((writer) => ({ kind: 'user', userId: writer })) : [{ kind: 'team' }];
    await StatementStore.replaceGrants(target, { teamId, verb, grantees: heirs });
    logger.info('[access] a list’s last holder left the team; it passes to the team’s write members', {
      teamId,
      userId,
      thing: target.thing,
      thingId: target.id,
      verb,
      to: writers.length > 0 ? writers : 'team',
    });
  }
}

export {
  accessTo,
  readableIds,
  setStatement,
  passOnWhatTheyHeld,
  StatementRefusedError,
  type StatementRefusal,
};
