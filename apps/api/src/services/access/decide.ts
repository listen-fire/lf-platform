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

type StatementRefusal =
  | 'empty'
  | 'not_found'
  | 'not_allowed'
  | 'outsider'
  | 'not_a_member'
  | 'not_a_writer'
  | 'malformed';

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

/** Whether team access `held` is at least `needed`. */
function meets(held: Access, needed: Access): boolean {
  return needed === 'read' || held === 'write';
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
  // Stored user ids are lowercase (`normalised`); compare like with like.
  const userId = principal.userId?.toLowerCase();
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

/** The team access someone needs to hold a verb through a statement: a read member never writes. */
function holderNeeds(verb: Verb): Access {
  switch (verb) {
    case 'write':
      return 'write';
    case 'read':
    case 'use':
    case 'fire':
      return 'read';
    default:
      return neverAsAny(verb);
  }
}

/**
 * The lists whose holders may do `verb`: whoever may write an automation may
 * also read it. Empty for firing, which this decision never answers.
 */
function grantedBy(verb: Verb): Verb[] {
  switch (verb) {
    case 'read':
      return ['read', 'write'];
    case 'write':
      return ['write'];
    case 'use':
      return ['use'];
    case 'fire':
      return [];
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
  asked: { target: Target<T>; verb: AskedVerb<T> },
): Promise<boolean> {
  const { target, verb } = asked;
  const lists = grantedBy(verb);
  if (lists.length === 0) return false;
  const teamId = await StatementStore.teamOf(target);
  if (teamId === undefined) return false;
  const standing = (await standingsIn(principal, [teamId])).get(teamId);
  if (standing === undefined || !meets(standing.access, holderNeeds(verb))) return false;
  for (const list of lists) {
    if (!meets(standing.access, holderNeeds(list))) continue;
    const grantees = await StatementStore.grantsOf(target, { teamId, verb: list });
    if (grantees.some((grantee) => admits(grantee, standing))) return true;
  }
  return false;
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
async function readableIds(
  principal: Principal,
  asked: { thing: Thing; teamIds: readonly string[] },
): Promise<Set<string>> {
  const { thing } = asked;
  const standings = [...(await standingsIn(principal, asked.teamIds))];
  const ids = new Set<string>();
  for (const list of grantedBy(seenBy(thing))) {
    const teamIds = standings
      .filter(([, standing]) => meets(standing.access, holderNeeds(list)))
      .map(([teamId]) => teamId);
    const userId = principal.userId?.toLowerCase();
    for (const id of await StatementStore.grantedIds({ thing, verb: list, teamIds, userId })) {
      ids.add(id);
    }
  }
  return ids;
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
 * team, since changing a statement is a write. A thing with nothing stated
 * about it at all is being created, so any write member may state it.
 */
async function mayChange(principal: Principal, target: Target, teamId: string): Promise<boolean> {
  const standing = (await standingsIn(principal, [teamId])).get(teamId);
  if (standing?.access !== 'write') return false;
  if (!(await StatementStore.hasAnyStatement(target))) return true;
  return accessTo<Thing>(principal, { target, verb: changedBy(target.thing) });
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

/**
 * A grantee as it is stored: user ids, domains and addresses lowercased, a
 * phone as its digits, so a stored value compares exactly. Undefined when it
 * names nothing.
 */
function normalised(grantee: Grantee): Grantee | undefined {
  const present = <G extends Grantee>(g: G, value: string): G | undefined => (value === '' ? undefined : g);
  switch (grantee.kind) {
    case 'team':
    case 'anyone':
      return grantee;
    case 'user': {
      const userId = grantee.userId.trim().toLowerCase();
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
 * user it names must be able to hold it (on the thing's team, and a write
 * member for the write list), and only someone who may change the statement
 * may replace it.
 */
async function setStatement<T extends Thing>(
  principal: Principal,
  stated: { target: Target<T>; verb: StatedVerb<T>; grantees: readonly Grantee[] },
): Promise<void> {
  const { target, verb, grantees } = stated;
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
  const list = await checkedList(teamId, { verb, grantees });
  await StatementStore.replaceGrants(target, { teamId, verb, grantees: list });
}

/**
 * One verb's list as it would be stored on a thing of this team: never empty,
 * every grantee well formed and of a kind the verb takes, and every user it
 * names on the team with the access the verb needs.
 */
async function checkedList(teamId: string, stated: { verb: Verb; grantees: readonly Grantee[] }): Promise<Grantee[]> {
  const { verb, grantees } = stated;
  if (grantees.length === 0) {
    throw new StatementRefusedError('empty', `The ${verb} list can't be emptied: name the team, or someone on it.`);
  }
  const list = listFor(verb, grantees);
  const named = list.flatMap((grantee) => (grantee.kind === 'user' ? [grantee.userId] : []));
  const memberships = await StatementStore.membershipsAmong(teamId, named);
  const strangers = named.filter((userId) => !memberships.has(userId));
  if (strangers.length > 0) {
    throw new StatementRefusedError(
      'not_a_member',
      `Only people on the team can be named on the ${verb} list; not: ${strangers.join(', ')}.`,
    );
  }
  const needs = holderNeeds(verb);
  const readers = named.filter((userId) => !meets(memberships.get(userId) ?? 'read', needs));
  if (readers.length > 0) {
    throw new StatementRefusedError(
      'not_a_writer',
      `Only members with write access on the team can be named on the ${verb} list; not: ${readers.join(', ')}.`,
    );
  }
  return list;
}

/** The read, write and fire lists a new automation is created with. */
type CreationStatements = Readonly<Record<StatedVerb<'automation'>, readonly Grantee[]>>;

/**
 * Whether the principal may create an automation on this team with these
 * statements, checked before anything is stored so a refusal leaves nothing
 * behind. Creating is a write on the team, and the creator must be on the
 * write list they state: the read and fire lists are stated after it, by
 * someone who may write, and nobody creates what they could not change.
 */
async function checkCreation(
  principal: Principal,
  asked: { teamId: string; statements: CreationStatements },
): Promise<void> {
  const { teamId, statements } = asked;
  const standing = (await standingsIn(principal, [teamId])).get(teamId);
  if (standing?.access !== 'write') {
    throw new StatementRefusedError('not_allowed', 'Only someone with write access on the team can create an automation.');
  }
  const write = await checkedList(teamId, { verb: 'write', grantees: statements.write });
  await checkedList(teamId, { verb: 'read', grantees: statements.read });
  await checkedList(teamId, { verb: 'fire', grantees: statements.fire });
  if (!write.some((grantee) => admits(grantee, standing))) {
    throw new StatementRefusedError(
      'not_allowed',
      "You can't create an automation you could not change: put yourself, or the team, on its write list.",
    );
  }
}

/**
 * State a just-created automation's lists: write first, while nothing is
 * stated about it, then read and fire, as someone the write list now admits.
 * `checkCreation` has passed for the same lists.
 */
async function stateCreation(
  principal: Principal,
  created: { target: Target<'automation'>; statements: CreationStatements },
): Promise<void> {
  const { target, statements } = created;
  for (const verb of ['write', 'read', 'fire'] as const) {
    await setStatement(principal, { target, verb, grantees: statements[verb] });
  }
}

/** The team's members these lists admit, as the team stands now: the people who hold any of them. */
async function membersAdmitted(
  teamId: string,
  lists: readonly { verb: Verb; grantees: readonly Grantee[] }[],
): Promise<Set<string>> {
  const members = await StatementStore.membersOf(teamId);
  const admitted = new Set<string>();
  for (const list of lists) {
    for (const [userId, access] of members) {
      if (!meets(access, holderNeeds(list.verb))) continue;
      if (list.grantees.some((grantee) => admits(grantee, { access, userId }))) admitted.add(userId);
    }
  }
  return admitted;
}

/**
 * Whether a verb's list still admits someone as the team stands now. A user
 * grant holds only while its user is on the team with the access the verb
 * needs; anything else holds regardless of who is.
 */
async function stillHeld(teamId: string, list: { verb: Verb; grantees: readonly Grantee[] }): Promise<boolean> {
  const named: string[] = [];
  for (const grantee of list.grantees) {
    switch (grantee.kind) {
      case 'team':
      case 'anyone':
      case 'domain':
      case 'email':
      case 'phone':
        return true;
      case 'user':
        named.push(grantee.userId);
        break;
      default:
        return neverAsAny(grantee);
    }
  }
  const needs = holderNeeds(list.verb);
  const memberships = await StatementStore.membershipsAmong(teamId, named);
  return [...memberships.values()].some((access) => meets(access, needs));
}

/** Why a member's standing on a team just changed. */
type StandingChange = 'left' | 'lost_write';

function reasonOf(because: StandingChange): string {
  switch (because) {
    case 'left':
      return 'left the team';
    case 'lost_write':
      return 'lost write access on the team';
    default:
      return neverAsAny(because);
  }
}

/**
 * Called once a member has left a team or lost write access on it, with their
 * membership already changed. Every list that names them and now admits nobody
 * passes to the team's write members, by name, so nothing is left that nobody
 * on the team can reach; to the whole team when it has no write member left.
 * Each hand on is logged.
 */
async function passOnWhatTheyHeld(input: {
  teamId: string;
  userId: string;
  because: StandingChange;
}): Promise<void> {
  const { teamId, because } = input;
  const userId = input.userId.toLowerCase();
  let writers: string[] | undefined;
  for (const { target, verb } of await StatementStore.listsNaming({ teamId, userId })) {
    const grantees = await StatementStore.grantsOf(target, { teamId, verb });
    if (await stillHeld(teamId, { verb, grantees })) continue;
    writers ??= (await StatementStore.writeMembersOf(teamId)).filter((writer) => writer !== userId);
    const heirs: Grantee[] =
      writers.length > 0 ? writers.map((writer) => ({ kind: 'user', userId: writer })) : [{ kind: 'team' }];
    await StatementStore.replaceGrants(target, { teamId, verb, grantees: heirs });
    logger.info(`[access] a list’s last holder ${reasonOf(because)}; it passes to the team’s write members`, {
      teamId,
      userId,
      because,
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
  checkCreation,
  stateCreation,
  membersAdmitted,
  passOnWhatTheyHeld,
  StatementRefusedError,
  type CreationStatements,
  type StatementRefusal,
  type StandingChange,
};
