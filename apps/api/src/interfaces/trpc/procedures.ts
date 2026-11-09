// The protected tRPC procedures, in one place (core plan §4).
//
// Every router used to declare its own near-identical `userProcedure`, and the
// base tRPC context is only `{ authorise }` — identity has always arrived
// through the ambient store rather than the procedure. Three consequences the
// duplication hid, all fixed by having one of these:
//
//  - `authorise()` is a no-op over HTTP (express authenticated the request long
//    before tRPC sees it) but is the ONLY thing that establishes identity over
//    the websocket. The copies that omitted it worked over HTTP and threw
//    "Missing user" over WS.
//  - the ambient Principal is what product code reads; a procedure that runs
//    outside an express request (`createCaller` in a worker, a script, the MCP
//    caller) had none, so it is installed here from whatever identity the call
//    does have.
//  - the per-call `UserService.getById` existence check is gone: both doors
//    (the express funnel and the WS `authorise`) already refuse a user without
//    granted access, so it was a second lookup that could only ever agree.
//
// Deviation from the plan's sketch, recorded: §4 puts these in
// `packages/principal/trpc`. tRPC's `.use()` returns a DIFFERENT builder type
// than it was called on, so a `<T extends AnyTRPCBuilder>(t: T) => T` signature
// cannot be written without erasing input/output inference — the shared
// procedure has to know the app's own tRPC instance. The package keeps the
// identity contract; the tRPC binding of it lives beside the router tree.

import { maybePrincipal, runWithPrincipal, type Principal } from 'principal';

import { currentContext } from '../../services/context';
import { UserService } from '../../services/user';
import { trpc } from './trpc';

/**
 * The principal this call acts as. Ambient when an express request installed
 * one; otherwise the one parked on the Context by the caller that established
 * it outside the ambient store (the WS `authorise` above). Throws "Missing
 * user" when there is no identity at all, exactly as reading `ctx.user` did.
 */
function actingPrincipal(): Principal {
  const principal = maybePrincipal() ?? currentContext().principal;
  if (principal === undefined) {
    throw new Error('Missing user');
  }
  return principal;
}

/** A call by an authenticated user. The overwhelming majority of procedures. */
function userProcedure(procedure: typeof trpc.procedure) {
  return procedure.use(async ({ next, ctx: trpcCtx }) => {
    await trpcCtx.authorise();
    return runWithPrincipal(actingPrincipal(), () => next());
  });
}

/**
 * Platform-wide / cross-team data that must never be readable by a non-admin,
 * however innocuous the caller: the admin app's routers, `journey`, `ops`.
 */
function platformAdminProcedure(procedure: typeof trpc.procedure) {
  return procedure.use(async ({ next, ctx: trpcCtx }) => {
    await trpcCtx.authorise();
    const principal = actingPrincipal();
    if (principal.userId === undefined) {
      // A machine credential is nobody, and nobody is not a platform admin.
      throw new Error('User is not an admin');
    }

    const user = await UserService.getById(principal.userId);
    if (!user.isPlatformAdmin) {
      throw new Error('User is not an admin');
    }

    return runWithPrincipal(principal, () => next());
  });
}

export { userProcedure, platformAdminProcedure, actingPrincipal };
