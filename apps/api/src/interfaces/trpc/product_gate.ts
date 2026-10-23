// Which unit each tRPC view router belongs to, and the door that enforces it.
//
// The router TREE stays whole. `packages/trpc` generates one `.d.ts`
// from it for every frontend, and building the tree conditionally would make
// its type depend on an environment variable — so a process that does not run
// a product refuses that product's procedures instead of not declaring them.
// Phase 7's exports do the structural version of this: a product's repo simply
// does not contain the other products' router files, and `codegen:trpc` runs
// against the subset (8_teardown.md on `packages/trpc`).
//
// The map records only what the unit plans SETTLE. A router nobody has claimed
// is not guessed at here — it stays mounted everywhere, and claiming it is a
// Phase 7 obligation rather than a silent default.

import { TRPCError } from '@trpc/server';
import { TRPC_ERROR_CODES_BY_KEY } from '@trpc/server/rpc';

import { mounts, type Unit } from '../../products';

/** Doc-settled ownership. Absent = unclaimed, and unclaimed always mounts. */
const VIEW_ROUTER_UNITS: Readonly<Record<string, Unit | readonly Unit[]>> = {
  adapters: 'automations',
  admin: 'residual',
  apiKeys: 'core',
  connections: 'automations',
  controlTower: 'automations',
  credentials: 'automations',
  googleSheets: 'automations',
  graphExplorer: 'automations',
  // Forked, not shared (M-28): each product keeps its own shelf, so the
  // composed router serves whichever of the two is here.
  handbook: ['knowledge', 'automations'],
  home: 'automations',
  investments: 'valuations',
  journey: 'residual',
  knowledge: 'knowledge',
  movement: 'automations',
  ops: 'residual',
  plugins: 'automations',
  portfolio: 'valuations',
  remoteAdapter: 'automations',
  teamEngine: 'automations',
  teamMembers: 'core',
  // The dev loop's injection door. Never on a self-host: it fabricates inbound
  // events, so `residual` keeps it in the composed deployment only.
  testHarness: 'residual',
  triggers: 'automations',
  usage: 'residual',
  userSettings: 'core',
  webhookSubscriptions: 'automations',
};

/**
 * Is this tRPC path served here? Paths are `views.<router>.<procedure>` and
 * `models.<router>.<procedure>`; only the views tree is carved up (the models
 * tree is core's identity surface, and core is mounted wherever sessions are).
 */
function trpcPathIsMounted(path: string): boolean {
  const [tree, router] = path.split('.');
  if (tree !== 'views' || router === undefined) return true;

  const owner = VIEW_ROUTER_UNITS[router];
  if (owner === undefined) return true;

  return typeof owner === 'string' ? mounts(owner) : owner.some((unit) => mounts(unit));
}

/**
 * Why a NOT_FOUND was raised, carried as the error's `cause`. The refusals this
 * gate issues are a routine fact of the deployment's shape — the frontend asks
 * for every product's procedures and this one answers for the products it runs
 * — so the log formatter drops them to debug rather than warning on each one.
 * A class rather than a message prefix, so telling them apart is a type test
 * and not a parse of prose that someone will reword.
 */
class UnmountedProduct extends Error {
  constructor(path: string) {
    super(`This deployment does not run the product that owns ${path}.`);
    this.name = 'UnmountedProduct';
  }
}

/**
 * The HTTP door, as a middleware on the procedure rather than in front of the
 * adapter. It has to be per-procedure: a batched tRPC call names several paths
 * in one URL, and refusing at the HTTP layer refuses all of them together —
 * a page that renders one unmounted-unit component took the whole batch down
 * with it, including procedures this deployment does serve.
 *
 * Throwing here instead lets tRPC resolve each member of the batch on its own,
 * so the answer is a mounted result beside a NOT_FOUND, which is exactly what
 * the caller would meet if the router genuinely were not there.
 */
async function productGateMiddleware<TResult>(opts: {
  path: string;
  next: () => Promise<TResult>;
}): Promise<TResult> {
  if (!trpcPathIsMounted(opts.path)) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `No such procedure here: ${opts.path}. This deployment does not run that product.`,
      cause: new UnmountedProduct(opts.path),
    });
  }

  return opts.next();
}

/**
 * The websocket door. The WS transport carries the same paths in a JSON-RPC
 * frame rather than the URL, and the knowledge agents' subscriptions are the
 * live case — a browser left open against a deployment that no longer runs
 * knowledge must be refused, not quietly served.
 *
 * Returns the refusal frame to send back, or `undefined` when the message may
 * proceed. Anything unparseable proceeds: this is a product gate, not a
 * protocol validator, and tRPC's own parser answers malformed frames.
 */
function refuseUnmountedWsMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;

  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const frames = Array.isArray(message) ? message : [message];
  for (const frame of frames) {
    if (typeof frame !== 'object' || frame === null) continue;
    const { id, params } = frame as { id?: unknown; params?: unknown };
    if (typeof params !== 'object' || params === null) continue;
    const { path } = params as { path?: unknown };
    if (typeof path !== 'string' || trpcPathIsMounted(path)) continue;

    return JSON.stringify({
      id: id ?? null,
      error: {
        message: `No such procedure here: ${path}. This deployment does not run that product.`,
        code: TRPC_ERROR_CODES_BY_KEY.NOT_FOUND,
        data: { code: 'NOT_FOUND', httpStatus: 404, path },
      },
    });
  }

  return undefined;
}

export {
  VIEW_ROUTER_UNITS,
  trpcPathIsMounted,
  UnmountedProduct,
  productGateMiddleware,
  refuseUnmountedWsMessage,
};
