// Every route that reaches an automation or a connection says which decision
// it asks (`services/access/decide.ts`), or why it asks none. The coverage
// test walks the REST tree and the tRPC tree against this registry, so a route
// mounted without saying fails it.
//
// The decision itself sits in each handler, ahead of what it reads or changes:
// a list keeps only what the caller may read and never refuses; anything named
// that the caller may not read is answered exactly as a name that does not
// exist, so a refusal never confirms the name.

import { currentPrincipal } from 'principal';
import { neverAsAny } from 'movement-engine/public/types';

import type { RequestHandler, Router } from 'express';
import type { AskedVerb, Target } from '../services/access/statement';

import { accessTo, readableIds } from '../services/access/decide';

type Decision =
  | { thing: 'automation'; verb: AskedVerb<'automation'> }
  | { thing: 'connection'; verb: AskedVerb<'connection'> }
  | { exempt: string };

/** The exemptions more than one router shares, worded once. */
const EXEMPT = {
  teamCatalog: { exempt: 'team catalog, no automation' },
  connection: { exempt: 'connection access, Task 4' },
  savedPerTarget: { exempt: 'decided per target in runSave (Task 5)' },
  ownTeams: { exempt: "the caller's own teams, no automation" },
  platformAdmin: { exempt: 'platform admins only, across teams' },
} satisfies Record<string, Decision>;

const decisions = new Map<string, Decision>();

function sameDecision(a: Decision, b: Decision): boolean {
  if ('exempt' in a || 'exempt' in b) return 'exempt' in a && 'exempt' in b && a.exempt === b.exempt;
  return a.thing === b.thing && a.verb === b.verb;
}

/** Record which decision a route asks. A route says one thing: saying another is a bug. */
function decides(route: string, decision: Decision): void {
  const known = decisions.get(route);
  if (known !== undefined && !sameDecision(known, decision)) {
    throw new Error(`${route} is registered with two different access decisions.`);
  }
  decisions.set(route, decision);
}

/** Every procedure of one tRPC router, by its name under `views`. */
function decidesEach(router: string, each: Record<string, Decision>): void {
  for (const [procedure, decision] of Object.entries(each)) decides(`views.${router}.${procedure}`, decision);
}

/** A REST route's key: its method and path. A parameter's name is not part of it (`:id` and `:requestId` are one route). */
function restRoute(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/:[A-Za-z_]\w*/g, ':')}`;
}

function registeredDecisions(): ReadonlyMap<string, Decision> {
  return decisions;
}

type Method = 'get' | 'post' | 'patch' | 'delete';

type DecidingRouter = Record<Method, (path: string, decision: Decision, handler: RequestHandler) => void>;

/** An express router whose routes each say their decision as they are mounted under `base`. */
function decidingRouter(router: Router, base: string): DecidingRouter {
  const mount = (method: Method) => (path: string, decision: Decision, handler: RequestHandler) => {
    decides(restRoute(method, `${base}${path}`), decision);
    router[method](path, handler);
  };
  return { get: mount('get'), post: mount('post'), patch: mount('patch'), delete: mount('delete') };
}

/**
 * Why a route refuses the caller an automation: they may not see it, or they
 * may see it but not change it. A route answers `unseen` exactly as it answers
 * an automation that does not exist.
 */
type Refusal = 'unseen' | 'read_only';

const READ_ONLY_MESSAGE = 'You may read this automation but not change it.';

/**
 * Whether the caller may do `verb` to this automation, and if not, why not.
 * Something that belongs to no automation has no statement; team membership,
 * which already admitted the request, decides it.
 */
async function refusalOn(asked: {
  automationId: string | null;
  verb: AskedVerb<'automation'>;
}): Promise<Refusal | undefined> {
  if (asked.automationId === null) return undefined;
  const principal = currentPrincipal();
  const target: Target<'automation'> = { thing: 'automation', id: asked.automationId };
  switch (asked.verb) {
    case 'read':
      return (await accessTo(principal, { target, verb: 'read' })) ? undefined : 'unseen';
    case 'write':
      if (await accessTo(principal, { target, verb: 'write' })) return undefined;
      return (await accessTo(principal, { target, verb: 'read' })) ? 'read_only' : 'unseen';
    default:
      return neverAsAny(asked.verb);
  }
}

/** Whether the caller may not read this automation, so a route answers as if it were missing. */
async function unseen(automationId: string | null): Promise<boolean> {
  return (await refusalOn({ automationId, verb: 'read' })) !== undefined;
}

/** The items whose automation the caller may read. An item of no automation stays. */
async function readableAmong<T>(
  items: readonly T[],
  options: { automationOf: (item: T) => string | null; teamIds: readonly string[] },
): Promise<T[]> {
  if (items.length === 0) return [];
  const readable = await readableIds(currentPrincipal(), { thing: 'automation', teamIds: options.teamIds });
  return items.filter((item) => {
    const automationId = options.automationOf(item);
    return automationId === null || readable.has(automationId);
  });
}

export {
  decides,
  decidesEach,
  decidingRouter,
  restRoute,
  registeredDecisions,
  refusalOn,
  unseen,
  readableAmong,
  EXEMPT,
  READ_ONLY_MESSAGE,
  type Decision,
  type DecidingRouter,
  type Refusal,
};
